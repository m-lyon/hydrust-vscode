import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    CompatReporter,
    PROBE_CACHE_KEY,
    PROBE_CACHE_LIMIT,
    PROBE_TIMEOUT_MS,
    ResolvedBinary,
    ServerCompat,
} from '../../src/common/compat';
import { FEATURE_PULL_DIAGNOSTICS, FEATURE_WATCHED_FILES } from '../../src/common/compatTable';
import {
    InspectResult,
    createStubExtensionContext,
    recordedContexts,
    resetVscodeStub,
    stub,
} from '../stubs/vscode';

const SERVER_ID = 'hydrust';

/**
 * Scripts that stand in for a server binary all live in one temp directory so
 * they can be removed in one go.
 */
let scratchDir: string;

/** Anything created below that has to be cleaned up between tests. */
let context: ReturnType<typeof createStubExtensionContext>;

/** Cast the stub context to the type the production code asks for. */
function asExtensionContext(value: unknown): vscode.ExtensionContext {
    return value as vscode.ExtensionContext;
}

/**
 * Write an executable shell script into the scratch directory.
 *
 * Used to stand in for server binaries that behave in a particular way, since
 * spawn only cares that the path is executable.
 */
function writeScript(name: string, body: string): string {
    const scriptPath = path.join(scratchDir, name);
    fs.writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return scriptPath;
}

/** A plain file that is not executable, so spawning it fails immediately. */
function writeUnrunnableFile(name: string): string {
    const filePath = path.join(scratchDir, name);
    fs.writeFileSync(filePath, 'not a program', { mode: 0o644 });
    return filePath;
}

/** The fingerprint the production code builds for a path, recomputed here. */
function fingerprintOf(binaryPath: string): string {
    const stats = fs.statSync(binaryPath);
    return `${binaryPath}|${Math.round(stats.mtimeMs)}|${stats.size}`;
}

/** Whatever is currently in the probe cache. */
function probeCache(): Record<string, string | null> {
    return (stub.globalState.get(PROBE_CACHE_KEY) as Record<string, string | null>) ?? {};
}

/** Build a `ResolvedBinary` without repeating the boilerplate. */
function binary(binaryPath: string, overrides: Partial<ResolvedBinary> = {}): ResolvedBinary {
    return { path: binaryPath, source: 'environment', ...overrides };
}

/**
 * Tell the configuration stub that a setting is at its default.
 *
 * `findConfiguredSettings` only reports settings the user changed, so this is
 * the "nothing to see here" case.
 */
function settingAtDefault(key: string, defaultValue: unknown): InspectResult {
    return { key: `${SERVER_ID}.${key}`, defaultValue };
}

/** Tell the configuration stub that the user set a setting explicitly. */
function settingChanged(key: string, defaultValue: unknown, value: unknown, scope = 'globalValue'): InspectResult {
    return { key: `${SERVER_ID}.${key}`, defaultValue, [scope]: value };
}

/** Load a set of inspect results into the configuration stub. */
function configure(...results: InspectResult[]): void {
    for (const result of results) {
        stub.configInspect.set(result.key.replace(`${SERVER_ID}.`, ''), result);
    }
}

/** A minimal InitializeResult, with only the bits the compat layer reads. */
function initializeResult(options: {
    version?: string;
    hydrust?: unknown;
    diagnosticProvider?: unknown;
} = {}): unknown {
    const capabilities: Record<string, unknown> = {};
    if (options.hydrust !== undefined) {
        capabilities.experimental = { hydrust: options.hydrust };
    }
    if (options.diagnosticProvider !== undefined) {
        capabilities.diagnosticProvider = options.diagnosticProvider;
    }
    return {
        capabilities,
        serverInfo: options.version ? { name: 'hydra-lsp', version: options.version } : undefined,
    };
}

/** Build a reporter for the server id these tests use. */
function makeReporter(): CompatReporter {
    return new CompatReporter(SERVER_ID);
}

beforeEach(() => {
    resetVscodeStub();
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydrust-compat-'));
    context = createStubExtensionContext(scratchDir);
});

afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
});

describe('the --version probe', () => {
    it('keeps its production timeout at two seconds', () => {
        // The tests below shorten this on purpose. If the default ever moves,
        // that should be a deliberate decision rather than a side effect.
        expect(PROBE_TIMEOUT_MS).toBe(2000);
    });

    it.skipIf(process.platform === 'win32')('reads the version a v0.4.0 server prints', async () => {
        const script = writeScript('good-server', "echo 'hydra-lsp 0.4.0'");

        const compat = await ServerCompat.beforeLaunch(
            binary(script),
            SERVER_ID,
            [],
            undefined,
            asExtensionContext(context)
        );

        expect(compat.versionLabel).toBe('v0.4.0');
        expect(probeCache()[fingerprintOf(script)]).toBe('v0.4.0');
    });

    it.skipIf(process.platform === 'win32')(
        'gives up on a binary that hangs, kills it, and calls the version unknown',
        async () => {
            // An old server ignores --version and starts its stdio LSP loop, so
            // it prints nothing and never exits. `exec` means SIGKILL lands on
            // the sleeping process itself rather than a shell wrapper.
            const script = writeScript('hanging-server', 'exec sleep 30');

            const started = Date.now();
            const compat = await ServerCompat.beforeLaunch(
                binary(script),
                SERVER_ID,
                [],
                undefined,
                asExtensionContext(context),
                // Shortened from the production 2000ms so the suite stays fast.
                75
            );
            const elapsed = Date.now() - started;

            expect(compat.versionLabel).toBe('unknown version');
            // Comfortably under the real sleep, so the child really was killed
            // rather than allowed to finish.
            expect(elapsed).toBeLessThan(2000);
            expect(probeCache()[fingerprintOf(script)]).toBeNull();
        }
    );

    it.skipIf(process.platform === 'win32')('treats output with no version in it as unknown', async () => {
        const script = writeScript('chatty-server', "echo 'unrecognised option --version'");

        const compat = await ServerCompat.beforeLaunch(
            binary(script),
            SERVER_ID,
            [],
            undefined,
            asExtensionContext(context)
        );

        expect(compat.versionLabel).toBe('unknown version');
        expect(probeCache()[fingerprintOf(script)]).toBeNull();
    });

    it('does not spawn anything when the resolution path already knows the tag', async () => {
        // The bundled path downloads a known release, so there is nothing to ask.
        const missing = path.join(scratchDir, 'never-created');

        const compat = await ServerCompat.beforeLaunch(
            binary(missing, { source: 'bundled', version: 'v0.3.0' }),
            SERVER_ID,
            [],
            undefined,
            asExtensionContext(context)
        );

        expect(compat.versionLabel).toBe('v0.3.0');
        expect(probeCache()).toEqual({});
    });
});

describe('the probe cache', () => {
    it.skipIf(process.platform === 'win32')('short-circuits on a remembered null without re-spawning', async () => {
        const script = writeScript('hanging-server', 'exec sleep 30');
        stub.globalState.set(PROBE_CACHE_KEY, { [fingerprintOf(script)]: null });

        const started = Date.now();
        const compat = await ServerCompat.beforeLaunch(
            binary(script),
            SERVER_ID,
            [],
            undefined,
            asExtensionContext(context),
            // Deliberately longer than the test would tolerate. Reaching the
            // spawn at all would blow the timeout, so returning quickly is the
            // proof that the cache was used.
            30000
        );

        expect(compat.versionLabel).toBe('unknown version');
        expect(Date.now() - started).toBeLessThan(1000);
    });

    it('reuses a remembered version instead of asking again', async () => {
        // A file that could never answer: if the version comes back anyway, it
        // can only have come from the cache.
        const file = writeUnrunnableFile('opaque-server');
        stub.globalState.set(PROBE_CACHE_KEY, { [fingerprintOf(file)]: 'v0.2.0' });

        const compat = await ServerCompat.beforeLaunch(
            binary(file),
            SERVER_ID,
            [],
            undefined,
            asExtensionContext(context)
        );

        expect(compat.versionLabel).toBe('v0.2.0');
    });

    it('ignores a remembered value that no longer parses', async () => {
        const file = writeUnrunnableFile('opaque-server');
        stub.globalState.set(PROBE_CACHE_KEY, { [fingerprintOf(file)]: 'corrupted' });

        const compat = await ServerCompat.beforeLaunch(
            binary(file),
            SERVER_ID,
            [],
            undefined,
            asExtensionContext(context)
        );

        // Falls through to a real probe, which fails, so the entry is replaced.
        expect(compat.versionLabel).toBe('unknown version');
        expect(probeCache()[fingerprintOf(file)]).toBeNull();
    });

    it('keeps entries for other binaries when it writes a new one', async () => {
        const file = writeUnrunnableFile('opaque-server');
        stub.globalState.set(PROBE_CACHE_KEY, { '/somewhere/else|1|2': 'v0.1.0' });

        await ServerCompat.beforeLaunch(binary(file), SERVER_ID, [], undefined, asExtensionContext(context));

        expect(probeCache()['/somewhere/else|1|2']).toBe('v0.1.0');
        expect(probeCache()[fingerprintOf(file)]).toBeNull();
    });

    it('drops the oldest entries once it is full', async () => {
        // Every upgrade of the binary makes a new fingerprint, so without a cap
        // the cache would keep one dead entry per upgrade forever.
        const seeded: Record<string, string | null> = {};
        for (let index = 0; index < PROBE_CACHE_LIMIT; index += 1) {
            seeded[`/old/binary-${index}|1|2`] = 'v0.1.0';
        }
        stub.globalState.set(PROBE_CACHE_KEY, seeded);

        const file = writeUnrunnableFile('opaque-server');
        await ServerCompat.beforeLaunch(binary(file), SERVER_ID, [], undefined, asExtensionContext(context));

        const cache = probeCache();
        expect(Object.keys(cache)).toHaveLength(PROBE_CACHE_LIMIT);
        expect(cache['/old/binary-0|1|2']).toBeUndefined();
        expect(cache[`/old/binary-${PROBE_CACHE_LIMIT - 1}|1|2`]).toBe('v0.1.0');
        expect(cache[fingerprintOf(file)]).toBeNull();
    });

    it('keeps a binary that is still in use out of the way of the cap', async () => {
        // The daily driver is the oldest entry by write time, so a cache that
        // only reordered on writes would drop it and re-probe on the next
        // launch. Reading it has to count as using it.
        const file = writeUnrunnableFile('opaque-server');
        const seeded: Record<string, string | null> = { [fingerprintOf(file)]: 'v0.3.0' };
        for (let index = 0; index < PROBE_CACHE_LIMIT - 1; index += 1) {
            seeded[`/old/binary-${index}|1|2`] = 'v0.1.0';
        }
        stub.globalState.set(PROBE_CACHE_KEY, seeded);

        // Use the old binary, then fill the last free slot with a new one.
        await ServerCompat.beforeLaunch(binary(file), SERVER_ID, [], undefined, asExtensionContext(context));
        const newcomer = writeUnrunnableFile('newcomer-server');
        await ServerCompat.beforeLaunch(binary(newcomer), SERVER_ID, [], undefined, asExtensionContext(context));

        const cache = probeCache();
        expect(Object.keys(cache)).toHaveLength(PROBE_CACHE_LIMIT);
        expect(cache[fingerprintOf(file)]).toBe('v0.3.0');
        expect(cache['/old/binary-0|1|2']).toBeUndefined();
    });

    it('refreshes an existing entry rather than adding a second one', async () => {
        const file = writeUnrunnableFile('opaque-server');
        stub.globalState.set(PROBE_CACHE_KEY, { [fingerprintOf(file)]: 'corrupted' });

        await ServerCompat.beforeLaunch(binary(file), SERVER_ID, [], undefined, asExtensionContext(context));

        expect(Object.keys(probeCache())).toEqual([fingerprintOf(file)]);
    });
});

describe('afterLaunch writing the real version back to the cache', () => {
    it('replaces a remembered null with what the server said about itself', async () => {
        // This is the mechanism that lets a wrong first-launch payload fix
        // itself on the next launch. Without it, a binary with no --version
        // flag is stuck as "unknown" forever and the payload stays wrong with
        // nothing to show for it.
        const file = writeUnrunnableFile('silent-server');
        const fingerprint = fingerprintOf(file);

        const first = await ServerCompat.beforeLaunch(
            binary(file),
            SERVER_ID,
            [],
            undefined,
            asExtensionContext(context)
        );
        expect(first.versionLabel).toBe('unknown version');
        expect(probeCache()[fingerprint]).toBeNull();

        await first.afterLaunch(initializeResult({ version: '0.2.0' }), asExtensionContext(context));

        expect(first.versionLabel).toBe('v0.2.0');
        expect(probeCache()[fingerprint]).toBe('v0.2.0');
    });

    it('makes the very next launch send the right payload', async () => {
        const file = writeUnrunnableFile('silent-server');

        const first = await ServerCompat.beforeLaunch(
            binary(file),
            SERVER_ID,
            ['invalid-hydra-parameter'],
            undefined,
            asExtensionContext(context)
        );
        // Nothing is rewritten while the version is unknown, so the first
        // launch sends the modern spelling to a v0.2.0 server that will drop it.
        expect(first.transformSettings({ disabledRules: ['invalid-hydra-parameter'] })).toEqual({
            disabledRules: ['invalid-hydra-parameter'],
        });

        await first.afterLaunch(initializeResult({ version: '0.2.0' }), asExtensionContext(context));

        const second = await ServerCompat.beforeLaunch(
            binary(file),
            SERVER_ID,
            ['invalid-hydra-parameter'],
            undefined,
            asExtensionContext(context)
        );
        expect(second.versionLabel).toBe('v0.2.0');
        expect(second.transformSettings({ disabledRules: ['invalid-hydra-parameter'] })).toEqual({
            disabledRules: ['invalid-target'],
        });
    });

    it('overwrites a remembered version that turned out to be wrong', async () => {
        const file = writeUnrunnableFile('silent-server');
        const fingerprint = fingerprintOf(file);
        stub.globalState.set(PROBE_CACHE_KEY, { [fingerprint]: 'v0.1.0' });

        const compat = await ServerCompat.beforeLaunch(
            binary(file),
            SERVER_ID,
            [],
            undefined,
            asExtensionContext(context)
        );
        expect(compat.versionLabel).toBe('v0.1.0');

        await compat.afterLaunch(initializeResult({ version: '0.4.0' }), asExtensionContext(context));

        expect(compat.versionLabel).toBe('v0.4.0');
        expect(probeCache()[fingerprint]).toBe('v0.4.0');
    });

    it('leaves the cache alone when the server did not name a version', async () => {
        const file = writeUnrunnableFile('silent-server');
        const fingerprint = fingerprintOf(file);
        stub.globalState.set(PROBE_CACHE_KEY, { [fingerprint]: 'v0.3.0' });

        const compat = await ServerCompat.beforeLaunch(
            binary(file),
            SERVER_ID,
            [],
            undefined,
            asExtensionContext(context)
        );
        await compat.afterLaunch({ capabilities: {} }, asExtensionContext(context));

        expect(probeCache()[fingerprint]).toBe('v0.3.0');
        expect(compat.versionLabel).toBe('v0.3.0');
    });

    it('takes the capability block as the last word on what is supported', async () => {
        configure(settingChanged('numThreads', 0, 8));
        const file = writeUnrunnableFile('silent-server');

        const compat = await ServerCompat.beforeLaunch(
            binary(file),
            SERVER_ID,
            [],
            undefined,
            asExtensionContext(context)
        );
        // With no version, the table assumes v0.3.0, which does not read numThreads.
        expect(compat.unsupportedSettings.map((entry) => entry.name)).toEqual(['numThreads']);

        await compat.afterLaunch(
            initializeResult({
                version: '0.4.0',
                hydrust: { protocolVersion: 1, supportedSettings: ['numThreads'], supportedRules: [], features: [] },
            }),
            asExtensionContext(context)
        );

        expect(compat.unsupportedSettings).toEqual([]);
        expect(compat.features[FEATURE_PULL_DIAGNOSTICS]).toBe(false);
    });
});

describe('which settings count as configured', () => {
    it('reports only settings moved away from their default', async () => {
        configure(
            settingAtDefault('pythonInterpreterPath', ''),
            settingAtDefault('enableHover', true),
            // Explicitly set, but to the same value as the default. The user
            // has not really asked for anything, so this is not worth a warning.
            settingChanged('enableCompletion', true, true),
            settingChanged('numThreads', 0, 8),
            settingChanged('disabledRules', [], ['missing-argument'], 'workspaceValue')
        );
        const file = writeUnrunnableFile('silent-server');

        const compat = await ServerCompat.beforeLaunch(
            binary(file),
            SERVER_ID,
            [],
            undefined,
            asExtensionContext(context)
        );

        // Assumed v0.3.0: disabledRules is fine there, numThreads is not.
        expect(compat.unsupportedSettings.map((entry) => entry.name)).toEqual(['numThreads']);
    });

    it('stays silent about an unsupported setting the user never touched', async () => {
        // Every setting present but untouched, including one the assumed
        // v0.3.0 server cannot read. Nothing here is the user's problem.
        configure(
            settingAtDefault('pythonInterpreterPath', ''),
            settingAtDefault('disabledRules', []),
            settingAtDefault('enableHover', true),
            settingAtDefault('enableCompletion', true),
            settingAtDefault('enableSignatureHelp', true),
            settingAtDefault('enableGotoDefinition', true),
            settingAtDefault('enableSemanticTokens', true),
            settingAtDefault('enableDiagnostics', true),
            settingAtDefault('numThreads', 0)
        );
        const file = writeUnrunnableFile('silent-server');

        const compat = await ServerCompat.beforeLaunch(
            binary(file),
            SERVER_ID,
            [],
            undefined,
            asExtensionContext(context)
        );

        expect(compat.unsupportedSettings).toEqual([]);
    });

    it('looks at every configuration scope, not just the global one', async () => {
        configure(settingChanged('numThreads', 0, 4, 'workspaceFolderValue'));
        const file = writeUnrunnableFile('silent-server');

        const compat = await ServerCompat.beforeLaunch(
            binary(file),
            SERVER_ID,
            [],
            undefined,
            asExtensionContext(context)
        );

        expect(compat.unsupportedSettings.map((entry) => entry.name)).toEqual(['numThreads']);
    });

    it('follows the scope precedence when two scopes disagree', async () => {
        // User settings leave numThreads at the default, the workspace changes
        // it. The workspace wins, so the user does need telling.
        configure({ key: `${SERVER_ID}.numThreads`, defaultValue: 0, globalValue: 0, workspaceValue: 8 });
        const file = writeUnrunnableFile('silent-server');

        const compat = await ServerCompat.beforeLaunch(
            binary(file),
            SERVER_ID,
            [],
            undefined,
            asExtensionContext(context)
        );

        expect(compat.unsupportedSettings.map((entry) => entry.name)).toEqual(['numThreads']);
    });

    it('says nothing when the winning scope puts the value back to the default', async () => {
        // The other way round: the workspace overrides the user's 8 with the
        // default, so the server is sent the default and there is nothing to warn about.
        configure({ key: `${SERVER_ID}.numThreads`, defaultValue: 0, globalValue: 8, workspaceValue: 0 });
        const file = writeUnrunnableFile('silent-server');

        const compat = await ServerCompat.beforeLaunch(
            binary(file),
            SERVER_ID,
            [],
            undefined,
            asExtensionContext(context)
        );

        expect(compat.unsupportedSettings).toEqual([]);
    });

    it('compares structured values by content rather than by identity', async () => {
        // An array set to a value equal to the default is still "unchanged",
        // even though it is a different object.
        configure(settingChanged('disabledRules', [], []));
        const file = writeUnrunnableFile('silent-server');

        const compat = await ServerCompat.beforeLaunch(
            binary(file),
            SERVER_ID,
            [],
            undefined,
            asExtensionContext(context)
        );
        await compat.afterLaunch(initializeResult({ version: '0.1.0' }), asExtensionContext(context));

        // v0.1.0 does not read disabledRules at all, but the user did not
        // actually set it, so there is nothing to complain about.
        expect(compat.unsupportedSettings).toEqual([]);
    });

    it('asks for the configuration scoped to the project root', async () => {
        const file = writeUnrunnableFile('silent-server');

        await ServerCompat.beforeLaunch(
            binary(file),
            SERVER_ID,
            [],
            '/some/project',
            asExtensionContext(context)
        );

        expect(stub.configurationRequests).toContainEqual({ section: SERVER_ID, resource: '/some/project' });
    });
});

describe('what the user is told about an unsupported setting', () => {
    /** Build a compat object that has something to complain about. */
    async function compatWithComplaints(version = '0.3.0', rules: string[] = []): Promise<ServerCompat> {
        configure(settingChanged('numThreads', 0, 8), settingChanged('disabledRules', [], rules));
        const file = writeUnrunnableFile(`server-${Math.random()}`);
        const compat = await ServerCompat.beforeLaunch(
            binary(file),
            SERVER_ID,
            rules,
            undefined,
            asExtensionContext(context)
        );
        await compat.afterLaunch(initializeResult({ version }), asExtensionContext(context));
        return compat;
    }

    it('writes every ignored setting and rule to the log', async () => {
        await compatWithComplaints('0.3.0', ['not-a-rule']);

        const warnings = stub.logs.filter((line) => line.startsWith('warn:'));
        expect(warnings.some((line) => line.includes('hydrust.numThreads'))).toBe(true);
        expect(warnings.some((line) => line.includes('not-a-rule'))).toBe(true);
    });

    it('never interrupts the user, however much the server ignores', async () => {
        const compat = await compatWithComplaints('0.3.0', ['not-a-rule']);
        await makeReporter().update(compat);

        expect(stub.messages).toEqual([]);
        expect(stub.statusBarItems).toEqual([]);
    });

    it('says nothing at all when the server supports everything the user configured', async () => {
        configure(settingChanged('numThreads', 0, 8));
        const file = writeUnrunnableFile('silent-server');
        const compat = await ServerCompat.beforeLaunch(
            binary(file),
            SERVER_ID,
            [],
            undefined,
            asExtensionContext(context)
        );
        await compat.afterLaunch(initializeResult({ version: '0.4.0' }), asExtensionContext(context));

        await makeReporter().update(compat);

        expect(stub.messages).toEqual([]);
        expect(stub.logs.some((line) => line.includes('numThreads'))).toBe(false);
    });

    it('returns promptly, so a restart is never held up by the reporter', async () => {
        // extension.ts serialises restarts around this call, so anything that
        // waits on the user here would stall the whole extension. That was a
        // real bug once, back when this showed a notification.
        const compat = await compatWithComplaints();
        const reporter = makeReporter();

        const outcome = await Promise.race([
            reporter.update(compat).then(() => 'returned' as const),
            new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 250)),
        ]);

        expect(outcome).toBe('returned');
    });
});

describe('the setContext keys', () => {
    /** Build a compat object reporting exactly the given feature names. */
    async function compatWithFeatures(features: string[]): Promise<ServerCompat> {
        const file = writeUnrunnableFile(`server-${Math.random()}`);
        const compat = await ServerCompat.beforeLaunch(
            binary(file),
            SERVER_ID,
            [],
            undefined,
            asExtensionContext(context)
        );
        await compat.afterLaunch(
            initializeResult({
                version: '0.4.0',
                hydrust: { protocolVersion: 1, supportedSettings: [], supportedRules: [], features },
            }),
            asExtensionContext(context)
        );
        return compat;
    }

    it('publishes every known feature, on or off', async () => {
        await makeReporter().update(await compatWithFeatures([FEATURE_WATCHED_FILES]));

        const contexts = recordedContexts();
        expect(contexts.get('hydrust.supports.watchedFiles')).toBe(true);
        expect(contexts.get('hydrust.supports.pullDiagnostics')).toBe(false);
        expect(contexts.get('hydrust.supports.diagnosticRefresh')).toBe(false);
    });

    it('publishes feature names the extension has never heard of', async () => {
        await makeReporter().update(await compatWithFeatures(['inlayHints']));

        expect(recordedContexts().get('hydrust.supports.inlayHints')).toBe(true);
    });

    it('clears a key from a previous server rather than leaving it stale', async () => {
        const reporter = makeReporter();
        await reporter.update(await compatWithFeatures(['inlayHints', FEATURE_WATCHED_FILES]));
        expect(recordedContexts().get('hydrust.supports.inlayHints')).toBe(true);

        // Restart onto an older server that knows nothing about inlay hints.
        await reporter.update(await compatWithFeatures([]));

        const contexts = recordedContexts();
        expect(contexts.get('hydrust.supports.inlayHints')).toBe(false);
        expect(contexts.get('hydrust.supports.watchedFiles')).toBe(false);
    });

    it('turns every key off when the server stops', async () => {
        const reporter = makeReporter();
        await reporter.update(await compatWithFeatures([FEATURE_PULL_DIAGNOSTICS, 'inlayHints']));

        await reporter.update(undefined);

        const contexts = recordedContexts();
        expect(contexts.get('hydrust.supports.pullDiagnostics')).toBe(false);
        expect(contexts.get('hydrust.supports.inlayHints')).toBe(false);
    });
});

describe('describe()', () => {
    it('says where the binary came from and what it can do', async () => {
        configure(settingChanged('numThreads', 0, 8));
        const file = writeUnrunnableFile('silent-server');
        const compat = await ServerCompat.beforeLaunch(
            binary(file, { source: 'serverPath' }),
            SERVER_ID,
            ['not-a-rule'],
            undefined,
            asExtensionContext(context)
        );
        await compat.afterLaunch(initializeResult({ version: '0.3.0' }), asExtensionContext(context));

        const lines = compat.describe().join('\n');
        expect(lines).toContain('Version: v0.3.0');
        expect(lines).toContain(file);
        expect(lines).toContain('hydrust.serverPath setting');
        expect(lines).toContain('built-in version table');
        expect(lines).toContain('hydrust.numThreads');
        expect(lines).toContain('not-a-rule');
    });

    it('says so plainly when the server described itself', async () => {
        const file = writeUnrunnableFile('silent-server');
        const compat = await ServerCompat.beforeLaunch(
            binary(file),
            SERVER_ID,
            [],
            undefined,
            asExtensionContext(context)
        );
        await compat.afterLaunch(
            initializeResult({
                version: '0.4.0',
                hydrust: { protocolVersion: 1, supportedSettings: [], supportedRules: [], features: [] },
            }),
            asExtensionContext(context)
        );

        const lines = compat.describe().join('\n');
        expect(lines).toContain('reported by the server');
        expect(lines).toContain('All configured settings are supported by this server.');
    });
});

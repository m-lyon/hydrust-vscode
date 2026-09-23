/**
 * Tests for the orchestration in startServer.
 *
 * The pure pieces it leans on (the compatibility table, the settings payload)
 * have their own suites. What is checked here is the wiring: that the payload
 * really is adjusted for the server being launched before it is handed to the
 * client, that the project root reaches the compatibility check, and that a
 * failure after launch does not lose the client handle.
 *
 * `vscode-languageclient/node` only works inside an extension host, so it is
 * replaced with a recording stub in the same spirit as test/stubs/vscode.ts.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

/** One `new LanguageClient(...)`, with everything it was handed. */
interface RecordedClient {
    serverId: string;
    serverName: string;
    serverOptions: { run: { command: string; args: string[] } };
    clientOptions: { initializationOptions: { settings: Record<string, unknown> } };
    started: boolean;
}

/**
 * Shared state between the test and the module mock.
 *
 * `vi.hoisted` runs before the mock factory, which itself runs before the
 * imports, so this is the only way for the two to see the same object.
 */
const clientStub = vi.hoisted(() => ({
    /** Every client constructed, oldest first. */
    clients: [] as RecordedClient[],
    /** What `client.initializeResult` hands back after start(). */
    initializeResult: undefined as unknown,
    /** When set, `client.start()` rejects with this. */
    startError: undefined as Error | undefined,
    /** Listeners registered through `client.onDidChangeState`, oldest first. */
    stateListeners: [] as ((event: { oldState: number; newState: number }) => void)[],
}));

const downloadStub = vi.hoisted(() => ({
    ensureError: undefined as Error | undefined,
    existing: undefined as { path: string; version: string } | undefined,
    scans: 0,
}));

/** What `which` finds on PATH, by name. Anything missing is not on PATH. */
const whichStub = vi.hoisted(() => ({ paths: {} as Record<string, string> }));

vi.mock('which', () => ({
    default: async (name: string) => whichStub.paths[name] ?? null,
}));

/**
 * What each Python interpreter reports as its hydrust binary. An interpreter
 * that is not listed has no hydrust installed, which is every interpreter the
 * older tests use, so they resolve exactly as they did before the lookup
 * existed. An Error is thrown from the lookup.
 */
const pythonStub = vi.hoisted(() => ({
    binaries: {} as Record<string, string | Error>,
    lookups: [] as string[],
}));

vi.mock('../../src/common/pythonEnvironment', () => ({
    findHydrustInInterpreter: async (interpreter: string) => {
        pythonStub.lookups.push(interpreter);
        const answer = pythonStub.binaries[interpreter];
        if (answer instanceof Error) {
            throw answer;
        }
        return answer;
    },
}));

vi.mock('../../src/common/download', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/common/download')>();
    return {
        ...actual,
        ensureServer: async (...args: Parameters<typeof actual.ensureServer>) => {
            if (downloadStub.ensureError) {
                throw downloadStub.ensureError;
            }
            return actual.ensureServer(...args);
        },
        findExistingExecutable: async () => {
            downloadStub.scans++;
            return downloadStub.existing;
        },
    };
});

vi.mock('vscode-languageclient/node', () => {
    class LanguageClient {
        private readonly record: RecordedClient;

        constructor(
            serverId: string,
            serverName: string,
            serverOptions: RecordedClient['serverOptions'],
            clientOptions: RecordedClient['clientOptions']
        ) {
            this.record = { serverId, serverName, serverOptions, clientOptions, started: false };
            clientStub.clients.push(this.record);
        }

        get initializeResult(): unknown {
            return clientStub.initializeResult;
        }

        async start(): Promise<void> {
            if (clientStub.startError) {
                throw clientStub.startError;
            }
            this.record.started = true;
        }

        async stop(): Promise<void> {
            // Nothing to tear down.
        }

        onDidChangeState(listener: (event: { oldState: number; newState: number }) => void): { dispose(): void } {
            clientStub.stateListeners.push(listener);
            return { dispose() {} };
        }
    }

    return { LanguageClient, State: { Stopped: 1, Starting: 3, Running: 2 } };
});

import { forgetInterpreterLookups, startServer } from '../../src/common/server';
import { PROBE_CACHE_KEY } from '../../src/common/compat';
import { getVersionedDir } from '../../src/common/constants';
import { versionLastUsedKey } from '../../src/common/download';
import { ExtensionSettings } from '../../src/common/settings';
import { createStubExtensionContext, resetVscodeStub, stub } from '../stubs/vscode';

const SERVER_ID = 'hydrust';
const SERVER_NAME = 'Hydrust';

/** Keeps a `--version` probe that cannot be answered from stalling a test. */
const PROBE_TIMEOUT_MS = 500;

let scratchDir: string;
let context: ReturnType<typeof createStubExtensionContext>;
let outputChannel: vscode.OutputChannel;

/** Cast the stub context to the type the production code asks for. */
function asExtensionContext(value: unknown): vscode.ExtensionContext {
    return value as vscode.ExtensionContext;
}

/**
 * Write a stand-in for the server binary.
 *
 * It is never executed: pointing `serverPath` at it takes the first resolution
 * branch, and the version comes from the probe cache seeded below.
 */
function writeBinary(name = 'hydra-lsp'): string {
    const binaryPath = path.join(scratchDir, name);
    fs.writeFileSync(binaryPath, 'not a program', { mode: 0o644 });
    return binaryPath;
}

/** Tell the probe cache what version a binary is, so nothing is spawned. */
function rememberVersion(binaryPath: string, version: string): void {
    rememberVersions({ [binaryPath]: version });
}

/** Like rememberVersion, for several binaries at once. */
function rememberVersions(versions: Record<string, string | null>): void {
    const entries: Record<string, string | null> = {};
    for (const [binaryPath, version] of Object.entries(versions)) {
        const stats = fs.statSync(binaryPath);
        entries[`${binaryPath}|${Math.round(stats.mtimeMs)}|${stats.size}`] = version;
    }
    stub.globalState.set(PROBE_CACHE_KEY, entries);
}

/** Settings with everything at its default, bar the overrides given. */
function settingsFor(binaryPath: string, overrides: Partial<ExtensionSettings> = {}): ExtensionSettings {
    return {
        path: binaryPath,
        interpreter: '/usr/bin/python3',
        importStrategy: 'fromEnvironment',
        serverVersion: 'latest',
        traceServer: 'off',
        disabledRules: [],
        enableHover: true,
        enableCompletion: true,
        enableSignatureHelp: true,
        enableGotoDefinition: true,
        enableSemanticTokens: true,
        enableDiagnostics: true,
        numThreads: 0,
        developerMode: false,
        ...overrides,
    };
}

/** Start the server against a stubbed client and hand back what it built. */
function start(settings: ExtensionSettings, projectRoot?: string) {
    return startServer(
        settings,
        SERVER_ID,
        SERVER_NAME,
        outputChannel,
        outputChannel,
        asExtensionContext(context),
        projectRoot,
        PROBE_TIMEOUT_MS
    );
}

/** An InitializeResult with only the parts the compatibility layer reads. */
function initializeResult(version: string): unknown {
    return { capabilities: {}, serverInfo: { name: 'hydra-lsp', version } };
}

beforeEach(() => {
    resetVscodeStub();
    clientStub.clients = [];
    clientStub.initializeResult = initializeResult('0.4.0');
    clientStub.startError = undefined;
    clientStub.stateListeners = [];
    downloadStub.ensureError = undefined;
    downloadStub.existing = undefined;
    downloadStub.scans = 0;
    whichStub.paths = {};
    pythonStub.binaries = {};
    pythonStub.lookups = [];
    forgetInterpreterLookups();
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydrust-server-'));
    context = createStubExtensionContext(scratchDir);
    outputChannel = { name: 'test' } as unknown as vscode.OutputChannel;
});

afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(scratchDir, { recursive: true, force: true });
});

describe('the payload handed to the language client', () => {
    it('carries the settings the server is meant to read', async () => {
        const binaryPath = writeBinary();
        rememberVersion(binaryPath, 'v0.4.0');

        await start(settingsFor(binaryPath, { numThreads: 6 }));

        const client = clientStub.clients[0];
        expect(client.serverId).toBe(SERVER_ID);
        expect(client.serverName).toBe(SERVER_NAME);
        expect(client.serverOptions.run.command).toBe(binaryPath);
        // The subcommand goes on unconditionally, even for a v0.4.0 server
        // that predates it and simply ignores it.
        expect(client.serverOptions.run.args).toEqual(['server']);
        expect(client.clientOptions.initializationOptions.settings).toEqual({
            pythonInterpreter: '/usr/bin/python3',
            disabledRules: [],
            enableHover: true,
            enableCompletion: true,
            enableSignatureHelp: true,
            enableGotoDefinition: true,
            enableSemanticTokens: true,
            enableDiagnostics: true,
            numThreads: 6,
        });
    });

    it('renames a rule an older server spells differently before sending it', async () => {
        // v0.2.0 calls this rule 'invalid-target'. Sending the modern spelling
        // would leave the rule enabled with nothing to show for it.
        const binaryPath = writeBinary();
        rememberVersion(binaryPath, 'v0.2.0');
        clientStub.initializeResult = initializeResult('0.2.0');

        await start(settingsFor(binaryPath, { disabledRules: ['invalid-hydra-parameter', 'missing-argument'] }));

        const settings = clientStub.clients[0].clientOptions.initializationOptions.settings;
        expect(settings.disabledRules).toEqual(['invalid-target', 'missing-argument']);
    });

    it('sends the modern spelling to a server that uses it', async () => {
        const binaryPath = writeBinary();
        rememberVersion(binaryPath, 'v0.4.0');

        await start(settingsFor(binaryPath, { disabledRules: ['invalid-hydra-parameter'] }));

        const settings = clientStub.clients[0].clientOptions.initializationOptions.settings;
        expect(settings.disabledRules).toEqual(['invalid-hydra-parameter']);
    });
});

describe('what startServer tells the compatibility check', () => {
    it('scopes the configuration lookup to the project root', async () => {
        const binaryPath = writeBinary();
        rememberVersion(binaryPath, 'v0.4.0');

        await start(settingsFor(binaryPath), '/some/project');

        expect(stub.configurationRequests).toContainEqual({ section: SERVER_ID, resource: '/some/project' });
    });

    it('asks about the whole window when there is no project root', async () => {
        const binaryPath = writeBinary();
        rememberVersion(binaryPath, 'v0.4.0');

        await start(settingsFor(binaryPath));

        expect(stub.configurationRequests).toContainEqual({ section: SERVER_ID, resource: undefined });
    });
});

describe('failures around the launch', () => {
    it('still returns the client when the post-launch check throws', async () => {
        // The client is already running by this point, so throwing here would
        // orphan it: the caller only gets a handle to stop it if this returns.
        const binaryPath = writeBinary();
        rememberVersion(binaryPath, 'v0.4.0');
        clientStub.initializeResult = {
            get capabilities(): never {
                throw new Error('malformed InitializeResult');
            },
        };

        const started = await start(settingsFor(binaryPath));

        expect(started.client).toBeDefined();
        expect(started.compat).toBeDefined();
        expect(stub.logs.some((line) => line.startsWith('warn:') && line.includes('what the running server supports')))
            .toBe(true);
    });

    it('propagates a failure to start, since there is nothing to hand back', async () => {
        const binaryPath = writeBinary();
        rememberVersion(binaryPath, 'v0.4.0');
        clientStub.startError = new Error('spawn failed');

        await expect(start(settingsFor(binaryPath))).rejects.toThrow('spawn failed');
    });
});

describe('a serverPath pointing at hydrust', () => {
    it('is used when it is a merged release', async () => {
        const hydrust = writeBinary('hydrust');
        rememberVersion(hydrust, 'v0.5.0');

        await start(settingsFor(hydrust));

        expect(clientStub.clients[0].serverOptions.run.command).toBe(hydrust);
    });

    it('is skipped with a warning when it is the pre-merge CLI', async () => {
        const bundled = writeBinary('bundled-hydra-lsp');
        const hydrust = writeBinary('hydrust');
        rememberVersions({ [bundled]: 'v0.4.0', [hydrust]: 'v0.4.2' });
        downloadStub.ensureError = new Error('offline');
        downloadStub.existing = { path: bundled, version: 'v0.4.0' };

        await start(settingsFor(hydrust, { serverVersion: '0.4.0' }));

        expect(clientStub.clients[0].serverOptions.run.command).toBe(bundled);
        expect(stub.logs.some((line) => line.startsWith('warn:') && line.includes(`Ignoring 'path' setting`)))
            .toBe(true);
    });

    it('is skipped when it is the pre-merge CLI with an upper-case .EXE', async () => {
        const bundled = writeBinary('bundled-hydra-lsp');
        const hydrust = writeBinary('hydrust.EXE');
        rememberVersions({ [bundled]: 'v0.4.0', [hydrust]: 'v0.4.2' });
        downloadStub.ensureError = new Error('offline');
        downloadStub.existing = { path: bundled, version: 'v0.4.0' };

        await start(settingsFor(hydrust, { serverVersion: '0.4.0' }));

        expect(clientStub.clients[0].serverOptions.run.command).toBe(bundled);
    });

    it('warns once per path, not on every restart', async () => {
        const bundled = writeBinary('bundled-hydra-lsp');
        const hydrust = writeBinary('hydrust');
        rememberVersions({ [bundled]: 'v0.4.0', [hydrust]: 'v0.4.2' });
        downloadStub.ensureError = new Error('offline');
        downloadStub.existing = { path: bundled, version: 'v0.4.0' };

        await start(settingsFor(hydrust, { serverVersion: '0.4.0' }));
        await start(settingsFor(hydrust, { serverVersion: '0.4.0' }));

        const warnings = stub.messages.filter((m) => m.kind === 'warning' && m.message.includes(hydrust));
        expect(warnings).toHaveLength(1);
    });

    it('is used when its version cannot be determined', async () => {
        const hydrust = writeBinary('hydrust');

        await start(settingsFor(hydrust));

        expect(clientStub.clients[0].serverOptions.run.command).toBe(hydrust);
    });
});

describe('looking for a server on PATH', () => {
    /** Leave bundled resolution nowhere to go but an installed binary, so it never downloads. */
    function bundledFallback(): string {
        const bundled = writeBinary('bundled-hydra-lsp');
        rememberVersion(bundled, 'v0.4.0');
        downloadStub.ensureError = new Error('offline');
        downloadStub.existing = { path: bundled, version: 'v0.4.0' };
        return bundled;
    }

    it('uses a merged hydrust when it is the only name on PATH', async () => {
        const hydrust = writeBinary('hydrust');
        rememberVersion(hydrust, 'v0.5.0');
        whichStub.paths = { hydrust };

        await start(settingsFor('', { serverVersion: '0.4.0' }));

        expect(clientStub.clients[0].serverOptions.run.command).toBe(hydrust);
    });

    it('skips a pre-merge hydrust CLI and falls back to bundled', async () => {
        const bundled = bundledFallback();
        const hydrust = writeBinary('hydrust');
        rememberVersion(hydrust, 'v0.4.2');
        whichStub.paths = { hydrust };

        await start(settingsFor('', { serverVersion: '0.4.0' }));

        expect(clientStub.clients[0].serverOptions.run.command).toBe(bundled);
    });

    it('skips a pre-merge hydrust.EXE CLI on PATH', async () => {
        const hydraLsp = writeBinary('hydra-lsp');
        const hydrust = writeBinary('hydrust.EXE');
        whichStub.paths = { 'hydra-lsp': hydraLsp, hydrust };
        rememberVersions({ [hydraLsp]: 'v0.4.0', [hydrust]: 'v0.4.2' });

        await start(settingsFor('', { serverVersion: '0.4.0' }));

        expect(clientStub.clients[0].serverOptions.run.command).toBe(hydraLsp);
    });

    it('prefers a newer hydrust over an older hydra-lsp on PATH', async () => {
        const hydraLsp = writeBinary('hydra-lsp');
        const hydrust = writeBinary('hydrust');
        whichStub.paths = { 'hydra-lsp': hydraLsp, hydrust };
        rememberVersions({ [hydraLsp]: 'v0.4.0', [hydrust]: 'v0.5.0' });

        await start(settingsFor('', { serverVersion: '0.4.0' }));

        expect(clientStub.clients[0].serverOptions.run.command).toBe(hydrust);
    });

    it('prefers a newer hydra-lsp over an older merged hydrust on PATH', async () => {
        const hydraLsp = writeBinary('hydra-lsp');
        const hydrust = writeBinary('hydrust');
        whichStub.paths = { 'hydra-lsp': hydraLsp, hydrust };
        rememberVersions({ [hydraLsp]: 'v0.6.0', [hydrust]: 'v0.5.0' });

        await start(settingsFor('', { serverVersion: '0.4.0' }));

        expect(clientStub.clients[0].serverOptions.run.command).toBe(hydraLsp);
    });

    it('uses hydra-lsp when the hydrust beside it is the pre-merge CLI', async () => {
        const hydraLsp = writeBinary('hydra-lsp');
        const hydrust = writeBinary('hydrust');
        whichStub.paths = { 'hydra-lsp': hydraLsp, hydrust };
        rememberVersions({ [hydraLsp]: 'v0.4.0', [hydrust]: 'v0.4.2' });

        await start(settingsFor('', { serverVersion: '0.4.0' }));

        expect(clientStub.clients[0].serverOptions.run.command).toBe(hydraLsp);
    });

    it('skips a hydrust whose version cannot be determined and falls back to bundled', async () => {
        const bundled = bundledFallback();
        const hydrust = writeBinary('hydrust');
        whichStub.paths = { hydrust };

        await start(settingsFor('', { serverVersion: '0.4.0' }));

        expect(clientStub.clients[0].serverOptions.run.command).toBe(bundled);
    });

    it.skipIf(process.platform === 'win32')('asks a hydrust remembered as unknown again, but only once per session', async () => {
        const bundled = bundledFallback();
        const runs = path.join(scratchDir, 'runs');
        const hydrust = path.join(scratchDir, 'hydrust');
        fs.writeFileSync(hydrust, `#!/bin/sh\necho run >> "${runs}"\necho "hydrust 0.5.0"\n`, { mode: 0o755 });
        rememberVersions({ [bundled]: 'v0.4.0', [hydrust]: null });
        whichStub.paths = { hydrust };

        await start(settingsFor('', { serverVersion: '0.4.0' }));
        expect(clientStub.clients[0].serverOptions.run.command).toBe(hydrust);

        rememberVersions({ [bundled]: 'v0.4.0', [hydrust]: null });
        await start(settingsFor('', { serverVersion: '0.4.0' }));
        expect(clientStub.clients[1].serverOptions.run.command).toBe(bundled);
        expect(fs.readFileSync(runs, 'utf8').trim().split('\n')).toHaveLength(1);
    });

    it('skips a hydrust.cmd shim that is the pre-merge CLI', async () => {
        const hydraLsp = writeBinary('hydra-lsp');
        const hydrust = writeBinary('hydrust.cmd');
        whichStub.paths = { 'hydra-lsp': hydraLsp, hydrust };
        rememberVersions({ [hydraLsp]: 'v0.4.0', [hydrust]: 'v0.4.2' });

        await start(settingsFor('', { serverVersion: '0.4.0' }));

        expect(clientStub.clients[0].serverOptions.run.command).toBe(hydraLsp);
    });

    it('prefers a merged hydrust over a hydra-lsp whose version cannot be determined', async () => {
        const hydraLsp = writeBinary('hydra-lsp');
        const hydrust = writeBinary('hydrust');
        whichStub.paths = { 'hydra-lsp': hydraLsp, hydrust };
        rememberVersion(hydrust, 'v0.5.0');

        await start(settingsFor('', { serverVersion: '0.4.0' }));

        expect(clientStub.clients[0].serverOptions.run.command).toBe(hydrust);
    });

    it('falls back to bundled when neither name is on PATH', async () => {
        const bundled = bundledFallback();

        await start(settingsFor('', { serverVersion: '0.4.0' }));

        expect(downloadStub.scans).toBe(1);
        expect(clientStub.clients[0].serverOptions.run.command).toBe(bundled);
    });
});

describe('looking for a server in the selected Python environment', () => {
    const INTERPRETER = '/project/.venv/bin/python';

    /** Leave bundled resolution nowhere to go but an installed binary, so it never downloads. */
    function bundledFallback(): string {
        const bundled = writeBinary('bundled-hydra-lsp');
        rememberVersion(bundled, 'v0.4.0');
        downloadStub.ensureError = new Error('offline');
        downloadStub.existing = { path: bundled, version: 'v0.4.0' };
        return bundled;
    }

    /** A hydrust the interpreter reports. Its version is seeded separately, or left unknown. */
    function environmentHydrust(): string {
        fs.mkdirSync(path.join(scratchDir, 'venv-bin'), { recursive: true });
        const hydrust = path.join(scratchDir, 'venv-bin', 'hydrust');
        fs.writeFileSync(hydrust, 'not a program', { mode: 0o644 });
        pythonStub.binaries[INTERPRETER] = hydrust;
        return hydrust;
    }

    it('uses the environment\'s hydrust ahead of a newer one on PATH', async () => {
        const fromEnv = environmentHydrust();
        const onPath = writeBinary('hydrust');
        whichStub.paths = { hydrust: onPath };
        rememberVersions({ [fromEnv]: 'v0.5.0', [onPath]: 'v0.6.0' });

        const started = await start(settingsFor('', { interpreter: INTERPRETER, serverVersion: '0.4.0' }));

        expect(pythonStub.lookups).toEqual([INTERPRETER]);
        expect(clientStub.clients[0].serverOptions.run.command).toBe(fromEnv);
        expect(started.compat).toBeDefined();
    });

    it('asks the interpreter once, not on every restart', async () => {
        // The handshake records the version it reports, so it must match.
        clientStub.initializeResult = initializeResult('0.5.0');
        const fromEnv = environmentHydrust();
        rememberVersion(fromEnv, 'v0.5.0');
        const settings = settingsFor('', { interpreter: INTERPRETER, serverVersion: '0.4.0' });

        await start(settings);
        await start(settings);

        expect(pythonStub.lookups).toEqual([INTERPRETER]);
        expect(clientStub.clients[1].serverOptions.run.command).toBe(fromEnv);
    });

    it('asks again when a remembered binary has gone', async () => {
        // The handshake records the version it reports, so it must match.
        clientStub.initializeResult = initializeResult('0.5.0');
        const fromEnv = environmentHydrust();
        rememberVersion(fromEnv, 'v0.5.0');
        const settings = settingsFor('', { interpreter: INTERPRETER, serverVersion: '0.4.0' });

        await start(settings);
        fs.rmSync(fromEnv);
        delete pythonStub.binaries[INTERPRETER];
        const onPath = writeBinary('hydrust');
        rememberVersion(onPath, 'v0.5.0');
        whichStub.paths = { hydrust: onPath };
        await start(settings);

        expect(pythonStub.lookups).toEqual([INTERPRETER, INTERPRETER]);
        expect(clientStub.clients[1].serverOptions.run.command).toBe(onPath);
    });

    it('does not ask again for an interpreter with no hydrust', async () => {
        // The handshake records the version it reports, so it must match.
        clientStub.initializeResult = initializeResult('0.5.0');
        const onPath = writeBinary('hydrust');
        rememberVersion(onPath, 'v0.5.0');
        whichStub.paths = { hydrust: onPath };
        const settings = settingsFor('', { interpreter: INTERPRETER, serverVersion: '0.4.0' });

        await start(settings);
        await start(settings);

        expect(pythonStub.lookups).toEqual([INTERPRETER]);
    });

    it('asks again after a restart, so a newly installed hydrust is found', async () => {
        // The handshake records the version it reports, so it must match.
        clientStub.initializeResult = initializeResult('0.5.0');
        const onPath = writeBinary('hydrust');
        rememberVersion(onPath, 'v0.5.0');
        whichStub.paths = { hydrust: onPath };
        const settings = settingsFor('', { interpreter: INTERPRETER, serverVersion: '0.4.0' });

        await start(settings);
        forgetInterpreterLookups();
        const fromEnv = environmentHydrust();
        rememberVersion(fromEnv, 'v0.5.0');
        await start(settings);

        expect(pythonStub.lookups).toEqual([INTERPRETER, INTERPRETER]);
        expect(clientStub.clients[1].serverOptions.run.command).toBe(fromEnv);
    });

    it('falls back to PATH when the environment has no hydrust', async () => {
        const onPath = writeBinary('hydrust');
        rememberVersion(onPath, 'v0.5.0');
        whichStub.paths = { hydrust: onPath };

        await start(settingsFor('', { interpreter: INTERPRETER, serverVersion: '0.4.0' }));

        expect(pythonStub.lookups).toEqual([INTERPRETER]);
        expect(clientStub.clients[0].serverOptions.run.command).toBe(onPath);
    });

    it('falls back to an older hydra-lsp on PATH when the environment has no hydrust', async () => {
        const hydraLsp = writeBinary('hydra-lsp');
        rememberVersion(hydraLsp, 'v0.4.2');
        whichStub.paths = { 'hydra-lsp': hydraLsp };

        await start(settingsFor('', { interpreter: INTERPRETER, serverVersion: '0.4.0' }));

        expect(clientStub.clients[0].serverOptions.run.command).toBe(hydraLsp);
    });

    it('falls back to bundled when neither the environment nor PATH has a server', async () => {
        const bundled = bundledFallback();

        await start(settingsFor('', { interpreter: INTERPRETER, serverVersion: '0.4.0' }));

        expect(clientStub.clients[0].serverOptions.run.command).toBe(bundled);
    });

    it('skips a reported binary that is not on disk', async () => {
        pythonStub.binaries[INTERPRETER] = path.join(scratchDir, 'gone', 'hydrust');
        const onPath = writeBinary('hydrust');
        rememberVersion(onPath, 'v0.5.0');
        whichStub.paths = { hydrust: onPath };

        await start(settingsFor('', { interpreter: INTERPRETER, serverVersion: '0.4.0' }));

        expect(clientStub.clients[0].serverOptions.run.command).toBe(onPath);
    });

    it('skips an environment hydrust that is the pre-merge CLI', async () => {
        const fromEnv = environmentHydrust();
        const onPath = writeBinary('hydrust');
        whichStub.paths = { hydrust: onPath };
        rememberVersions({ [fromEnv]: 'v0.4.2', [onPath]: 'v0.5.0' });

        await start(settingsFor('', { interpreter: INTERPRETER, serverVersion: '0.4.0' }));

        expect(clientStub.clients[0].serverOptions.run.command).toBe(onPath);
    });

    it('skips an environment hydrust whose version cannot be determined', async () => {
        const bundled = bundledFallback();
        environmentHydrust();

        await start(settingsFor('', { interpreter: INTERPRETER, serverVersion: '0.4.0' }));

        expect(clientStub.clients[0].serverOptions.run.command).toBe(bundled);
    });

    it('carries on to PATH when the lookup itself throws', async () => {
        pythonStub.binaries[INTERPRETER] = new Error('boom');
        const onPath = writeBinary('hydrust');
        rememberVersion(onPath, 'v0.5.0');
        whichStub.paths = { hydrust: onPath };

        await start(settingsFor('', { interpreter: INTERPRETER, serverVersion: '0.4.0' }));

        expect(clientStub.clients[0].serverOptions.run.command).toBe(onPath);
    });

    it('is not consulted when no interpreter is known', async () => {
        const onPath = writeBinary('hydrust');
        rememberVersion(onPath, 'v0.5.0');
        whichStub.paths = { hydrust: onPath };

        await start(settingsFor('', { interpreter: '', serverVersion: '0.4.0' }));

        expect(pythonStub.lookups).toEqual([]);
        expect(clientStub.clients[0].serverOptions.run.command).toBe(onPath);
    });

    it('is not consulted with useBundled', async () => {
        const bundled = bundledFallback();
        const fromEnv = environmentHydrust();
        rememberVersions({ [bundled]: 'v0.4.0', [fromEnv]: 'v0.5.0' });

        await start(settingsFor('', { interpreter: INTERPRETER, importStrategy: 'useBundled', serverVersion: '0.4.0' }));

        expect(pythonStub.lookups).toEqual([]);
        expect(clientStub.clients[0].serverOptions.run.command).toBe(bundled);
    });

    it('is not consulted when serverPath points at a usable server', async () => {
        const configured = writeBinary('hydrust');
        const fromEnv = environmentHydrust();
        rememberVersions({ [configured]: 'v0.5.0', [fromEnv]: 'v0.5.0' });

        await start(settingsFor(configured, { interpreter: INTERPRETER }));

        expect(pythonStub.lookups).toEqual([]);
        expect(clientStub.clients[0].serverOptions.run.command).toBe(configured);
    });
});

describe('falling back when the bundled server cannot be ensured', () => {
    it('uses an installed binary when a pinned version fails', async () => {
        const binaryPath = writeBinary();
        rememberVersion(binaryPath, 'v0.3.0');
        downloadStub.ensureError = new Error('offline');
        downloadStub.existing = { path: binaryPath, version: 'v0.3.0' };

        await start(settingsFor('', { importStrategy: 'useBundled', serverVersion: '0.4.0' }));

        expect(downloadStub.scans).toBe(1);
        expect(clientStub.clients[0].serverOptions.run.command).toBe(binaryPath);
    });

    it('does not scan again for latest, which already fell back inside ensureServer', async () => {
        const binaryPath = writeBinary();
        downloadStub.ensureError = new Error('offline');
        downloadStub.existing = { path: binaryPath, version: 'v0.3.0' };

        await expect(start(settingsFor('', { importStrategy: 'useBundled', serverVersion: 'latest' }))).rejects.toThrow(
            'offline'
        );
        expect(downloadStub.scans).toBe(0);
    });
});

describe('keeping a running bundled server marked as used', () => {
    const RUNNING = 2;
    const STOPPED = 1;
    const DAY_MS = 24 * 60 * 60 * 1000;

    function fireState(newState: number): void {
        for (const listener of clientStub.stateListeners) {
            listener({ oldState: 0, newState });
        }
    }

    it('records use on Running, refreshes daily, and never stacks intervals across restarts', async () => {
        const binaryPath = writeBinary();
        rememberVersion(binaryPath, 'v0.3.0');
        downloadStub.ensureError = new Error('offline');
        downloadStub.existing = { path: binaryPath, version: 'v0.3.0' };

        await start(settingsFor('', { importStrategy: 'useBundled', serverVersion: '0.4.0' }));
        expect(clientStub.stateListeners).toHaveLength(1);

        const key = versionLastUsedKey(path.basename(getVersionedDir(asExtensionContext(context), 'v0.3.0')));
        stub.globalState.delete(key);
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
        vi.setSystemTime(1_000_000);

        fireState(RUNNING);
        await Promise.resolve();
        expect(stub.globalState.get(key)).toBe(1_000_000);
        expect(vi.getTimerCount()).toBe(1);

        vi.advanceTimersByTime(DAY_MS);
        await Promise.resolve();
        expect(stub.globalState.get(key)).toBe(1_000_000 + DAY_MS);

        fireState(STOPPED);
        expect(vi.getTimerCount()).toBe(0);

        fireState(RUNNING);
        fireState(RUNNING);
        expect(vi.getTimerCount()).toBe(1);
    });
});

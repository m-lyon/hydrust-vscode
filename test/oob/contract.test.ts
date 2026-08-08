/**
 * Boot the real hydra-lsp binary and check the extension reads it correctly.
 *
 * The compatibility layer's whole job is to understand what the server says
 * about itself. The unit tests exercise it against handwritten payloads, which
 * proves the parsing works but not that the payloads look anything like what
 * the server sends. This suite closes that gap: it does an `initialize`
 * handshake by hand and puts the real reply through the extension's own
 * `parseHydrustCapabilities` and `buildCompatReport`.
 *
 * The feature list is negotiated per connection, so it is checked from both
 * ends: a client asking for everything, and a client asking for nothing.
 *
 * Run with `npm run test:contract`. Not part of `npm test`: it needs a built
 * server binary.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
    CLIENT_PROTOCOL_VERSION,
    FEATURE_COMPAT,
    FEATURE_DIAGNOSTIC_REFRESH,
    FEATURE_PULL_DIAGNOSTICS,
    FEATURE_WATCHED_FILES,
    HydrustCapabilities,
    RULE_COMPAT,
    SETTING_COMPAT,
    advertisesPullDiagnostics,
    buildCompatReport,
    formatServerVersion,
    parseHydrustCapabilities,
    readServerInfoVersion,
} from '../../src/common/compatTable';
import { ALL_CAPABILITIES, NO_CAPABILITIES, initializeHandshake } from './lspClient';
import { REPO_ROOT } from './serverRepo';

/** Where to find the server binary, and a clear complaint when it is missing. */
function requireBinary(): string {
    const candidates = process.env.HYDRA_LSP_BINARY
        ? [path.resolve(process.env.HYDRA_LSP_BINARY)]
        : [
            path.resolve(REPO_ROOT, '..', 'hydra-lsp', 'target', 'debug', 'hydra-lsp'),
            path.resolve(REPO_ROOT, '..', 'hydra-lsp', 'target', 'debug', 'hydra-lsp.exe'),
        ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    throw new Error(
        'No hydra-lsp binary was found, so there is nothing to check the extension against.\n' +
        `Looked in:\n${candidates.map((entry) => `  ${entry}`).join('\n')}\n\n` +
        'Build the server first:\n' +
        '  cd ../hydra-lsp && cargo build\n' +
        'or point $HYDRA_LSP_BINARY at an existing binary.\n\n' +
        'This suite deliberately fails rather than skipping: it is the only thing\n' +
        'that catches the extension and the server drifting apart, and a skip would\n' +
        'look green while checking nothing.'
    );
}

let binaryPath: string;
let workspace: string;

/** The reply from a client that advertised everything. */
let fullResult: unknown;
/** The reply from a client that advertised nothing. */
let bareResult: unknown;

beforeAll(async () => {
    binaryPath = requireBinary();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hydrust-contract-'));

    fullResult = (await initializeHandshake({ binaryPath, capabilities: ALL_CAPABILITIES, rootPath: workspace }))
        .initializeResult;
    bareResult = (await initializeHandshake({ binaryPath, capabilities: NO_CAPABILITIES, rootPath: workspace }))
        .initializeResult;
});

afterAll(() => {
    if (workspace) {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

/** The capability block, insisting it is really there. */
function blockFrom(result: unknown): HydrustCapabilities {
    const parsed = parseHydrustCapabilities(result);
    expect(
        parsed,
        'The server sent no capabilities.experimental.hydrust block. Every server from ' +
        'v0.4.0 should send one, so either the binary is older than v0.4.0 or the block ' +
        'has been removed.'
    ).toBeDefined();
    return parsed!;
}

describe('the capability block the server really sends', () => {
    it('is present and speaks a protocol this client understands', () => {
        const block = blockFrom(fullResult);

        expect(block.protocolVersion).toBeDefined();
        expect(block.protocolVersion).toBeLessThanOrEqual(CLIENT_PROTOCOL_VERSION);
    });

    it('names itself with a version the extension can parse', () => {
        const version = readServerInfoVersion(fullResult);

        expect(version, 'serverInfo.version was missing or unparseable').toBeDefined();
        expect(formatServerVersion(version!)).toMatch(/^v\d+\.\d+\.\d+$/);
    });

    it('lists every setting the extension sends', () => {
        const block = blockFrom(fullResult);
        expect(block.supportedSettings).toBeDefined();

        const missing = SETTING_COMPAT.map((setting) => setting.key).filter(
            (key) => !block.supportedSettings!.includes(key)
        );
        expect(
            missing,
            `The extension sends these keys but the server does not read them: ${missing.join(', ')}. ` +
            'Either the server dropped support, or SETTING_COMPAT lists a key that was never real.'
        ).toEqual([]);
    });

    it('lists every rule code the extension offers', () => {
        const block = blockFrom(fullResult);
        expect(block.supportedRules).toBeDefined();

        const missing = RULE_COMPAT.map((rule) => rule.code).filter(
            (code) => !block.supportedRules!.includes(code)
        );
        expect(
            missing,
            `The extension offers these rule codes but the server does not accept them: ` +
            `${missing.join(', ')}. package.json would be offering the user a dead option.`
        ).toEqual([]);
    });

    it('reads no setting the extension has never heard of', () => {
        // Not a failure of the server, but it does mean the extension is
        // leaving something on the table, so it is worth surfacing.
        const block = blockFrom(fullResult);
        const known = new Set(SETTING_COMPAT.map((setting) => setting.key));
        const extra = block.supportedSettings!.filter((key) => !known.has(key));

        expect(
            extra,
            `The server reads these settings that the extension never sends: ${extra.join(', ')}. ` +
            'Add them to SETTING_COMPAT and package.json, or the feature is unreachable.'
        ).toEqual([]);
    });

    it('accepts no rule code the extension never offers', () => {
        const block = blockFrom(fullResult);
        const known = new Set(RULE_COMPAT.map((rule) => rule.code));
        const extra = block.supportedRules!.filter((code) => !known.has(code));

        expect(
            extra,
            `The server accepts these rule codes that the extension never offers: ${extra.join(', ')}. ` +
            'Add them to RULE_COMPAT and the hydrust.disabledRules enum.'
        ).toEqual([]);
    });
});

describe('the report the extension builds from it', () => {
    it('finds nothing to warn about, whatever the user configured', () => {
        const block = blockFrom(fullResult);
        const report = buildCompatReport({
            version: readServerInfoVersion(fullResult),
            capabilities: block,
            // Pretend the user changed every setting and listed every rule:
            // the worst case for spurious warnings.
            configuredSettings: SETTING_COMPAT.map((setting) => setting.configKey),
            configuredRules: RULE_COMPAT.map((rule) => rule.code),
            pullDiagnosticsAdvertised: advertisesPullDiagnostics(fullResult),
        });

        expect(report.authoritative).toBe(true);
        expect(report.protocolNewerThanClient).toBe(false);
        expect(
            report.unsupportedSettings.map((entry) => `${entry.name}: ${entry.reason}`),
            'The extension would warn the user about settings this server does read.'
        ).toEqual([]);
        expect(
            report.unsupportedRules.map((entry) => `${entry.name}: ${entry.reason}`),
            'The extension would warn the user about rules this server does accept.'
        ).toEqual([]);
    });

    it('knows about every feature name the server can send', () => {
        const block = blockFrom(fullResult);
        const known = new Set(FEATURE_COMPAT.map((feature) => feature.name));
        const unknownNames = (block.features ?? []).filter((name) => !known.has(name));

        // Unknown names are carried through rather than dropped, so this is a
        // nudge rather than a breakage. It still means FEATURE_COMPAT is behind.
        expect(
            unknownNames,
            `The server negotiated features the extension does not know: ${unknownNames.join(', ')}. ` +
            'Add them to FEATURE_COMPAT so the version-table fallback can reason about them.'
        ).toEqual([]);
    });
});

describe('feature negotiation', () => {
    it('turns everything on for a client that advertised everything', () => {
        const block = blockFrom(fullResult);

        expect(block.features).toBeDefined();
        expect([...block.features!].sort()).toEqual(
            [FEATURE_DIAGNOSTIC_REFRESH, FEATURE_PULL_DIAGNOSTICS, FEATURE_WATCHED_FILES].sort()
        );

        const report = buildCompatReport({
            version: readServerInfoVersion(fullResult),
            capabilities: block,
            configuredSettings: [],
            configuredRules: [],
            pullDiagnosticsAdvertised: advertisesPullDiagnostics(fullResult),
        });
        expect(report.features).toEqual({
            [FEATURE_PULL_DIAGNOSTICS]: true,
            [FEATURE_WATCHED_FILES]: true,
            [FEATURE_DIAGNOSTIC_REFRESH]: true,
        });
    });

    it('turns everything off for a client that advertised nothing', () => {
        const block = blockFrom(bareResult);

        expect(
            block.features,
            'A client that asked for nothing should be offered nothing. An empty list is the ' +
            'correct answer here; anything else means the server is not really negotiating.'
        ).toEqual([]);

        const report = buildCompatReport({
            version: readServerInfoVersion(bareResult),
            capabilities: block,
            configuredSettings: [],
            configuredRules: [],
            pullDiagnosticsAdvertised: advertisesPullDiagnostics(bareResult),
        });
        expect(report.features).toEqual({
            [FEATURE_PULL_DIAGNOSTICS]: false,
            [FEATURE_WATCHED_FILES]: false,
            [FEATURE_DIAGNOSTIC_REFRESH]: false,
        });
    });

    it('still reads the same settings and rules for a bare client', () => {
        // Negotiation is only about the optional behaviours. What the server
        // reads out of initializationOptions does not depend on the client.
        const full = blockFrom(fullResult);
        const bare = blockFrom(bareResult);

        expect(bare.supportedSettings).toEqual(full.supportedSettings);
        expect(bare.supportedRules).toEqual(full.supportedRules);
        expect(bare.protocolVersion).toBe(full.protocolVersion);
    });

    it('turns on exactly the one behaviour a partly-capable client asked for', async () => {
        const { initializeResult } = await initializeHandshake({
            binaryPath,
            rootPath: workspace,
            capabilities: {
                workspace: { didChangeWatchedFiles: { dynamicRegistration: true } },
            },
        });
        const block = blockFrom(initializeResult);

        expect(block.features).toEqual([FEATURE_WATCHED_FILES]);
    });

    it('does not offer refresh to a client that only does pull diagnostics', async () => {
        const { initializeResult } = await initializeHandshake({
            binaryPath,
            rootPath: workspace,
            capabilities: { textDocument: { diagnostic: {} } },
        });
        const block = blockFrom(initializeResult);

        expect(block.features).toEqual([FEATURE_PULL_DIAGNOSTICS]);
    });
});

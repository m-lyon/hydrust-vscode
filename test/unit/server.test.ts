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
}));

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
    }

    return { LanguageClient };
});

import { startServer } from '../../src/common/server';
import { PROBE_CACHE_KEY } from '../../src/common/compat';
import { ExtensionSettings } from '../../src/common/settings';
import { createStubExtensionContext, resetVscodeStub, stub } from '../stubs/vscode';

const SERVER_ID = 'hydrust';
const SERVER_NAME = 'Hydrust';

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
    const stats = fs.statSync(binaryPath);
    const fingerprint = `${binaryPath}|${Math.round(stats.mtimeMs)}|${stats.size}`;
    stub.globalState.set(PROBE_CACHE_KEY, { [fingerprint]: version });
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
        projectRoot
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
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydrust-server-'));
    context = createStubExtensionContext(scratchDir);
    outputChannel = { name: 'test' } as unknown as vscode.OutputChannel;
});

afterEach(() => {
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

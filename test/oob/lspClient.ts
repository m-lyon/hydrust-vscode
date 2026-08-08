/**
 * A tiny hand-rolled LSP client, just enough to do one `initialize` handshake
 * over stdio and read the reply.
 *
 * vscode-languageclient is not usable here: it expects an extension host. The
 * point of the contract suite is to see exactly what the server puts on the
 * wire, so framing the messages by hand is the honest way to do it.
 */

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';

/** Everything the caller can steer about the handshake. */
export interface HandshakeOptions {
    /** Absolute path to the server binary. */
    binaryPath: string;
    /** The `capabilities` object the client advertises. */
    capabilities: Record<string, unknown>;
    /** Workspace root sent as `rootUri`. */
    rootPath: string;
    /** How long to wait for the response before giving up. */
    timeoutMs?: number;
}

/** Frame a JSON-RPC message the way LSP wants it. */
function frame(message: unknown): string {
    const body = JSON.stringify(message);
    return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

/**
 * Pull whole JSON-RPC messages out of a growing buffer.
 *
 * Returns the messages it could read and whatever is left over, so the caller
 * can keep appending to it.
 */
function drain(buffer: Buffer<ArrayBuffer>): { messages: unknown[]; rest: Buffer<ArrayBuffer> } {
    const messages: unknown[] = [];
    let rest: Buffer<ArrayBuffer> = buffer;

    for (;;) {
        const separator = rest.indexOf('\r\n\r\n');
        if (separator === -1) {
            break;
        }
        const header = rest.subarray(0, separator).toString('ascii');
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) {
            throw new Error(`Server sent a header with no Content-Length: ${JSON.stringify(header)}`);
        }
        const length = Number(match[1]);
        const start = separator + 4;
        if (rest.length < start + length) {
            break;
        }
        messages.push(JSON.parse(rest.subarray(start, start + length).toString('utf8')));
        rest = rest.subarray(start + length);
    }

    return { messages, rest };
}

/** What one handshake produced. */
export interface HandshakeResult {
    /** The `result` field of the initialize response. */
    initializeResult: unknown;
    /** Anything the server wrote to stderr, for a useful failure message. */
    stderr: string;
}

/**
 * Start the server, send `initialize`, and hand back its reply.
 *
 * The server is stopped again before this returns, whatever happened.
 */
export async function initializeHandshake(options: HandshakeOptions): Promise<HandshakeResult> {
    const timeoutMs = options.timeoutMs ?? 30000;
    const child: ChildProcessWithoutNullStreams = spawn(options.binaryPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
    });

    try {
        const initializeResult = await new Promise<unknown>((resolve, reject) => {
            let buffer: Buffer<ArrayBuffer> = Buffer.alloc(0);

            const timer = setTimeout(() => {
                reject(
                    new Error(
                        `${options.binaryPath} did not answer initialize within ${timeoutMs}ms.\n` +
                        `Server stderr:\n${stderr || '(nothing)'}`
                    )
                );
            }, timeoutMs);

            const done = (settle: () => void) => {
                clearTimeout(timer);
                settle();
            };

            child.on('error', (err) => done(() => reject(err)));
            child.on('exit', (code) =>
                done(() =>
                    reject(
                        new Error(
                            `${options.binaryPath} exited with code ${code} before answering ` +
                            `initialize.\nServer stderr:\n${stderr || '(nothing)'}`
                        )
                    )
                )
            );

            child.stdout.on('data', (chunk: Buffer) => {
                buffer = Buffer.concat([buffer, chunk]);
                let messages: unknown[];
                try {
                    ({ messages, rest: buffer } = drain(buffer));
                } catch (err) {
                    done(() => reject(err));
                    return;
                }
                for (const message of messages) {
                    const envelope = message as { id?: number; result?: unknown; error?: unknown };
                    if (envelope.id !== 1) {
                        // A log message or some other notification. Not ours.
                        continue;
                    }
                    if (envelope.error) {
                        done(() =>
                            reject(new Error(`initialize failed: ${JSON.stringify(envelope.error)}`))
                        );
                        return;
                    }
                    done(() => resolve(envelope.result));
                    return;
                }
            });

            child.stdin.write(
                frame({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: {
                        processId: process.pid,
                        rootUri: `file://${options.rootPath}`,
                        capabilities: options.capabilities,
                        clientInfo: { name: 'hydrust-contract-test', version: '0.0.0' },
                    },
                })
            );
        });

        return { initializeResult, stderr };
    } finally {
        child.stdin.end();
        child.kill('SIGKILL');
    }
}

/** A client that asks for every optional behaviour the server can offer. */
export const ALL_CAPABILITIES: Record<string, unknown> = {
    textDocument: {
        // Pull diagnostics: the server answers textDocument/diagnostic.
        diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
        synchronization: { dynamicRegistration: false },
    },
    workspace: {
        // Dynamic registration: the server sets up its own file watchers.
        didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
        // Refresh: the server can nudge us to re-pull.
        diagnostic: { refreshSupport: true },
    },
};

/** A client that asks for nothing optional at all. */
export const NO_CAPABILITIES: Record<string, unknown> = {};

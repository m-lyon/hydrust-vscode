import { execFile } from 'child_process';
import * as path from 'path';
import { logger } from './logger';

/**
 * How long to wait for the interpreter to answer. A conda or pyenv shim can
 * take a few seconds on a cold start; a healthy answer takes well under one.
 */
export const INTERPRETER_LOOKUP_TIMEOUT_MS = 5000;

/** The script that asks the `hydrust` package where its binary is, relative to the extension root. */
const FIND_BINARY_SCRIPT = path.join('bundled', 'tool', 'find_hydrust_bin.py');

/**
 * Find the `hydrust` binary installed in the environment of a Python
 * interpreter, such as one added with `uv add --dev hydrust`.
 *
 * That environment's scripts directory is often not on the extension host's
 * PATH (VS Code opened from a launcher rather than an activated shell), so the
 * interpreter is asked instead, through the same `find_hydrust_bin()` that
 * `python -m hydrust` uses. It ships in the `hydrust` wheel from server v0.5.0.
 *
 * Resolves to the absolute path reported, or undefined when hydrust is not
 * installed or the interpreter could not be asked. Never rejects.
 */
export function findHydrustInInterpreter(
    interpreter: string,
    extensionPath: string,
    timeoutMs: number = INTERPRETER_LOOKUP_TIMEOUT_MS
): Promise<string | undefined> {
    const script = path.join(extensionPath, FIND_BINARY_SCRIPT);
    // Node refuses to run a .bat/.cmd (a pyenv-win shim) without a shell,
    // and a shell does not quote arguments itself.
    const shell = process.platform === 'win32' && /\.(bat|cmd)$/i.test(interpreter);
    const file = shell ? `"${interpreter}"` : interpreter;
    const args = shell ? [`"${script}"`] : [script];

    return new Promise((resolve) => {
        execFile(
            file,
            args,
            { shell, timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true },
            (err, stdout, stderr) => {
                if (err) {
                    logger.warn(`Could not ask ${interpreter} where hydrust is installed: ${stderr.trim() || err.message}`);
                    resolve(undefined);
                    return;
                }
                const binaryPath = stdout.trim().split(/\r?\n/).pop()?.trim();
                if (!binaryPath) {
                    logger.debug(`hydrust is not installed in the environment of ${interpreter}.`);
                    resolve(undefined);
                    return;
                }
                if (!path.isAbsolute(binaryPath)) {
                    logger.warn(`Ignoring ${JSON.stringify(binaryPath)} from ${interpreter}: not an absolute path.`);
                    resolve(undefined);
                    return;
                }
                resolve(binaryPath);
            }
        );
    });
}

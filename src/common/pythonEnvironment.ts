import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { logger } from './logger';

/**
 * How long to wait for the interpreter to answer.
 *
 * Longer than the `--version` probe: this starts a Python interpreter, and a
 * conda or pyenv shim can take a few seconds on a cold start. A healthy answer
 * takes well under a second.
 */
export const INTERPRETER_LOOKUP_TIMEOUT_MS = 5000;

/**
 * Asks the `hydrust` Python package where it installed its binary.
 *
 * `find_hydrust_bin()` ships in the `hydrust` wheel on PyPI from server v0.5.0.
 * Nothing older was ever published there, so for an older server, or an
 * environment without the package, the import fails and the caller falls back
 * to PATH exactly as before.
 */
const FIND_BINARY_SCRIPT = [
    'import os',
    'from hydrust import find_hydrust_bin',
    'print(os.fsdecode(find_hydrust_bin()))',
].join('\n');

/** Cap on how much stderr is kept for the log, so a noisy interpreter cannot grow it unbounded. */
const STDERR_LIMIT = 4096;

/**
 * Find the `hydrust` binary installed in the environment of a Python
 * interpreter, such as one added with `uv add --dev hydrust` or
 * `pip install hydrust`.
 *
 * That environment's scripts directory is often not on the extension host's
 * PATH (VS Code opened from a launcher rather than an activated shell), so a
 * PATH lookup misses it. The interpreter is asked instead, through the same
 * `find_hydrust_bin()` that `python -m hydrust` uses.
 *
 * Resolves to an absolute path, or undefined for any failure: the package is
 * not installed, the interpreter does not exist or does not answer in time, or
 * the answer is not an absolute path. None of these is an error, since most
 * environments will not have hydrust installed.
 *
 * `timeoutMs` only exists so the tests can make a hang happen quickly.
 */
export function findHydrustInInterpreter(
    interpreter: string,
    timeoutMs: number = INTERPRETER_LOOKUP_TIMEOUT_MS
): Promise<string | undefined> {
    return new Promise((resolve) => {
        let settled = false;
        let stdout = '';
        let stderr = '';

        const finish = (value: string | undefined) => {
            if (!settled) {
                settled = true;
                resolve(value);
            }
        };

        let child;
        try {
            child = spawn(interpreter, ['-c', FIND_BINARY_SCRIPT], {
                // Not the workspace: `-c` puts the working directory first on
                // sys.path, so a folder named `hydrust` in the project would be
                // imported instead of the installed package.
                cwd: os.tmpdir(),
                // A path is printed, so make sure a non-ASCII one survives a
                // non-UTF-8 console encoding on Windows.
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch (err) {
            logger.debug(`Could not run ${interpreter} to look for hydrust: ${err}`);
            finish(undefined);
            return;
        }

        const timer = setTimeout(() => {
            logger.warn(
                `${interpreter} did not answer within ${timeoutMs}ms when asked where hydrust is installed. ` +
                'Looking on PATH instead.'
            );
            child.kill('SIGKILL');
            finish(undefined);
        }, timeoutMs);

        child.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            if (stderr.length < STDERR_LIMIT) {
                stderr += chunk.toString('utf8');
            }
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            logger.debug(`Could not run ${interpreter} to look for hydrust: ${err}`);
            finish(undefined);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                if (/No module named '?hydrust'?/.test(stderr)) {
                    logger.debug(`hydrust is not installed in the environment of ${interpreter}.`);
                } else {
                    logger.debug(
                        `${interpreter} could not locate a hydrust binary (exit code ${code}): ` +
                        stderr.trim().slice(-STDERR_LIMIT)
                    );
                }
                finish(undefined);
                return;
            }
            // The last line only: a sitecustomize or .pth file may print
            // something of its own first.
            const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
            const binaryPath = lines[lines.length - 1];
            if (!binaryPath || !path.isAbsolute(binaryPath)) {
                logger.debug(`${interpreter} gave an unusable hydrust location: ${JSON.stringify(stdout)}`);
                finish(undefined);
                return;
            }
            finish(binaryPath);
        });
    });
}

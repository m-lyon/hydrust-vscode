import { spawn } from 'child_process';
import * as fs from 'fs';
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

/** Marks the answer, so output from anything else in the interpreter cannot be mistaken for it. */
export const BINARY_LINE_PREFIX = 'HYDRUST_BIN:';

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
    `print(${JSON.stringify(BINARY_LINE_PREFIX)} + os.fsdecode(find_hydrust_bin()))`,
].join('\n');

/** Cap on how much output is kept, so a noisy interpreter cannot grow it unbounded. */
const OUTPUT_LIMIT = 4096;

/**
 * Cap on a single unterminated line, well above any real path (PATH_MAX is
 * 4096 on Linux, and a long path on Windows can reach ~32767), so only
 * runaway output is dropped.
 */
const LINE_LIMIT = 64 * 1024;

/**
 * What an interpreter had to say. `notInstalled` is a definitive answer from
 * an interpreter that ran; `couldNotAsk` means it could not be asked at all
 * (it could not be started, or did not answer in time), which says nothing
 * about the environment and is worth asking again later.
 */
export type InterpreterLookup =
    | { kind: 'found'; path: string }
    | { kind: 'notInstalled' }
    | { kind: 'couldNotAsk' };

const NOT_INSTALLED: InterpreterLookup = { kind: 'notInstalled' };
const COULD_NOT_ASK: InterpreterLookup = { kind: 'couldNotAsk' };

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
 * Resolves to the absolute path it reports, to `notInstalled` when the
 * interpreter ran but has no hydrust to point at, or to `couldNotAsk` when it
 * could not be run at all. None of these is an error, since most environments
 * will not have hydrust installed.
 *
 * `timeoutMs` only exists so the tests can make a hang happen quickly.
 */
export function findHydrustInInterpreter(
    interpreter: string,
    timeoutMs: number = INTERPRETER_LOOKUP_TIMEOUT_MS
): Promise<InterpreterLookup> {
    return new Promise<InterpreterLookup>((resolve) => {
        let settled = false;
        let stdout = '';
        let stderr = '';
        /** The marked answer, kept as it arrives so later output cannot evict it. */
        let markedLine: string | undefined;
        /** Whatever of the current line has arrived so far. */
        let pending = '';

        const finish = (value: InterpreterLookup) => {
            if (!settled) {
                settled = true;
                resolve(value);
            }
        };

        // `-c` puts the working directory first on sys.path, so run
        // somewhere nobody else can write: neither the workspace, where a
        // folder named `hydrust` would be imported instead of the installed
        // package, nor the shared /tmp, where any local user could plant one.
        // PYTHONSAFEPATH (3.11+) drops that entry altogether.
        let workingDir: string;
        try {
            workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydrust-lookup-'));
        } catch (err) {
            logger.debug(`Could not make a directory to run ${interpreter} in: ${err}`);
            resolve(COULD_NOT_ASK);
            return;
        }

        const cleanUp = () => {
            try {
                fs.rmSync(workingDir, { recursive: true, force: true });
            } catch {
                // Nothing useful to do; it is an empty directory in the temp dir.
            }
        };

        let child;
        try {
            child = spawn(interpreter, ['-c', FIND_BINARY_SCRIPT], {
                cwd: workingDir,
                // A path is printed, so make sure a non-ASCII one survives a
                // non-UTF-8 console encoding on Windows.
                env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONSAFEPATH: '1' },
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch (err) {
            logger.debug(`Could not run ${interpreter} to look for hydrust: ${err}`);
            cleanUp();
            finish(COULD_NOT_ASK);
            return;
        }

        const timer = setTimeout(() => {
            logger.warn(
                `${interpreter} did not answer within ${timeoutMs}ms when asked where hydrust is installed. ` +
                'Looking on PATH instead.'
            );
            child.kill('SIGKILL');
            // A shim that forked the real interpreter leaves a grandchild
            // holding these pipes open, so release them now.
            child.stdout?.destroy();
            child.stderr?.destroy();
            cleanUp();
            finish(COULD_NOT_ASK);
        }, timeoutMs);

        // setEncoding, not per-chunk toString: a multi-byte character split
        // across a chunk boundary must not decode to replacement characters.
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
            // Pick the answer out as it arrives: output from an atexit hook or
            // a .pth file, before or after it, cannot then push it out of the
            // capped buffer, which is only kept for the diagnostic log.
            stdout = (stdout + chunk).slice(-OUTPUT_LIMIT);
            const lines = (pending + chunk).split(/\r?\n/);
            pending = lines.pop() ?? '';
            if (pending.length > LINE_LIMIT) {
                // An absurdly long line is not the answer; drop it rather than
                // let it grow unbounded. What follows no longer starts with
                // the marker, so it cannot be mistaken for one.
                pending = '';
            }
            for (const line of lines) {
                if (line.trim().startsWith(BINARY_LINE_PREFIX)) {
                    markedLine = line.trim();
                }
            }
        });
        child.stderr?.on('data', (chunk: string) => {
            // Keep the tail: the useful part of a traceback is at the end.
            stderr = (stderr + chunk).slice(-OUTPUT_LIMIT);
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            cleanUp();
            logger.debug(`Could not run ${interpreter} to look for hydrust: ${err}`);
            finish(COULD_NOT_ASK);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            cleanUp();
            if (code !== 0) {
                if (/No module named '?hydrust'?/.test(stderr)) {
                    logger.debug(`hydrust is not installed in the environment of ${interpreter}.`);
                } else {
                    logger.debug(
                        `${interpreter} could not locate a hydrust binary (exit code ${code}): ` +
                        stderr.trim().slice(-OUTPUT_LIMIT)
                    );
                }
                finish(NOT_INSTALLED);
                return;
            }
            // A last line without a trailing newline is still an answer.
            if (pending.trim().startsWith(BINARY_LINE_PREFIX)) {
                markedLine = pending.trim();
            }
            const binaryPath = markedLine?.slice(BINARY_LINE_PREFIX.length).trim();
            if (!binaryPath || !path.isAbsolute(binaryPath)) {
                logger.debug(
                    `${interpreter} gave an unusable hydrust location: ` +
                    JSON.stringify(stdout.slice(-512))
                );
                finish(NOT_INSTALLED);
                return;
            }
            finish({ kind: 'found', path: binaryPath });
        });
    });
}

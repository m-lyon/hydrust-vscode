import { ChildProcess, spawn } from 'child_process';
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

/** How long a killed interpreter is given to die before the answer goes out anyway. */
const KILL_GRACE_MS = 1000;

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
    `print('${BINARY_LINE_PREFIX}' + os.fsdecode(find_hydrust_bin()))`,
].join('; ');

/** Cap on how much output is kept, so a noisy interpreter cannot grow it unbounded. */
const OUTPUT_LIMIT = 4096;

/**
 * Cap on a single unterminated line, well above any real path (PATH_MAX is
 * 4096 on Linux, and a long path on Windows can reach ~32767), so only
 * runaway output is dropped.
 */
const LINE_LIMIT = 64 * 1024;

/**
 * Characters cmd.exe acts on that double quotes do not reliably contain.
 * Control characters are included because a bare newline in a `/c` command
 * line separates commands.
 */
const SHELL_UNSAFE = /["&|^<>%\u0000-\u001f]/;

/**
 * What an interpreter had to say. `notInstalled` is a definitive answer from
 * an interpreter that ran; `couldNotAsk` means it could not be asked at all
 * (it could not be started, did not answer in time, or failed before it got as
 * far as answering), which says nothing about the environment and is worth
 * asking again later.
 */
export type InterpreterLookup =
    | { kind: 'found'; path: string; timedOut?: boolean }
    | { kind: 'notInstalled'; broken?: boolean }
    | { kind: 'couldNotAsk'; timedOut?: boolean };

const NOT_INSTALLED: InterpreterLookup = { kind: 'notInstalled' };
/**
 * A hydrust that is installed but could not say where its binary is (a
 * half-finished install, an unreadable scripts directory). Told apart so the
 * answer is not remembered across windows: fixing the environment does not
 * change the interpreter the cache is keyed on.
 */
const BROKEN_INSTALL: InterpreterLookup = { kind: 'notInstalled', broken: true };
const COULD_NOT_ASK: InterpreterLookup = { kind: 'couldNotAsk' };
/** An interpreter that hung. Told apart so the caller need not stall on it again. */
const TIMED_OUT: InterpreterLookup = { kind: 'couldNotAsk', timedOut: true };

/**
 * Stop a hung lookup, and everything it started.
 *
 * A shim (a Windows `.bat`/`.cmd` run through cmd.exe, or a conda/poetry-style
 * wrapper script that forks rather than execs) makes the real interpreter a
 * grandchild that would survive a kill of the shim alone, holding the lookup's
 * working directory and stdio open for the rest of the session. Elsewhere the
 * child leads its own process group (see `detached` below), so the group is
 * signalled and reaches a forked grandchild even once the child itself is gone.
 * Windows has no equivalent here: taskkill /T walks the live parent-PID links,
 * so a grandchild whose direct parent has already exited is missed and survives
 * (a Win32 Job Object would be the fix, and needs a native addon).
 */
function killTree(child: ChildProcess, platform: NodeJS.Platform): void {
    if (platform === 'win32' && child.pid !== undefined) {
        try {
            // Absolute path: a bare name is resolved against the current
            // directory before PATH, which the extension host does not control.
            const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
            const killer = spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            // taskkill missing, or run but refused (an elevated or protected
            // process): the direct child is still worth killing.
            killer.on('error', () => child.kill('SIGKILL'));
            killer.on('close', (code) => {
                if (code !== 0) {
                    child.kill('SIGKILL');
                }
            });
            return;
        } catch {
            // Fall through to killing the child on its own.
        }
    } else if (child.pid !== undefined) {
        try {
            // Negative pid: the whole group the detached child leads. Signalled
            // even once the child itself has been reaped, which is exactly the
            // case this is for: a wrapper that forks the real interpreter and
            // exits immediately leaves the grandchild behind. The pid number
            // stays allocated while any process still has it as its group, so
            // the signal cannot land on an unrelated group.
            process.kill(-child.pid, 'SIGKILL');
            return;
        } catch {
            // Already gone, or not permitted to signal the group: the direct
            // child is still worth killing.
        }
    }
    child.kill('SIGKILL');
}

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
 * `timeoutMs` only exists so the tests can make a hang happen quickly, and
 * `platform` so they can exercise the Windows-only shell branch.
 */
export async function findHydrustInInterpreter(
    interpreter: string,
    timeoutMs: number = INTERPRETER_LOOKUP_TIMEOUT_MS,
    platform: NodeJS.Platform = process.platform
): Promise<InterpreterLookup> {
    // `-c` puts the working directory first on sys.path, so run
    // somewhere nobody else can write: neither the workspace, where a
    // folder named `hydrust` would be imported instead of the installed
    // package, nor the shared /tmp, where any local user could plant one.
    // PYTHONSAFEPATH (3.11+) drops that entry altogether.
    let workingDir: string;
    try {
        workingDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hydrust-lookup-'));
    } catch (err) {
        logger.debug(`Could not make a directory to run ${interpreter} in: ${err}`);
        return COULD_NOT_ASK;
    }

    return new Promise<InterpreterLookup>((resolve) => {
        let settled = false;
        let stdout = '';
        let stderr = '';
        /** The answered path, kept as it arrives so later output cannot evict it. */
        let answer: string | undefined;
        /** Whatever of the current line has arrived so far. */
        let pending = '';
        /** Whatever of the current stderr line has arrived so far. */
        let stderrPending = '';
        /** Set by a traceback saying hydrust is absent from the environment. */
        let missingModule = false;
        /** Set by a traceback naming the lookup itself, so hydrust is there but broken. */
        let brokenLookup = false;

        /**
         * Log without letting a disposed channel, which throws, skip the
         * settle path that follows the line.
         */
        const logSafe = (level: 'debug' | 'warn', message: string) => {
            try {
                logger[level](message);
            } catch {
                // Losing the line must not leave the lookup unsettled.
            }
        };

        /** Latch what a line of stderr says, before later output can evict it. */
        const classify = (line: string) => {
            if (/No module named '?hydrust'?(?![\w.])/.test(line)) {
                missingModule = true;
            }
            if (/find_hydrust_bin/.test(line)) {
                brokenLookup = true;
            }
        };

        /**
         * Take a marked line as the answer, if it carries a usable one. Only
         * an absolute path is taken, so noise that happens to carry the marker
         * (a `.bat` shim without `@echo off` echoes the command line, script
         * and all) cannot claim the slot and defeat the real answer.
         */
        const noteMarked = (line: string) => {
            // The last absolute segment on the line, not the first:
            // marker-carrying noise can run into the real answer on the same
            // line, and the answer is what comes last.
            let last: string | undefined;
            let marker = line.indexOf(BINARY_LINE_PREFIX);
            while (marker >= 0) {
                // Stop at the next marker: a marked segment must not swallow
                // the segment that follows it, which may be the real answer.
                const next = line.indexOf(BINARY_LINE_PREFIX, marker + BINARY_LINE_PREFIX.length);
                const candidate = line
                    .slice(marker + BINARY_LINE_PREFIX.length, next === -1 ? undefined : next)
                    .trim();
                if (path.isAbsolute(candidate)) {
                    last = candidate;
                }
                marker = next;
            }
            if (last !== undefined) {
                answer ??= last;
            }
        };

        /**
         * Answer once, after the private working directory is gone. The
         * removal is asynchronous: on Windows a grandchild can still hold the
         * directory, and the retries that waits out must not stall the
         * extension host, which is single-threaded.
         */
        const finish = (value: InterpreterLookup) => {
            if (settled) {
                return;
            }
            settled = true;
            void fs.promises
                .rm(workingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
                // Nothing useful to do if it fails; it is an empty directory
                // in the temp dir, but a leak should be diagnosable.
                .catch((err) => {
                    logSafe('debug', `Could not remove ${workingDir}: ${err}`);
                })
                .then(() => resolve(value));
        };

        // The answer must come from the selected environment alone, so the
        // inherited import settings are dropped: PYTHONPATH is searched ahead
        // of the environment's own site-packages, so a shell that exported it
        // could otherwise make another checkout's hydrust answer. Windows
        // environment names are case-insensitive, so `Pythonpath` counts too
        // and the keys have to be compared without their case.
        const dropped = ['pythonpath', 'pythonhome'];
        const env: NodeJS.ProcessEnv = Object.fromEntries(
            Object.entries(process.env).filter(([name]) => !dropped.includes(name.toLowerCase()))
        );
        env.PYTHONIOENCODING = 'utf-8';
        env.PYTHONSAFEPATH = '1';
        // stdout is a pipe, so CPython block-buffers it and a short path would
        // sit unflushed until interpreter shutdown. Unbuffered output makes the
        // answer readable the moment it is printed, which is what lets a lookup
        // that later hangs still be salvaged.
        env.PYTHONUNBUFFERED = '1';
        const options = {
            cwd: workingDir,
            // A path is printed, so make sure a non-ASCII one survives a
            // non-UTF-8 console encoding on Windows.
            env,
            stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            // Lead a process group, so a hung shim can be killed along with
            // the interpreter it forked. Not on Windows, where the tree is
            // taken by taskkill instead.
            detached: platform !== 'win32',
        };

        let child;
        try {
            // Node refuses to spawn a .bat/.cmd directly, which is what a
            // pyenv-win shim is, so those go through the shell instead. Only
            // on Windows: elsewhere the shell is `sh`, which expands more than
            // the naive quoting below can contain, and nothing needs it.
            if (platform === 'win32' && /\.(bat|cmd)$/i.test(interpreter)) {
                if (SHELL_UNSAFE.test(interpreter)) {
                    // Only naive quoting is possible here, so a path carrying
                    // any of these could escape into command position.
                    finish(COULD_NOT_ASK);
                    logSafe('debug', `Not running ${interpreter} through a shell: its path is not safely quotable.`);
                    return;
                }
                child = spawn(`"${interpreter}" -c "${FIND_BINARY_SCRIPT}"`, { ...options, shell: true });
            } else {
                child = spawn(interpreter, ['-c', FIND_BINARY_SCRIPT], options);
            }
        } catch (err) {
            finish(COULD_NOT_ASK);
            logSafe('debug', `Could not run ${interpreter} to look for hydrust: ${err}`);
            return;
        }

        let timedOut = false;
        // An answer already read is still an answer: the interpreter may have
        // printed it and exited, with only a forked grandchild holding the
        // pipes open past the deadline.
        const timedOutResult = (): InterpreterLookup =>
            answer ? { kind: 'found', path: answer, timedOut: true } : TIMED_OUT;
        let graceTimer: NodeJS.Timeout | undefined;
        const timer = setTimeout(() => {
            timedOut = true;
            logSafe(
                'warn',
                `${interpreter} did not answer within ${timeoutMs}ms when asked where hydrust is installed. ` +
                'Looking on PATH instead.'
            );
            killTree(child, platform);
            // The tree may still hold the working directory as its cwd, so
            // answer from the `close` below once it is gone. The kill can
            // fail outright, though, so do not wait on it for long.
            graceTimer = setTimeout(() => {
                // A shim that forked the real interpreter leaves a grandchild
                // holding these pipes open, so release them now. Not above:
                // output that became readable in the same loop iteration as
                // the deadline would be thrown away before the `data` handler
                // could parse the answer out of it.
                child.stdout?.destroy();
                child.stderr?.destroy();
                // Flush a final answer without a trailing newline, the same as
                // the `close` handler, so a tree that never closes gives the
                // same result as one that does.
                noteMarked(pending);
                finish(timedOutResult());
            }, KILL_GRACE_MS).unref();
        }, timeoutMs);

        // setEncoding, not per-chunk toString: a multi-byte character split
        // across a chunk boundary must not decode to replacement characters.
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        // A pipe whose peer was just killed can fail on the read side; that
        // carries nothing the lookup needs, so swallow it rather than let it
        // surface as an uncaught exception.
        child.stdout?.on('error', () => undefined);
        child.stderr?.on('error', () => undefined);
        child.stdout?.on('data', (chunk: string) => {
            // Pick the answer out as it arrives: output from an atexit hook or
            // a .pth file, before or after it, cannot then push it out of the
            // capped buffer, which is only kept for the diagnostic log.
            stdout = (stdout + chunk).slice(-OUTPUT_LIMIT);
            const lines = (pending + chunk).split(/\r?\n/);
            pending = lines.pop() ?? '';
            if (pending.length > LINE_LIMIT) {
                // An absurdly long line is not the answer; drop it rather than
                // let it grow unbounded. A marker arriving later in the same
                // line is still read, which is no worse than one that arrived
                // intact.
                pending = '';
            }
            for (const line of lines) {
                // Anywhere in the line, not just at its start: output written
                // without a trailing newline runs straight into the answer.
                noteMarked(line);
            }
        });
        child.stderr?.on('data', (chunk: string) => {
            // Keep the tail: the useful part of a traceback is at the end.
            stderr = (stderr + chunk).slice(-OUTPUT_LIMIT);
            // Classify it as it arrives, the same as the answer on stdout:
            // output written after the traceback (an atexit warning, a noisy
            // wrapper) must not evict the evidence from the capped buffer.
            const lines = (stderrPending + chunk).split(/\r?\n/);
            stderrPending = lines.pop() ?? '';
            for (const line of lines) {
                classify(line);
            }
            if (stderrPending.length > LINE_LIMIT) {
                // Classify the runaway line once, then drop it rather than
                // rescan the same retained tail on every later chunk. The
                // regexes only ever latch a flag, so nothing is lost.
                classify(stderrPending);
                stderrPending = '';
            }
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            clearTimeout(graceTimer);
            if (timedOut) {
                // A failed kill below the timer, not a failure to run.
                // Anything already printed is still worth using, the same as
                // in `close`.
                noteMarked(pending);
                finish(timedOutResult());
                return;
            }
            logSafe('debug', `Could not run ${interpreter} to look for hydrust: ${err}`);
            finish(COULD_NOT_ASK);
        });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            clearTimeout(graceTimer);
            if (timedOut) {
                // The kill below the timer, so the exit status says nothing;
                // anything already printed is still worth using.
                noteMarked(pending);
                finish(timedOutResult());
                return;
            }
            if (code === null && signal) {
                logSafe('debug', `${interpreter} was killed by ${signal} when asked where hydrust is installed.`);
                // An answer already read is still an answer: the interpreter
                // may have printed it and only then died during teardown.
                noteMarked(pending);
                finish(answer ? { kind: 'found', path: answer } : COULD_NOT_ASK);
                return;
            }
            if (code !== 0) {
                // A last line without a trailing newline still carries evidence.
                classify(stderrPending);
                if (missingModule) {
                    logSafe('debug', `hydrust is not installed in the environment of ${interpreter}.`);
                    finish(NOT_INSTALLED);
                    return;
                }
                if (brokenLookup) {
                    logSafe(
                        'debug',
                        `${interpreter} has a hydrust that cannot say where its binary is (exit code ${code}): ` +
                        stderr.trim().slice(-OUTPUT_LIMIT)
                    );
                    finish(BROKEN_INSTALL);
                    return;
                }
                // The interpreter never got as far as answering, so the
                // environment is still unknown and worth asking about again.
                logSafe(
                    'debug',
                    `${interpreter} failed before it could say where hydrust is (exit code ${code}): ` +
                    stderr.trim().slice(-OUTPUT_LIMIT)
                );
                finish(COULD_NOT_ASK);
                return;
            }
            // A last line without a trailing newline is still an answer.
            noteMarked(pending);
            const binaryPath = answer;
            if (!binaryPath) {
                logSafe(
                    'debug',
                    `${interpreter} gave an unusable hydrust location: ` +
                    JSON.stringify(stdout.slice(-512))
                );
                // The import succeeded, so hydrust is installed; the answer was
                // just unusable. Broken rather than missing, so it is not
                // remembered against the interpreter and is asked again.
                finish(BROKEN_INSTALL);
                return;
            }
            finish({ kind: 'found', path: binaryPath });
        });
    });
}

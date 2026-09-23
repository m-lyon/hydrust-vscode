/**
 * Tests for asking a Python interpreter where its hydrust binary is.
 *
 * Two kinds of interpreter are used. Shell scripts standing in for Python pin
 * down how the answer is read: exit codes, stray output, hangs. A real
 * `python3`, when there is one, runs the actual lookup script against a
 * stand-in `hydrust` package put on PYTHONPATH, so the script itself is
 * exercised without needing the real wheel installed.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import which from 'which';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BINARY_LINE_PREFIX, findHydrustInInterpreter } from '../../src/common/pythonEnvironment';

const isWindows = process.platform === 'win32';
const python3 = which.sync('python3', { nothrow: true });

let scratchDir: string;
let savedPythonPath: string | undefined;

beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydrust-python-env-'));
    savedPythonPath = process.env.PYTHONPATH;
});

afterEach(() => {
    if (savedPythonPath === undefined) {
        delete process.env.PYTHONPATH;
    } else {
        process.env.PYTHONPATH = savedPythonPath;
    }
    fs.rmSync(scratchDir, { recursive: true, force: true });
});

/** Write an executable shell script to stand in for a Python interpreter. */
function fakeInterpreter(body: string, name: string = 'python'): string {
    const interpreter = path.join(scratchDir, name);
    fs.writeFileSync(interpreter, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return interpreter;
}

/**
 * An interpreter that runs the real python3 with a stand-in `hydrust` package
 * importable. The lookup drops any inherited PYTHONPATH, so the wrapper sets
 * it on the spawn it controls.
 */
function standInInterpreter(initBody: string): string {
    const site = path.join(scratchDir, 'site');
    fs.mkdirSync(path.join(site, 'hydrust'), { recursive: true });
    fs.writeFileSync(path.join(site, 'hydrust', '__init__.py'), initBody);
    return fakeInterpreter(`PYTHONPATH="${site}" exec "${python3}" "$@"`);
}

/** A stand-in package whose `find_hydrust_bin()` runs the given body. */
function standInFinder(findBody: string): string {
    return standInInterpreter(`def find_hydrust_bin():\n    ${findBody}\n`);
}

/** The path an interpreter reported, or undefined for any other answer. */
async function lookUpPath(interpreter: string, timeoutMs?: number): Promise<string | undefined> {
    const result = await findHydrustInInterpreter(interpreter, timeoutMs);
    return result.kind === 'found' ? result.path : undefined;
}

/** The working directories lookups make, so a test can tell one was left behind. */
function lookupDirs(): string[] {
    return fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith('hydrust-lookup-')).sort();
}

describe.skipIf(isWindows)('reading the interpreter\'s answer', () => {
    it('returns the path it prints', async () => {
        const interpreter = fakeInterpreter(`echo ${BINARY_LINE_PREFIX}/venv/bin/hydrust`);

        expect(await lookUpPath(interpreter)).toBe('/venv/bin/hydrust');
    });

    it('ignores output printed before and after the answer', async () => {
        const interpreter = fakeInterpreter(
            `echo "hello from sitecustomize"\necho ${BINARY_LINE_PREFIX}/venv/bin/hydrust\necho "goodbye from atexit"`
        );

        expect(await lookUpPath(interpreter)).toBe('/venv/bin/hydrust');
    });

    it('keeps the answer when more than the buffer is printed after it', async () => {
        const interpreter = fakeInterpreter(
            `echo ${BINARY_LINE_PREFIX}/venv/bin/hydrust\nawk 'BEGIN { for (i = 0; i < 200; i++) print "noisy shutdown warning" }'`
        );

        expect(await lookUpPath(interpreter)).toBe('/venv/bin/hydrust');
    });

    it('keeps a deeply nested path longer than the output buffer', async () => {
        // Arrives unterminated, so the line buffer holds far more than the
        // diagnostic cap before the newline that completes the answer.
        const interpreter = fakeInterpreter(
            `long=$(awk 'BEGIN { while (length(s) < 5000) s = s "a"; print s }')\n`
            + `printf '%s' "junk-$long"; sleep 0.2; printf '\\n'\n`
            + `printf '%s' "${BINARY_LINE_PREFIX}/venv/$long"; sleep 0.2; printf '/bin/hydrust\\n'`
        );

        expect(await lookUpPath(interpreter)).toBe(`/venv/${'a'.repeat(5000)}/bin/hydrust`);
    });

    it('keeps the answer after a runaway line longer than the line cap', async () => {
        // Over 64 KB with no newline, so the line buffer is dropped before the
        // answer that follows it arrives.
        const interpreter = fakeInterpreter(
            `awk 'BEGIN { s = "junk"; while (length(s) < 70000) s = s s; printf "%s", s }'; sleep 0.2\n`
            + `echo\necho ${BINARY_LINE_PREFIX}/venv/bin/hydrust`
        );

        expect(await lookUpPath(interpreter)).toBe('/venv/bin/hydrust');
    });

    it('ignores an unmarked absolute path printed after the answer', async () => {
        const interpreter = fakeInterpreter(`echo ${BINARY_LINE_PREFIX}/venv/bin/hydrust\necho /tmp/not-the-server`);

        expect(await lookUpPath(interpreter)).toBe('/venv/bin/hydrust');
    });

    it('rejects a path printed without the marker', async () => {
        const interpreter = fakeInterpreter('echo /venv/bin/hydrust');

        expect(await findHydrustInInterpreter(interpreter)).toEqual({ kind: 'notInstalled' });
    });

    it('rejects a relative path', async () => {
        const interpreter = fakeInterpreter(`echo ${BINARY_LINE_PREFIX}bin/hydrust`);

        expect(await findHydrustInInterpreter(interpreter)).toEqual({ kind: 'notInstalled' });
    });

    it('rejects empty output', async () => {
        const interpreter = fakeInterpreter('true');

        expect(await findHydrustInInterpreter(interpreter)).toEqual({ kind: 'notInstalled' });
    });

    it('treats a non-zero exit as not found, even with a path on stdout', async () => {
        const interpreter = fakeInterpreter(`echo ${BINARY_LINE_PREFIX}/venv/bin/hydrust\necho "ModuleNotFoundError: No module named 'hydrust'" >&2\nexit 1`);

        const before = lookupDirs();
        expect(await findHydrustInInterpreter(interpreter)).toEqual({ kind: 'notInstalled' });
        expect(lookupDirs()).toEqual(before);
    });

    it('keeps the first marked line when another is printed after it', async () => {
        const interpreter = fakeInterpreter(
            `echo ${BINARY_LINE_PREFIX}/venv/bin/hydrust\necho ${BINARY_LINE_PREFIX}/tmp/not-the-server`
        );

        expect(await lookUpPath(interpreter)).toBe('/venv/bin/hydrust');
    });

    it('is one that could not be asked when it fails before answering', async () => {
        const interpreter = fakeInterpreter('echo "ImportError: bad sitecustomize" >&2\nexit 1');

        expect(await findHydrustInInterpreter(interpreter)).toEqual({ kind: 'couldNotAsk' });
    });

    it('is one that could not be asked when it dies from a signal', async () => {
        const interpreter = fakeInterpreter('kill -9 $$');

        expect(await findHydrustInInterpreter(interpreter)).toEqual({ kind: 'couldNotAsk' });
    });

    it('gives up on an interpreter that does not answer in time', async () => {
        const interpreter = fakeInterpreter(`sleep 10\necho ${BINARY_LINE_PREFIX}/venv/bin/hydrust`);

        const before = lookupDirs();
        const started = Date.now();
        expect(await findHydrustInInterpreter(interpreter, 200)).toEqual({ kind: 'couldNotAsk', timedOut: true });
        expect(Date.now() - started).toBeLessThan(5000);
        expect(lookupDirs()).toEqual(before);
    });

    it('runs in a private directory, so nothing else can be first on sys.path', async () => {
        const interpreter = fakeInterpreter(`echo "${BINARY_LINE_PREFIX}$(pwd)"`);

        const answer = await lookUpPath(interpreter);

        expect(answer).toBeDefined();
        expect(path.dirname(answer!)).toBe(fs.realpathSync(os.tmpdir()));
        expect(path.basename(answer!)).toMatch(/^hydrust-lookup-/);
    });

    it('cleans up the directory it ran in', async () => {
        const interpreter = fakeInterpreter(`echo "${BINARY_LINE_PREFIX}$(pwd)"`);

        const answer = await lookUpPath(interpreter);

        expect(fs.existsSync(answer!)).toBe(false);
    });

    it('finds the answer when something without a newline runs into it', async () => {
        const interpreter = fakeInterpreter(`printf 'progress...'\necho ${BINARY_LINE_PREFIX}/venv/bin/hydrust`);

        expect(await lookUpPath(interpreter)).toBe('/venv/bin/hydrust');
    });

    it('runs a .cmd shim through a shell with the script intact', async () => {
        // The branch is picked by the filename, not the platform, so a POSIX
        // shell can pin down that the embedded script survives quoting.
        const interpreter = fakeInterpreter(
            `[ "$#" -eq 2 ] || exit 1\n[ "$1" = "-c" ] || exit 1\n`
            + `case "$2" in *find_hydrust_bin*) ;; *) exit 1 ;; esac\n`
            + `echo ${BINARY_LINE_PREFIX}/venv/bin/hydrust`,
            'python.cmd'
        );

        expect(await lookUpPath(interpreter)).toBe('/venv/bin/hydrust');
    });

    it('refuses a shell branch for a path that cannot be safely quoted', async () => {
        const interpreter = fakeInterpreter(
            `echo ${BINARY_LINE_PREFIX}/venv/bin/hydrust`,
            'py" & echo pwned & rem .cmd'
        );

        expect(await findHydrustInInterpreter(interpreter)).toEqual({ kind: 'couldNotAsk' });
    });

    it('ignores marker-carrying noise printed before the answer', async () => {
        // A shim without `@echo off` echoes the command line, script and all.
        const interpreter = fakeInterpreter(
            `echo "C:\\py.exe -c print('${BINARY_LINE_PREFIX}' + x)"\necho ${BINARY_LINE_PREFIX}/venv/bin/hydrust`
        );

        expect(await lookUpPath(interpreter)).toBe('/venv/bin/hydrust');
    });

    it('keeps a multi-byte character split across chunks intact', async () => {
        // Printed a byte at a time, so the two-byte 'ø' straddles a chunk boundary.
        const interpreter = fakeInterpreter(
            `printf '${BINARY_LINE_PREFIX}/venv/pr' ; sleep 0.2 ; printf '\\303' ; sleep 0.2 ; printf '\\270ject/hydrust\\n'`
        );

        expect(await lookUpPath(interpreter)).toBe('/venv/prøject/hydrust');
    });
});

describe('an interpreter that cannot be run', () => {
    it('is reported as one that could not be asked, not as an empty environment', async () => {
        const before = lookupDirs();

        expect(await findHydrustInInterpreter(path.join(scratchDir, 'no-such-python')))
            .toEqual({ kind: 'couldNotAsk' });
        expect(lookupDirs()).toEqual(before);
    });
});

describe.skipIf(!python3 || isWindows)('the lookup script, run by a real python3', () => {
    it('returns what find_hydrust_bin() returns', async () => {
        const binary = path.join(scratchDir, 'bin', 'hydrust');

        expect(await lookUpPath(standInFinder(`return ${JSON.stringify(binary)}`))).toBe(binary);
    });

    it('is not found when the hydrust package is not installed', async () => {
        // `-S` skips site-packages, so a hydrust installed on the machine
        // running the tests cannot leak in.
        delete process.env.PYTHONPATH;
        const interpreter = fakeInterpreter(`exec "${python3}" -S "$@"`);

        expect(await lookUpPath(interpreter)).toBeUndefined();
    });

    it('is not found when find_hydrust_bin() raises', async () => {
        const interpreter = standInFinder('raise FileNotFoundError("/venv/bin/hydrust")');

        expect(await lookUpPath(interpreter)).toBeUndefined();
    });

    it('ignores a hydrust that only an inherited PYTHONPATH would find', async () => {
        const site = path.join(scratchDir, 'other-site');
        fs.mkdirSync(path.join(site, 'hydrust'), { recursive: true });
        fs.writeFileSync(
            path.join(site, 'hydrust', '__init__.py'),
            'def find_hydrust_bin():\n    return "/other/bin/hydrust"\n'
        );
        process.env.PYTHONPATH = site;
        const interpreter = fakeInterpreter(`exec "${python3}" "$@"`);

        expect(await lookUpPath(interpreter)).toBeUndefined();
    });

    it('is not found for a hydrust package without find_hydrust_bin()', async () => {
        expect(await lookUpPath(standInInterpreter(''))).toBeUndefined();
    });

    it('keeps a non-ASCII path intact', async () => {
        const binary = path.join(scratchDir, 'prøject', 'bin', 'hydrust');

        expect(await lookUpPath(standInFinder(`return ${JSON.stringify(binary)}`))).toBe(binary);
    });
});

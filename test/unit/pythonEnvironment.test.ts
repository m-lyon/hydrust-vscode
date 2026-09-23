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
function fakeInterpreter(body: string): string {
    const interpreter = path.join(scratchDir, 'python');
    fs.writeFileSync(interpreter, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return interpreter;
}

/**
 * Put a stand-in `hydrust` package on PYTHONPATH whose `find_hydrust_bin()`
 * runs the given body.
 */
function installStandInPackage(findBody: string): void {
    const site = path.join(scratchDir, 'site');
    fs.mkdirSync(path.join(site, 'hydrust'), { recursive: true });
    fs.writeFileSync(
        path.join(site, 'hydrust', '__init__.py'),
        `def find_hydrust_bin():\n    ${findBody}\n`
    );
    process.env.PYTHONPATH = site;
}

/** The working directories lookups make, so a test can tell one was left behind. */
function lookupDirs(): string[] {
    return fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith('hydrust-lookup-')).sort();
}

describe.skipIf(isWindows)('reading the interpreter\'s answer', () => {
    it('returns the path it prints', async () => {
        const interpreter = fakeInterpreter(`echo ${BINARY_LINE_PREFIX}/venv/bin/hydrust`);

        expect(await findHydrustInInterpreter(interpreter)).toBe('/venv/bin/hydrust');
    });

    it('ignores output printed before and after the answer', async () => {
        const interpreter = fakeInterpreter(
            `echo "hello from sitecustomize"\necho ${BINARY_LINE_PREFIX}/venv/bin/hydrust\necho "goodbye from atexit"`
        );

        expect(await findHydrustInInterpreter(interpreter)).toBe('/venv/bin/hydrust');
    });

    it('keeps the answer when more than the buffer is printed after it', async () => {
        const interpreter = fakeInterpreter(
            `echo ${BINARY_LINE_PREFIX}/venv/bin/hydrust\nawk 'BEGIN { for (i = 0; i < 200; i++) print "noisy shutdown warning" }'`
        );

        expect(await findHydrustInInterpreter(interpreter)).toBe('/venv/bin/hydrust');
    });

    it('keeps a deeply nested path longer than the output buffer', async () => {
        // Arrives unterminated, so the line buffer holds far more than the
        // diagnostic cap before the newline that completes the answer.
        const interpreter = fakeInterpreter(
            `long=$(awk 'BEGIN { while (length(s) < 5000) s = s "a"; print s }')\n`
            + `printf '%s' "junk-$long"; sleep 0.2; printf '\\n'\n`
            + `printf '%s' "${BINARY_LINE_PREFIX}/venv/$long"; sleep 0.2; printf '/bin/hydrust\\n'`
        );

        expect(await findHydrustInInterpreter(interpreter)).toBe(`/venv/${'a'.repeat(5000)}/bin/hydrust`);
    });

    it('ignores an unmarked absolute path printed after the answer', async () => {
        const interpreter = fakeInterpreter(`echo ${BINARY_LINE_PREFIX}/venv/bin/hydrust\necho /tmp/not-the-server`);

        expect(await findHydrustInInterpreter(interpreter)).toBe('/venv/bin/hydrust');
    });

    it('rejects a path printed without the marker', async () => {
        const interpreter = fakeInterpreter('echo /venv/bin/hydrust');

        expect(await findHydrustInInterpreter(interpreter)).toBeUndefined();
    });

    it('rejects a relative path', async () => {
        const interpreter = fakeInterpreter(`echo ${BINARY_LINE_PREFIX}bin/hydrust`);

        expect(await findHydrustInInterpreter(interpreter)).toBeUndefined();
    });

    it('rejects empty output', async () => {
        const interpreter = fakeInterpreter('true');

        expect(await findHydrustInInterpreter(interpreter)).toBeUndefined();
    });

    it('treats a non-zero exit as not found, even with a path on stdout', async () => {
        const interpreter = fakeInterpreter(`echo ${BINARY_LINE_PREFIX}/venv/bin/hydrust\necho "ModuleNotFoundError: No module named 'hydrust'" >&2\nexit 1`);

        expect(await findHydrustInInterpreter(interpreter)).toBeUndefined();
    });

    it('gives up on an interpreter that does not answer in time', async () => {
        const interpreter = fakeInterpreter(`sleep 10\necho ${BINARY_LINE_PREFIX}/venv/bin/hydrust`);

        const before = lookupDirs();
        const started = Date.now();
        expect(await findHydrustInInterpreter(interpreter, 200)).toBeUndefined();
        expect(Date.now() - started).toBeLessThan(5000);
        expect(lookupDirs()).toEqual(before);
    });

    it('runs in a private directory, so nothing else can be first on sys.path', async () => {
        const interpreter = fakeInterpreter(`echo "${BINARY_LINE_PREFIX}$(pwd)"`);

        const answer = await findHydrustInInterpreter(interpreter);

        expect(answer).toBeDefined();
        expect(path.dirname(answer!)).toBe(fs.realpathSync(os.tmpdir()));
        expect(path.basename(answer!)).toMatch(/^hydrust-lookup-/);
    });

    it('cleans up the directory it ran in', async () => {
        const interpreter = fakeInterpreter(`echo "${BINARY_LINE_PREFIX}$(pwd)"`);

        const answer = await findHydrustInInterpreter(interpreter);

        expect(fs.existsSync(answer!)).toBe(false);
    });

    it('keeps a multi-byte character split across chunks intact', async () => {
        // Printed a byte at a time, so the two-byte 'ø' straddles a chunk boundary.
        const interpreter = fakeInterpreter(
            `printf '${BINARY_LINE_PREFIX}/venv/pr' ; sleep 0.2 ; printf '\\303' ; sleep 0.2 ; printf '\\270ject/hydrust\\n'`
        );

        expect(await findHydrustInInterpreter(interpreter)).toBe('/venv/prøject/hydrust');
    });
});

describe('an interpreter that cannot be run', () => {
    it('is treated as not found', async () => {
        expect(await findHydrustInInterpreter(path.join(scratchDir, 'no-such-python'))).toBeUndefined();
    });
});

describe.skipIf(!python3)('the lookup script, run by a real python3', () => {
    it('returns what find_hydrust_bin() returns', async () => {
        const binary = path.join(scratchDir, 'bin', 'hydrust');
        installStandInPackage(`return ${JSON.stringify(binary)}`);

        expect(await findHydrustInInterpreter(python3!)).toBe(binary);
    });

    it.skipIf(isWindows)('is not found when the hydrust package is not installed', async () => {
        // `-S` skips site-packages, so a hydrust installed on the machine
        // running the tests cannot leak in.
        delete process.env.PYTHONPATH;
        const interpreter = fakeInterpreter(`exec "${python3}" -S "$@"`);

        expect(await findHydrustInInterpreter(interpreter)).toBeUndefined();
    });

    it('is not found when find_hydrust_bin() raises', async () => {
        installStandInPackage('raise FileNotFoundError("/venv/bin/hydrust")');

        expect(await findHydrustInInterpreter(python3!)).toBeUndefined();
    });

    it('is not found for a hydrust package without find_hydrust_bin()', async () => {
        const site = path.join(scratchDir, 'site');
        fs.mkdirSync(path.join(site, 'hydrust'), { recursive: true });
        fs.writeFileSync(path.join(site, 'hydrust', '__init__.py'), '');
        process.env.PYTHONPATH = site;

        expect(await findHydrustInInterpreter(python3!)).toBeUndefined();
    });

    it('keeps a non-ASCII path intact', async () => {
        const binary = path.join(scratchDir, 'prøject', 'bin', 'hydrust');
        installStandInPackage(`return ${JSON.stringify(binary)}`);

        expect(await findHydrustInInterpreter(python3!)).toBe(binary);
    });
});

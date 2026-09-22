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
import { findHydrustInInterpreter } from '../../src/common/pythonEnvironment';

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

describe.skipIf(isWindows)('reading the interpreter\'s answer', () => {
    it('returns the path it prints', async () => {
        const interpreter = fakeInterpreter('echo /venv/bin/hydrust');

        expect(await findHydrustInInterpreter(interpreter)).toBe('/venv/bin/hydrust');
    });

    it('takes the last line when something else prints first', async () => {
        const interpreter = fakeInterpreter('echo "hello from sitecustomize"\necho /venv/bin/hydrust');

        expect(await findHydrustInInterpreter(interpreter)).toBe('/venv/bin/hydrust');
    });

    it('rejects a relative path', async () => {
        const interpreter = fakeInterpreter('echo bin/hydrust');

        expect(await findHydrustInInterpreter(interpreter)).toBeUndefined();
    });

    it('rejects empty output', async () => {
        const interpreter = fakeInterpreter('true');

        expect(await findHydrustInInterpreter(interpreter)).toBeUndefined();
    });

    it('treats a non-zero exit as not found, even with a path on stdout', async () => {
        const interpreter = fakeInterpreter('echo /venv/bin/hydrust\necho "ModuleNotFoundError: No module named \'hydrust\'" >&2\nexit 1');

        expect(await findHydrustInInterpreter(interpreter)).toBeUndefined();
    });

    it('gives up on an interpreter that does not answer in time', async () => {
        const interpreter = fakeInterpreter('sleep 10\necho /venv/bin/hydrust');

        const started = Date.now();
        expect(await findHydrustInInterpreter(interpreter, 200)).toBeUndefined();
        expect(Date.now() - started).toBeLessThan(5000);
    });

    it('does not run in the workspace, so a hydrust folder there cannot be imported instead', async () => {
        const interpreter = fakeInterpreter('pwd');

        const answer = await findHydrustInInterpreter(interpreter);

        expect(answer && fs.realpathSync(answer)).toBe(fs.realpathSync(os.tmpdir()));
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

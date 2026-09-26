/**
 * Tests for asking a Python interpreter where its hydrust binary is.
 *
 * Shell scripts standing in for Python pin down how the answer is read. A real
 * `python3`, when there is one, runs the lookup script against a stand-in
 * `hydrust` package, so the script itself is exercised without the real wheel.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import which from 'which';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findHydrustInInterpreter } from '../../src/common/pythonEnvironment';

const isWindows = process.platform === 'win32';
const python3 = which.sync('python3', { nothrow: true });
const extensionRoot = path.resolve(__dirname, '../..');

let scratchDir: string;

beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydrust-python-env-'));
});

afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
});

/** Write an executable shell script to stand in for a Python interpreter. */
function fakeInterpreter(body: string): string {
    const interpreter = path.join(scratchDir, 'python');
    fs.writeFileSync(interpreter, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return interpreter;
}

/** The real python3 with a stand-in `hydrust` package whose `__init__.py` is `initBody`. */
function standInInterpreter(initBody: string): string {
    const site = path.join(scratchDir, 'site');
    fs.mkdirSync(path.join(site, 'hydrust'), { recursive: true });
    fs.writeFileSync(path.join(site, 'hydrust', '__init__.py'), initBody);
    return fakeInterpreter(`PYTHONPATH="${site}" exec "${python3}" "$@"`);
}

describe.skipIf(isWindows)('reading the interpreter\'s answer', () => {
    it('returns the path it prints', async () => {
        const interpreter = fakeInterpreter('echo /venv/bin/hydrust');

        expect(await findHydrustInInterpreter(interpreter, extensionRoot)).toBe('/venv/bin/hydrust');
    });

    it('takes the last line, after anything a sitecustomize printed', async () => {
        const interpreter = fakeInterpreter('echo "hello from sitecustomize"\necho /venv/bin/hydrust');

        expect(await findHydrustInInterpreter(interpreter, extensionRoot)).toBe('/venv/bin/hydrust');
    });

    it('treats no output as not installed', async () => {
        const interpreter = fakeInterpreter('exit 0');

        expect(await findHydrustInInterpreter(interpreter, extensionRoot)).toBeUndefined();
    });

    it('ignores a relative path', async () => {
        const interpreter = fakeInterpreter('echo bin/hydrust');

        expect(await findHydrustInInterpreter(interpreter, extensionRoot)).toBeUndefined();
    });

    it('gives nothing when the interpreter fails', async () => {
        const interpreter = fakeInterpreter('echo /venv/bin/hydrust\nexit 1');

        expect(await findHydrustInInterpreter(interpreter, extensionRoot)).toBeUndefined();
    });

    it('gives nothing when the interpreter does not exist', async () => {
        expect(await findHydrustInInterpreter(path.join(scratchDir, 'missing'), extensionRoot)).toBeUndefined();
    });

    it('gives up on an interpreter that hangs', async () => {
        const interpreter = fakeInterpreter('sleep 10');

        expect(await findHydrustInInterpreter(interpreter, extensionRoot, 200)).toBeUndefined();
    });
});

describe.skipIf(isWindows || !python3)('the lookup script', () => {
    it('prints what find_hydrust_bin() returns', async () => {
        const interpreter = standInInterpreter('def find_hydrust_bin():\n    return "/venv/bin/hydrust"\n');

        expect(await findHydrustInInterpreter(interpreter, extensionRoot)).toBe('/venv/bin/hydrust');
    });

    it('keeps a non-ASCII path intact', async () => {
        const interpreter = standInInterpreter('def find_hydrust_bin():\n    return "/vénv/bin/hydrust"\n');

        expect(await findHydrustInInterpreter(interpreter, extensionRoot)).toBe('/vénv/bin/hydrust');
    });

    it('prints nothing when hydrust is not installed', async () => {
        const interpreter = fakeInterpreter(`exec "${python3}" -S "$@"`);

        expect(await findHydrustInInterpreter(interpreter, extensionRoot)).toBeUndefined();
    });

    it('gives nothing when find_hydrust_bin() raises', async () => {
        const interpreter = standInInterpreter('def find_hydrust_bin():\n    raise FileNotFoundError("hydrust")\n');

        expect(await findHydrustInInterpreter(interpreter, extensionRoot)).toBeUndefined();
    });

    it('imports the installed package, not a hydrust folder in the working directory', async () => {
        const interpreter = standInInterpreter('def find_hydrust_bin():\n    return "/venv/bin/hydrust"\n');
        const workspace = path.join(scratchDir, 'workspace');
        fs.mkdirSync(path.join(workspace, 'hydrust'), { recursive: true });
        fs.writeFileSync(
            path.join(workspace, 'hydrust', '__init__.py'),
            'def find_hydrust_bin():\n    return "/workspace/impostor"\n'
        );
        const cwd = process.cwd();
        process.chdir(workspace);
        try {
            expect(await findHydrustInInterpreter(interpreter, extensionRoot)).toBe('/venv/bin/hydrust');
        } finally {
            process.chdir(cwd);
        }
    });
});

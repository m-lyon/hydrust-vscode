/**
 * Tests for resolving which server release to use and which binary on disk it
 * corresponds to.
 *
 * Both questions are answered before anything has been launched, so they can
 * only come from the version table. The interesting cases are all around the
 * rename: a releases list holding both namings, and a `bundled/libs` tree
 * holding an install from either side of it.
 *
 * The GitHub API is replaced with a recording stub, and every scenario leaves
 * the expected executable already on disk so nothing is ever downloaded.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** What the stubbed GitHub API should answer with, and what it was asked. */
const httpsStub = vi.hoisted(() => ({
    /** Response body, already serialised. */
    body: '[]',
    /** Status code the response carries. */
    statusCode: 200,
    /** The request paths, oldest first. */
    paths: [] as string[],
}));

vi.mock('https', async () => {
    const { EventEmitter } = await import('events');

    const get = (options: unknown, callback: (response: unknown) => void) => {
        httpsStub.paths.push(
            typeof options === 'string' ? options : String((options as { path?: string }).path)
        );

        const response: InstanceType<typeof EventEmitter> & { statusCode?: number } = new EventEmitter();
        response.statusCode = httpsStub.statusCode;

        // Answer on a later tick, so the caller has chained its .on('error')
        // handler before anything is emitted.
        setImmediate(() => {
            callback(response);
            response.emit('data', httpsStub.body);
            response.emit('end');
        });

        return new EventEmitter();
    };

    return { default: { get }, get };
});

import { ensureServer, findExistingExecutable } from '../../src/common/download';
import { getExecutablePath, getPlatformInfo } from '../../src/common/constants';
import { createStubExtensionContext, resetVscodeStub } from '../stubs/vscode';

const platformInfo = getPlatformInfo();

let scratchDir: string;
let context: ReturnType<typeof createStubExtensionContext>;

/** Cast the stub context to the type the production code asks for. */
function asExtensionContext(value: unknown): vscode.ExtensionContext {
    return value as vscode.ExtensionContext;
}

/** Put a stand-in executable where a given release would have extracted one. */
function installVersion(version: string): string {
    const executablePath = getExecutablePath(context, version);
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.writeFileSync(executablePath, 'not a program');
    return executablePath;
}

/** One GitHub release, with only the fields the resolver reads. */
function release(tag: string, assetNames: string[]): unknown {
    return { tag_name: tag, assets: assetNames.map((name) => ({ name })) };
}

/** The asset name a release of this version publishes for this platform. */
function assetFor(baseName: string): string {
    return `${baseName}-${platformInfo.platform}.${platformInfo.archiveExt}`;
}

beforeEach(() => {
    resetVscodeStub();
    httpsStub.body = '[]';
    httpsStub.statusCode = 200;
    httpsStub.paths = [];
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydrust-download-'));
    context = createStubExtensionContext(scratchDir);
});

afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
});

describe('resolving the latest release', () => {
    it('takes the newest release named the new way', async () => {
        httpsStub.body = JSON.stringify([
            release('v0.5.0', [assetFor('hydrust'), `${assetFor('hydrust')}.sha256`]),
            release('v0.4.0', [assetFor('hydra-lsp')]),
        ]);
        installVersion('v0.5.0');

        const installed = await ensureServer('latest', asExtensionContext(context));

        expect(installed.version).toBe('v0.5.0');
        expect(path.basename(installed.path)).toBe(`hydrust${platformInfo.executableSuffix}`);
        expect(httpsStub.paths).toEqual(['/repos/m-lyon/hydra-lsp/releases']);
    });

    it('still finds a release named the old way when that is all there is', async () => {
        httpsStub.body = JSON.stringify([
            release('v0.4.0', [assetFor('hydra-lsp')]),
            release('v0.3.0', [assetFor('hydra-lsp')]),
        ]);
        installVersion('v0.4.0');

        const installed = await ensureServer('latest', asExtensionContext(context));

        expect(installed.version).toBe('v0.4.0');
        expect(path.basename(installed.path)).toBe(`hydra-lsp${platformInfo.executableSuffix}`);
    });

    it('skips a release that carries neither name', async () => {
        // Source-only releases, or a build that failed for this platform.
        httpsStub.body = JSON.stringify([
            release('v0.6.0', ['hydrust-some-other-target.tar.xz']),
            release('v0.4.0', [assetFor('hydra-lsp')]),
        ]);
        installVersion('v0.4.0');

        const installed = await ensureServer('latest', asExtensionContext(context));

        expect(installed.version).toBe('v0.4.0');
    });

    it('says what it was looking for when no release matches', async () => {
        httpsStub.body = JSON.stringify([release('v0.4.0', ['hydra-lsp-some-other-target.tar.xz'])]);

        await expect(ensureServer('latest', asExtensionContext(context))).rejects.toThrow(
            /No release found with an asset matching .*hydrust-.*hydra-lsp-/
        );
    });

    it('does not ask GitHub anything when the version is pinned', async () => {
        installVersion('v0.4.0');

        const installed = await ensureServer('0.4.0', asExtensionContext(context));

        expect(installed.version).toBe('v0.4.0');
        expect(httpsStub.paths).toEqual([]);
    });
});

describe('finding a previously installed binary', () => {
    it('picks the newest across installs from either side of the rename', async () => {
        installVersion('v0.4.0');
        const newer = installVersion('v0.5.0');

        const found = await findExistingExecutable(asExtensionContext(context));

        expect(found).toEqual({ path: newer, version: 'v0.5.0' });
    });

    it('falls back to the older install when it is the only complete one', async () => {
        const older = installVersion('v0.4.0');
        // A directory left half-extracted: the version directory is there but
        // the executable never landed.
        fs.mkdirSync(path.dirname(getExecutablePath(context, 'v0.5.0')), { recursive: true });

        const found = await findExistingExecutable(asExtensionContext(context));

        expect(found).toEqual({ path: older, version: 'v0.4.0' });
    });

    it('ignores an executable filed under a version that does not name it that way', async () => {
        // A v0.6.0 directory holding a `hydra-lsp` binary is not something the
        // extension ever writes, and running it would mean launching a
        // pre-subcommand server with `server` on its command line.
        installVersion('v0.4.0');
        const strayDir = path.join(scratchDir, 'bundled', 'libs', '0.6.0', `hydra-lsp-${platformInfo.platform}`);
        fs.mkdirSync(strayDir, { recursive: true });
        fs.writeFileSync(path.join(strayDir, 'hydra-lsp'), 'not a program');

        const found = await findExistingExecutable(asExtensionContext(context));

        expect(found?.version).toBe('v0.4.0');
    });

    it('finds nothing when there is nothing to find', async () => {
        expect(await findExistingExecutable(asExtensionContext(context))).toBeUndefined();
    });
});

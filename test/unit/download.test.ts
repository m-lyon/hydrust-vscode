/**
 * Tests for how the downloaded server is found, resolved and installed.
 *
 * `https` is replaced with a routing stub so each test decides exactly what
 * GitHub answers, including outright failures, and can check which requests
 * were made. Archives are real tar.xz files so the extraction path runs too.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type * as vscode from 'vscode';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface Reply {
    status: number;
    headers?: Record<string, string>;
    body?: string | Buffer;
}

/** A URL either gets a fixed reply, a reply built from the request, or a connection error. */
type Route = Reply | ((headers: Record<string, string>) => Reply) | 'network-error';

const net = vi.hoisted(() => ({
    routes: new Map<string, unknown>(),
    calls: [] as { method: string; url: string; headers: Record<string, string> }[],
}));

vi.mock('https', async () => {
    const { EventEmitter } = await import('events');
    const { Readable } = await import('stream');

    function request(
        url: string,
        options: { method?: string; headers?: Record<string, string> },
        callback: (response: unknown) => void
    ) {
        const req = Object.assign(new EventEmitter(), {
            destroy: (err: Error) => setImmediate(() => req.emit('error', err)),
            end: () =>
                setImmediate(() => {
                    const method = options.method ?? 'GET';
                    const headers = options.headers ?? {};
                    net.calls.push({ method, url, headers });
                    const route = net.routes.get(url) as Route | undefined;
                    if (route === undefined || route === 'network-error') {
                        req.emit('error', new Error(`connect ECONNREFUSED (${url})`));
                        return;
                    }
                    const reply = typeof route === 'function' ? route(headers) : route;
                    const chunks = method === 'HEAD' || reply.body === undefined ? [] : [Buffer.from(reply.body)];
                    const response = Object.assign(Readable.from(chunks), {
                        statusCode: reply.status,
                        statusMessage: '',
                        headers: reply.headers ?? {},
                    });
                    callback(response);
                }),
        });
        return req;
    }

    return { request, default: { request } };
});

import {
    API_BACKOFF_KEY,
    API_ETAG_CACHE_KEY,
    LATEST_TAG_CACHE_KEY,
    LATEST_TAG_TTL_MS,
    MIN_API_BACKOFF_MS,
    STALE_STAGING_MS,
    ensureServer,
    rateLimitRetryTime,
} from '../../src/common/download';
import {
    FALLBACK_SERVER_VERSION,
    getArchiveDirectoryName,
    getDownloadUrl,
    getExecutablePath,
    getLibsRoot,
    getPlatformInfo,
} from '../../src/common/constants';
import { PLATFORM_ASSETS, pickPinnableRelease, rewritePin } from '../../scripts/pin-server-version.mjs';
import { createStubExtensionContext, resetVscodeStub, stub } from '../stubs/vscode';

const RELEASES_PAGE = 'https://github.com/m-lyon/hydra-lsp/releases/latest';
const RELEASES_API = 'https://api.github.com/repos/m-lyon/hydra-lsp/releases';

let scratchDir: string;
let context: ReturnType<typeof createStubExtensionContext>;
let archive: Buffer;

function asExtensionContext(value: unknown): vscode.ExtensionContext {
    return value as vscode.ExtensionContext;
}

function ensure(version = 'latest') {
    return ensureServer(version, asExtensionContext(context));
}

function assetUrl(tag: string): string {
    return getDownloadUrl(tag, getPlatformInfo());
}

function assetName(): string {
    const info = getPlatformInfo();
    return `${getArchiveDirectoryName(info)}.${info.archiveExt}`;
}

function redirectTo(tag: string): Reply {
    return { status: 302, headers: { location: `https://github.com/m-lyon/hydra-lsp/releases/tag/${tag}` } };
}

/** Make GitHub serve a working archive and checksum for a release. */
function publishRelease(tag: string, checksum = crypto.createHash('sha256').update(archive).digest('hex')): void {
    net.routes.set(assetUrl(tag), { status: 200, body: archive });
    net.routes.set(`${assetUrl(tag)}.sha256`, { status: 200, body: `${checksum}  ${assetName()}\n` });
}

/** Put a binary on disk as if a release had been installed earlier. */
function installOnDisk(tag: string): string {
    const executable = getExecutablePath(context, tag);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, 'installed');
    return executable;
}

function requested(url: string): number {
    return net.calls.filter((call) => call.url === url).length;
}

beforeAll(() => {
    // A real archive with the layout releases use, so extraction is exercised.
    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydrust-archive-'));
    const info = getPlatformInfo();
    const inner = path.join(buildDir, getArchiveDirectoryName(info));
    fs.mkdirSync(inner);
    fs.writeFileSync(path.join(inner, info.executableName), '#!/bin/sh\n');
    const archivePath = path.join(buildDir, 'server.tar.xz');
    execFileSync('tar', ['-cJf', archivePath, '-C', buildDir, getArchiveDirectoryName(info)]);
    archive = fs.readFileSync(archivePath);
    fs.rmSync(buildDir, { recursive: true, force: true });
});

beforeEach(() => {
    resetVscodeStub();
    net.routes.clear();
    net.calls = [];
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydrust-download-'));
    context = createStubExtensionContext(scratchDir);
});

afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
});

afterAll(() => {
    vi.restoreAllMocks();
});

describe.skipIf(process.platform === 'win32')('ensureServer', () => {
    it('keeps downloads in global storage, which survives extension updates', () => {
        expect(getLibsRoot(context)).toBe(path.join(context.globalStorageUri.fsPath, 'libs'));
        expect(getLibsRoot(context).startsWith(path.join(scratchDir, 'globalStorage'))).toBe(true);
    });

    it('makes no requests when the latest tag was resolved recently and is installed', async () => {
        const executable = installOnDisk('v0.4.0');
        stub.globalState.set(LATEST_TAG_CACHE_KEY, { tag: 'v0.4.0', checkedAt: Date.now() - 60_000 });

        await expect(ensure()).resolves.toEqual({ path: executable, version: 'v0.4.0' });
        expect(net.calls).toEqual([]);
    });

    it('resolves latest from the releases page redirect, not the API, once the cache is stale', async () => {
        const executable = installOnDisk('v0.4.2');
        stub.globalState.set(LATEST_TAG_CACHE_KEY, { tag: 'v0.4.0', checkedAt: Date.now() - LATEST_TAG_TTL_MS - 1 });
        net.routes.set(RELEASES_PAGE, redirectTo('v0.4.2'));

        await expect(ensure()).resolves.toEqual({ path: executable, version: 'v0.4.2' });
        expect(net.calls.map((call) => `${call.method} ${call.url}`)).toEqual([`HEAD ${RELEASES_PAGE}`]);
        expect(stub.globalState.get(LATEST_TAG_CACHE_KEY)).toMatchObject({ tag: 'v0.4.2' });
    });

    it('downloads, verifies and extracts the release the redirect points at', async () => {
        net.routes.set(RELEASES_PAGE, redirectTo('v0.4.2'));
        publishRelease('v0.4.2');

        const installed = await ensure();

        expect(installed).toEqual({ path: getExecutablePath(context, 'v0.4.2'), version: 'v0.4.2' });
        expect(fs.existsSync(installed.path)).toBe(true);
        expect(requested(RELEASES_API)).toBe(0);
        expect(stub.globalState.get(LATEST_TAG_CACHE_KEY)).toMatchObject({ tag: 'v0.4.2' });
    });

    it('asks the API for an older release when the latest one lacks this platform', async () => {
        net.routes.set(RELEASES_PAGE, redirectTo('v0.5.0'));
        net.routes.set(assetUrl('v0.5.0'), { status: 404 });
        net.routes.set(RELEASES_API, {
            status: 200,
            headers: { etag: '"abc"' },
            body: JSON.stringify([
                { tag_name: 'v0.5.0', assets: [{ name: 'something-else.tar.xz' }] },
                { tag_name: 'v0.4.2', assets: [{ name: assetName() }] },
            ]),
        });
        publishRelease('v0.4.2');

        await expect(ensure()).resolves.toMatchObject({ version: 'v0.4.2' });
        expect(requested(RELEASES_API)).toBe(1);
        expect(stub.globalState.get(LATEST_TAG_CACHE_KEY)).toMatchObject({ tag: 'v0.4.2' });
        expect(stub.globalState.get(API_ETAG_CACHE_KEY)).toEqual({ etag: '"abc"', tag: 'v0.4.2' });
        expect(fs.existsSync(path.join(getLibsRoot(context), '0.5.0'))).toBe(false);
    });

    it('falls through to the API when the redirect tag fails to install for another reason', async () => {
        net.routes.set(RELEASES_PAGE, redirectTo('v0.5.0'));
        net.routes.set(assetUrl('v0.5.0'), { status: 500 });
        net.routes.set(RELEASES_API, {
            status: 200,
            body: JSON.stringify([{ tag_name: 'v0.4.2', assets: [{ name: assetName() }] }]),
        });
        publishRelease('v0.4.2');

        await expect(ensure()).resolves.toMatchObject({ version: 'v0.4.2' });
        expect(stub.globalState.get(LATEST_TAG_CACHE_KEY)).toMatchObject({ tag: 'v0.4.2' });
    });

    it('does not retry the redirect tag when the API points at the same release', async () => {
        net.routes.set(RELEASES_PAGE, redirectTo('v0.9.0'));
        net.routes.set(assetUrl('v0.9.0'), { status: 500 });
        net.routes.set(RELEASES_API, {
            status: 200,
            body: JSON.stringify([{ tag_name: 'v0.9.0', assets: [{ name: assetName() }] }]),
        });
        publishRelease(FALLBACK_SERVER_VERSION);

        await expect(ensure()).resolves.toMatchObject({ version: FALLBACK_SERVER_VERSION });
        expect(requested(assetUrl('v0.9.0'))).toBe(1);
        expect(requested(RELEASES_API)).toBe(1);
    });

    it('skips prereleases when looking for a release through the API', async () => {
        net.routes.set(RELEASES_PAGE, 'network-error');
        net.routes.set(RELEASES_API, {
            status: 200,
            body: JSON.stringify([
                { tag_name: 'v0.6.0-rc.1', prerelease: true, assets: [{ name: assetName() }] },
                { tag_name: 'v0.4.2', assets: [{ name: assetName() }] },
            ]),
        });
        publishRelease('v0.4.2');

        await expect(ensure()).resolves.toMatchObject({ version: 'v0.4.2' });
        expect(requested(assetUrl('v0.6.0-rc.1'))).toBe(0);
    });

    it('backs off after a rate limit and installs the fallback release without a popup', async () => {
        const resetSeconds = Math.floor(Date.now() / 1000) + 1800;
        net.routes.set(RELEASES_PAGE, 'network-error');
        net.routes.set(RELEASES_API, {
            status: 403,
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSeconds) },
            body: '{"message":"API rate limit exceeded"}',
        });
        publishRelease(FALLBACK_SERVER_VERSION);

        await expect(ensure()).resolves.toMatchObject({ version: FALLBACK_SERVER_VERSION });
        expect(stub.globalState.get(API_BACKOFF_KEY)).toBe(resetSeconds * 1000);
        expect(stub.logs.some((line) => line.includes('rate limit exceeded'))).toBe(true);
        expect(stub.messages).toEqual([]);
        // A fallback is not a resolved latest, so the next start tries again.
        expect(stub.globalState.has(LATEST_TAG_CACHE_KEY)).toBe(false);
    });

    it('does not call the API again while backing off', async () => {
        stub.globalState.set(API_BACKOFF_KEY, Date.now() + 600_000);
        net.routes.set(RELEASES_PAGE, 'network-error');
        publishRelease(FALLBACK_SERVER_VERSION);

        await expect(ensure()).resolves.toMatchObject({ version: FALLBACK_SERVER_VERSION });
        expect(requested(RELEASES_API)).toBe(0);
    });

    it('sends the stored ETag and reuses its tag on 304 Not Modified', async () => {
        stub.globalState.set(API_ETAG_CACHE_KEY, { etag: '"abc"', tag: 'v0.4.1' });
        const executable = installOnDisk('v0.4.1');
        net.routes.set(RELEASES_PAGE, 'network-error');
        net.routes.set(RELEASES_API, (headers: Record<string, string>) =>
            headers['If-None-Match'] === '"abc"' ? { status: 304 } : { status: 500 }
        );

        await expect(ensure()).resolves.toEqual({ path: executable, version: 'v0.4.1' });
    });

    it('prefers an installed binary over downloading the fallback when GitHub is unreachable', async () => {
        const executable = installOnDisk('v0.3.0');

        await expect(ensure()).resolves.toEqual({ path: executable, version: 'v0.3.0' });
        expect(requested(assetUrl(FALLBACK_SERVER_VERSION))).toBe(0);
    });

    it('fails when nothing can be resolved, downloaded or found on disk', async () => {
        await expect(ensure()).rejects.toThrow();
    });

    it('uses an explicitly configured version without resolving anything', async () => {
        const executable = installOnDisk('v0.3.0');

        await expect(ensure('0.3.0')).resolves.toEqual({ path: executable, version: 'v0.3.0' });
        expect(net.calls).toEqual([]);
    });

    it('removes a failed install so it is not mistaken for a usable one', async () => {
        publishRelease('v0.3.0', '0'.repeat(64));

        await expect(ensure('v0.3.0')).rejects.toThrow('Checksum verification failed');
        expect(fs.existsSync(path.join(getLibsRoot(context), '0.3.0'))).toBe(false);
    });

    it('uses the install another window finished while this one was downloading', async () => {
        publishRelease('v0.3.0');
        const checksum = net.routes.get(`${assetUrl('v0.3.0')}.sha256`) as Reply;
        net.routes.set(`${assetUrl('v0.3.0')}.sha256`, () => {
            installOnDisk('v0.3.0');
            return checksum;
        });

        const installed = await ensure('v0.3.0');

        expect(fs.readFileSync(installed.path, 'utf8')).toBe('installed');
        expect(fs.readdirSync(getLibsRoot(context))).toEqual(['0.3.0']);
    });

    it('replaces a leftover install directory that has no executable', async () => {
        publishRelease('v0.3.0');
        fs.mkdirSync(path.join(getLibsRoot(context), '0.3.0', 'leftover'), { recursive: true });

        const installed = await ensure('v0.3.0');

        expect(fs.readFileSync(installed.path, 'utf8')).toBe('#!/bin/sh\n');
        expect(fs.existsSync(path.join(getLibsRoot(context), '0.3.0', 'leftover'))).toBe(false);
        expect(fs.readdirSync(getLibsRoot(context))).toEqual(['0.3.0']);
    });

    it('removes abandoned staging directories but leaves recent ones', async () => {
        publishRelease('v0.3.0');
        const stale = path.join(getLibsRoot(context), '.staging-0.2.0-stale');
        const recent = path.join(getLibsRoot(context), '.staging-0.2.0-recent');
        fs.mkdirSync(stale, { recursive: true });
        fs.mkdirSync(recent, { recursive: true });
        const old = new Date(Date.now() - STALE_STAGING_MS - 60_000);
        fs.utimesSync(stale, old, old);

        await ensure('v0.3.0');

        expect(fs.existsSync(stale)).toBe(false);
        expect(fs.existsSync(recent)).toBe(true);
    });

    it('ignores a latest tag that is not a plain version', async () => {
        net.routes.set(RELEASES_PAGE, redirectTo('%2E%2E%2Fescape'));
        publishRelease(FALLBACK_SERVER_VERSION);

        await expect(ensure()).resolves.toMatchObject({ version: FALLBACK_SERVER_VERSION });
        expect(net.calls.some((call) => call.url.includes('escape') && call.url !== RELEASES_PAGE)).toBe(false);
    });

    it('rejects a configured version that is not a plain version', async () => {
        await expect(ensure('../escape')).rejects.toThrow('Invalid hydrust.serverVersion');
        expect(net.calls).toEqual([]);
    });

    it('shares one resolution between concurrent callers', async () => {
        installOnDisk('v0.4.2');
        net.routes.set(RELEASES_PAGE, redirectTo('v0.4.2'));

        const [first, second] = await Promise.all([ensure(), ensure()]);

        expect(first).toEqual(second);
        expect(requested(RELEASES_PAGE)).toBe(1);
    });
});

describe('rateLimitRetryTime', () => {
    const now = 1_000_000_000_000;

    it('honours retry-after first', () => {
        expect(rateLimitRetryTime({ 'retry-after': '120', 'x-ratelimit-remaining': '0' }, now)).toBe(now + 120_000);
    });

    it('waits for the reset time once the quota is spent', () => {
        expect(rateLimitRetryTime({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 900) }, now))
            .toBe(now + 900_000);
    });

    it('waits at least a minute otherwise', () => {
        expect(rateLimitRetryTime({}, now)).toBe(now + MIN_API_BACKOFF_MS);
        expect(rateLimitRetryTime({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000) }, now))
            .toBe(now + MIN_API_BACKOFF_MS);
    });
});

describe('the release pin script', () => {
    it('checks for exactly the archives the extension can download', () => {
        const combos = [
            ['win32', 'x64'],
            ['darwin', 'arm64'],
            ['darwin', 'x64'],
            ['linux', 'arm64'],
            ['linux', 'x64'],
        ];
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
        try {
            const names = combos.map(([p, a]) => {
                Object.defineProperty(process, 'platform', { value: p });
                Object.defineProperty(process, 'arch', { value: a });
                return assetName();
            });
            expect([...names].sort()).toEqual([...PLATFORM_ASSETS].sort());
        } finally {
            Object.defineProperty(process, 'platform', platform);
            Object.defineProperty(process, 'arch', arch);
        }
    });

    it('picks the newest stable release that has every archive', () => {
        const all = PLATFORM_ASSETS.map((name) => ({ name }));
        expect(
            pickPinnableRelease([
                { tag_name: 'v0.6.0', prerelease: true, assets: all },
                { tag_name: 'v0.5.0', assets: all.slice(1) },
                { tag_name: 'v0.4.2', assets: all },
                { tag_name: 'v0.4.1', assets: all },
            ])
        ).toBe('v0.4.2');
        expect(pickPinnableRelease([])).toBeUndefined();
    });

    it('rewrites the pin in constants.ts and nothing else', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '../../src/common/constants.ts'), 'utf8');
        const rewritten = rewritePin(source, 'v9.9.9');

        expect(rewritten).toContain("export const FALLBACK_SERVER_VERSION = 'v9.9.9';");
        expect(rewritten.replace('v9.9.9', FALLBACK_SERVER_VERSION)).toBe(source);
        expect(() => rewritePin('nothing here', 'v1.0.0')).toThrow();
    });
});

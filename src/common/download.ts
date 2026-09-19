import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as https from 'https';
import * as crypto from 'crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'http';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import { exec } from 'child_process';
import { logger } from './logger';
import { FALLBACK_SERVER_VERSION, SERVER_REPO, getPlatformInfo, getDownloadUrl, getChecksumUrl } from './constants';
import { getArchiveFileName, getArchiveFileNameCandidates } from './constants';
import { getVersionedDir, getExecutablePath, getLibsRoot, isWindows } from './constants';
import { fsapi } from './vscodeapi';
import { isDeveloperMode } from './settings';

const execAsync = promisify(exec);

/** globalState key holding the tag `latest` last resolved to, and when. */
export const LATEST_TAG_CACHE_KEY = 'hydrust.latestServerTag.v1';

/** How long a resolved `latest` tag is trusted before GitHub is asked again. */
export const LATEST_TAG_TTL_MS = 24 * 60 * 60 * 1000;

/** globalState key holding the epoch ms before which the GitHub API is not called. */
export const API_BACKOFF_KEY = 'hydrust.githubApiBackoffUntil.v1';

/** globalState key holding the ETag of the last releases listing and the tag picked from it. */
export const API_ETAG_CACHE_KEY = 'hydrust.githubReleasesEtag.v1';

/** globalState key holding the tag whose install last failed, and when. */
export const FAILED_INSTALL_KEY = 'hydrust.failedServerInstall.v1';

/** How long a tag that failed to install is skipped when resolving `latest`. */
export const FAILED_INSTALL_TTL_MS = 60 * 60 * 1000;

/** globalState key holding the latest tag found to have no archive for this platform, and when. */
export const MISSING_ASSET_KEY = 'hydrust.missingServerAsset.v1';

/** How long a latest tag without an archive for this platform is not re-resolved or re-downloaded. */
export const MISSING_ASSET_TTL_MS = 60 * 60 * 1000;

/** Timeout for the small metadata requests made while resolving a version. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** How long a download may go without receiving any data before it is abandoned. */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

/** Shortest backoff after a rate-limit response, as GitHub's guidance asks. */
export const MIN_API_BACKOFF_MS = 60_000;

/** Longest backoff honoured, so a bogus header cannot disable the API indefinitely. */
export const MAX_API_BACKOFF_MS = 60 * 60 * 1000;

/** Staging directories older than this are assumed abandoned by a closed or crashed window. */
export const STALE_STAGING_MS = 60 * 60 * 1000;

/** Prefix for the globalState key recording when a window last used a version. */
export const VERSION_LAST_USED_KEY = 'hydrust.serverVersionsLastUsed.v1';

/** Installed versions used by any window more recently than this are never pruned. */
export const PRUNE_UNUSED_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * globalState key holding when a window last used the version installed at `dir`.
 * Each version gets its own key so that concurrent writes from different windows,
 * for different versions, never overwrite one another.
 */
export function versionLastUsedKey(dir: string): string {
    return `${VERSION_LAST_USED_KEY}.${dir}`;
}

/** Release tags that are safe to use in file paths and shell commands. */
export const TAG_PATTERN = /^v?\d+\.\d+\.\d+[\w.-]*$/;

const USER_AGENT = 'hydrust-vscode';
const MAX_REDIRECTS = 5;

interface CachedLatestTag {
    tag: string;
    checkedAt: number;
}

interface CachedReleasesEtag {
    etag: string;
    tag: string;
}

/** The requested release does not have the file that was asked for. */
class AssetNotFoundError extends Error {}

/** A download failed for a reason that may not happen again, like a timeout or dropped connection. */
class NetworkError extends Error {}

/** The configured hydrust.serverVersion is not a valid version. */
export class InvalidServerVersionError extends Error {}

/**
 * In developer mode, log full details and surface a popup with a "Show Logs"
 * action that reveals the Hydrust output channel. No-op otherwise.
 */
function notifyDeveloper(summary: string, ...details: unknown[]): void {
    if (!isDeveloperMode()) {
        return;
    }
    logger.error(summary, ...details);
    void vscode.window
        .showErrorMessage(
            `Hydrust: ${summary} See the Hydrust output channel for details.`,
            'Show Logs'
        )
        .then((selection) => {
            if (selection === 'Show Logs') {
                logger.channel.show();
            }
        });
}

/**
 * Send a single HTTPS request without following redirects.
 *
 * The timeout is an idle timeout on the socket, so it also bounds a stalled
 * response body, not just the wait for headers.
 */
function request(
    url: string,
    options: { method?: string; headers?: Record<string, string>; timeoutMs: number }
): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
        const req = https.request(
            url,
            {
                method: options.method ?? 'GET',
                headers: { 'User-Agent': USER_AGENT, ...options.headers },
                timeout: options.timeoutMs,
            },
            resolve
        );
        req.on('timeout', () => {
            req.destroy(new Error(`Request to ${url} timed out after ${options.timeoutMs}ms`));
        });
        req.on('error', reject);
        req.end();
    });
}

async function readBody(response: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
}

/**
 * Download a file from a URL, following redirects.
 */
async function downloadFile(
    url: string,
    destPath: string,
    onStart?: () => void,
    redirectsLeft = MAX_REDIRECTS
): Promise<void> {
    let response: IncomingMessage;
    try {
        response = await request(url, { timeoutMs: DOWNLOAD_IDLE_TIMEOUT_MS });
    } catch (err) {
        throw new NetworkError(`${err instanceof Error ? err.message : err}`);
    }
    const status = response.statusCode ?? 0;
    const location = response.headers.location;

    if (status >= 300 && status < 400 && location) {
        response.resume();
        if (redirectsLeft === 0) {
            throw new Error(`Too many redirects while downloading ${url}`);
        }
        await downloadFile(new URL(location, url).toString(), destPath, onStart, redirectsLeft - 1);
        return;
    }

    if (status === 404) {
        response.resume();
        throw new AssetNotFoundError(`Not found: ${url}`);
    }

    if (status !== 200) {
        response.resume();
        throw new NetworkError(`Failed to download ${url}: ${status} ${response.statusMessage}`);
    }

    onStart?.();
    try {
        await pipeline(response, fs.createWriteStream(destPath));
    } catch (err) {
        await fs.remove(destPath);
        throw new NetworkError(`Failed to download ${url}: ${err instanceof Error ? err.message : err}`);
    }
}

/**
 * Calculate SHA256 checksum of a file
 */
async function calculateChecksum(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);

        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

/**
 * Verify file checksum against expected checksum
 */
async function verifyChecksum(filePath: string, checksumUrl: string): Promise<boolean> {
    try {
        // Download checksum file
        const checksumPath = `${filePath}.sha256`;
        await downloadFile(checksumUrl, checksumPath);

        // Read expected checksum
        const checksumContent = await fsapi.readFile(checksumPath);
        const expectedChecksum = checksumContent.trim().split(/\s+/)[0];

        // Calculate actual checksum
        const actualChecksum = await calculateChecksum(filePath);

        // Clean up checksum file
        await fs.unlink(checksumPath);

        const isValid = expectedChecksum.toLowerCase() === actualChecksum.toLowerCase();
        if (!isValid) {
            logger.error(`Checksum mismatch! Expected: ${expectedChecksum}, Got: ${actualChecksum}`);
        }

        return isValid;
    } catch (err) {
        // Only a release that publishes no checksum file is installed unverified.
        // Timeouts, network errors and server errors fail the install.
        if (!(err instanceof AssetNotFoundError)) {
            throw err;
        }
        logger.warn(`Failed to verify checksum: ${err}`);
        notifyDeveloper(
            `Checksum verification was skipped because the release has no checksum file (${checksumUrl}).`,
            'Error:',
            err
        );
        return true;
    }
}

/**
 * Extract tar.xz archive
 */
async function extractTarXz(archivePath: string, destDir: string): Promise<void> {
    await fsapi.ensureDir(destDir);

    try {
        // Extract archive with nested directory structure
        await execAsync(`tar -xJf "${archivePath}" -C "${destDir}"`, {
            maxBuffer: 1024 * 1024 * 100, // 100MB
        });
    } catch (err) {
        logger.error(`Failed to extract with tar: ${err}`);
        throw new Error(`Failed to extract archive: ${err}`);
    }
}

/**
 * Extract zip archive
 */
async function extractZip(archivePath: string, destDir: string): Promise<void> {
    await fsapi.ensureDir(destDir);

    try {
        if (isWindows()) {
            // Use PowerShell on Windows
            await execAsync(`powershell -command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`, {
                maxBuffer: 1024 * 1024 * 100, // 100MB
            });
        } else {
            // Use unzip on Unix systems
            await execAsync(`unzip -o "${archivePath}" -d "${destDir}"`, {
                maxBuffer: 1024 * 1024 * 100, // 100MB
            });
        }
    } catch (err) {
        logger.error(`Failed to extract zip: ${err}`);
        throw new Error(`Failed to extract archive: ${err}`);
    }
}

/**
 * Extract archive based on extension
 */
async function extractArchive(archivePath: string, destDir: string): Promise<void> {
    if (archivePath.endsWith('.tar.xz')) {
        await extractTarXz(archivePath, destDir);
    } else if (archivePath.endsWith('.zip')) {
        await extractZip(archivePath, destDir);
    } else {
        throw new Error(`Unsupported archive format: ${archivePath}`);
    }
}

/**
 * Find the tag of the latest release from the redirect github.com serves for
 * `/releases/latest`.
 *
 * This is an ordinary web request rather than an API call, so it keeps working
 * when the API rate limit is exhausted. It says nothing about which assets the
 * release has, and it never points at a prerelease.
 */
async function resolveLatestFromRedirect(): Promise<string | undefined> {
    const url = `https://github.com/${SERVER_REPO}/releases/latest`;
    try {
        const response = await request(url, { method: 'HEAD', timeoutMs: REQUEST_TIMEOUT_MS });
        response.resume();
        const match = /\/releases\/tag\/([^/?#]+)$/.exec(response.headers.location ?? '');
        if (!match) {
            logger.warn(
                `Could not read the latest release tag from ${url} ` +
                `(status ${response.statusCode}, location ${response.headers.location ?? 'none'}).`
            );
            return undefined;
        }
        const tag = decodeURIComponent(match[1]);
        if (!TAG_PATTERN.test(tag)) {
            logger.warn(`Ignoring unexpected latest release tag from ${url}: ${JSON.stringify(tag)}`);
            return undefined;
        }
        logger.info(`Latest release resolved to ${tag} from the GitHub releases page.`);
        return tag;
    } catch (err) {
        logger.warn(`Could not reach ${url}: ${err}`);
        return undefined;
    }
}

/**
 * When to next call the GitHub API after a rate-limit response, following
 * GitHub's guidance: `retry-after` first, then `x-ratelimit-reset` when the
 * quota is spent, and otherwise at least a minute.
 */
export function rateLimitRetryTime(headers: IncomingHttpHeaders, now: number): number {
    return Math.min(uncappedRetryTime(headers, now), now + MAX_API_BACKOFF_MS);
}

function uncappedRetryTime(headers: IncomingHttpHeaders, now: number): number {
    const retryAfter = Number(headerValue(headers, 'retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
        return now + retryAfter * 1000;
    }
    const reset = Number(headerValue(headers, 'x-ratelimit-reset'));
    if (headerValue(headers, 'x-ratelimit-remaining') === '0' && Number.isFinite(reset)) {
        return Math.max(reset * 1000, now + MIN_API_BACKOFF_MS);
    }
    return now + MIN_API_BACKOFF_MS;
}

/**
 * Find the newest release that has an archive for this platform, using the
 * GitHub releases API.
 *
 * Only needed when the latest release is missing this platform's archive, or
 * the releases page could not be reached. Never throws: every failure is logged
 * and reported as undefined so the caller can move on to the next option.
 */
async function resolveLatestFromApi(context: vscode.ExtensionContext): Promise<string | undefined> {
    const backoffUntil = context.globalState.get<number>(API_BACKOFF_KEY);
    if (backoffUntil !== undefined && Date.now() < backoffUntil) {
        logger.info(
            `Not calling the GitHub API: rate limited until ${new Date(backoffUntil).toLocaleTimeString()}.`
        );
        return undefined;
    }

    const platformInfo = getPlatformInfo();
    // Either name is accepted, because the scan is what decides the version and
    // so there is nothing to key the name off yet.
    const expectedAssetNames = getArchiveFileNameCandidates(platformInfo);
    const url = `https://api.github.com/repos/${SERVER_REPO}/releases?per_page=100`;
    const cachedEtag = context.globalState.get<CachedReleasesEtag>(API_ETAG_CACHE_KEY);

    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    if (cachedEtag) {
        headers['If-None-Match'] = cachedEtag.etag;
    }

    let response: IncomingMessage;
    try {
        response = await request(url, { headers, timeoutMs: REQUEST_TIMEOUT_MS });
    } catch (err) {
        logger.warn(`Could not reach the GitHub releases API: ${err}`);
        return undefined;
    }

    const status = response.statusCode ?? 0;

    if (status === 304 && cachedEtag) {
        response.resume();
        logger.info(`GitHub releases unchanged since the last check; latest usable release is ${cachedEtag.tag}.`);
        return cachedEtag.tag;
    }

    const body = await readBody(response).catch((err) => {
        logger.warn(`Failed to read the GitHub releases API response: ${err}`);
        return undefined;
    });

    // Secondary rate limits can return a 403 with neither header; only the body says so.
    const isRateLimited =
        status === 429 ||
        (status === 403 &&
            (headerValue(response.headers, 'x-ratelimit-remaining') === '0' ||
                headerValue(response.headers, 'retry-after') !== undefined ||
                /rate limit/i.test(body ?? '')));
    if (isRateLimited) {
        const retryAt = rateLimitRetryTime(response.headers, Date.now());
        await context.globalState.update(API_BACKOFF_KEY, retryAt);
        logger.warn(
            `GitHub API rate limit exceeded (status ${status}), resets at ` +
            `${new Date(retryAt).toLocaleTimeString()}. The API will not be called again before then.`
        );
        return undefined;
    }

    if (body === undefined) {
        return undefined;
    }

    if (status !== 200) {
        logger.warn(`GitHub releases API returned status ${status}.`);
        notifyDeveloper(`GitHub releases API returned status ${status}.`, 'Body:', body);
        return undefined;
    }

    let releases: unknown;
    try {
        releases = JSON.parse(body);
    } catch (err) {
        logger.warn(`Failed to parse the GitHub releases API response: ${err}`);
        notifyDeveloper('Failed to parse the GitHub releases API response.', 'Error:', err, 'Raw body:', body);
        return undefined;
    }
    if (!Array.isArray(releases)) {
        logger.warn('Unexpected response from the GitHub releases API.');
        notifyDeveloper('Unexpected response from the GitHub releases API.', 'Parsed payload:', releases);
        return undefined;
    }

    const newestFirst = releases
        .filter((release) => typeof release?.tag_name === 'string' && TAG_PATTERN.test(release.tag_name))
        .sort((a, b) => compareVersionsDesc(a.tag_name.replace(/^v/, ''), b.tag_name.replace(/^v/, '')));
    for (const release of newestFirst) {
        if (release.draft || release.prerelease || !Array.isArray(release.assets)) {
            continue;
        }
        const matched = release.assets.find((asset: { name: string }) =>
            expectedAssetNames.includes(asset.name)
        );
        if (matched) {
            const etag = headerValue(response.headers, 'etag');
            if (etag) {
                await context.globalState.update(API_ETAG_CACHE_KEY, { etag, tag: release.tag_name });
            }
            const derived = getArchiveFileName(platformInfo, release.tag_name);
            if (derived !== matched.name) {
                // The naming table and the release disagree, so the download
                // that follows is about to 404. Say which tag and which two
                // names, or it looks like a network fault.
                logger.warn(
                    `Release ${release.tag_name} has an asset named '${matched.name}', but this ` +
                    `extension expects '${derived}' for that version. The naming table is out of ` +
                    'date and the download will fail.'
                );
            }
            logger.info(`Newest release with a ${platformInfo.platform} archive is ${release.tag_name}.`);
            return release.tag_name;
        }
    }

    const wanted = expectedAssetNames.map((name) => `'${name}'`).join(' or ');
    logger.warn(`No GitHub release has an asset matching ${wanted}.`);
    notifyDeveloper(
        `No GitHub release found with an asset matching ${wanted}.`,
        'Inspected releases:',
        releases.map((r: { tag_name?: string; assets?: { name: string }[] }) => ({
            tag_name: r.tag_name,
            asset_names: Array.isArray(r.assets) ? r.assets.map((a) => a.name) : [],
        }))
    );
    return undefined;
}

/**
 * Rename, retrying briefly on the transient EPERM/EBUSY errors Windows raises
 * while something such as a virus scanner still has the new files open.
 */
async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            await fs.rename(from, to);
            return;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if ((code !== 'EPERM' && code !== 'EBUSY') || attempt >= attempts) {
                throw err;
            }
            await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
        }
    }
}

/**
 * When a directory last changed. Its own mtime does not change while a file in
 * it is still being written, so go by the newest thing anywhere inside it.
 */
async function newestMtime(dir: string): Promise<number> {
    const stats = await fs.lstat(dir);
    let newest = stats.mtimeMs;
    if (stats.isDirectory()) {
        for (const child of await fs.readdir(dir)) {
            newest = Math.max(newest, await newestMtime(path.join(dir, child)));
        }
    }
    return newest;
}

/** Remove staging directories left behind by installs that never finished. */
async function removeStaleStagingDirs(libsRoot: string): Promise<void> {
    let entries: string[];
    try {
        entries = await fs.readdir(libsRoot);
    } catch {
        return;
    }
    for (const entry of entries) {
        if (!entry.startsWith('.staging-')) {
            continue;
        }
        const dir = path.join(libsRoot, entry);
        try {
            if (Date.now() - (await newestMtime(dir)) > STALE_STAGING_MS) {
                await fs.remove(dir);
                logger.info(`Removed abandoned staging directory ${dir}`);
            }
        } catch {
            // Another window may have removed it already.
        }
    }
}

/**
 * Remove installed versions other than `keep` and the newest one besides it,
 * so disk use does not grow with every release. Versions any window used
 * recently are kept, since all windows share this storage and another window
 * may still be running one of them. Each directory is moved aside
 * before it is removed; on Windows that fails while another window is running
 * the binary inside it, and such directories are left alone.
 */
async function pruneOldVersions(context: vscode.ExtensionContext, keep: string): Promise<void> {
    const libsRoot = getLibsRoot(context);
    let entries: string[];
    try {
        entries = await fs.readdir(libsRoot);
    } catch {
        return;
    }
    const others = entries.filter((entry) => !entry.startsWith('.') && entry !== keep).sort(compareVersionsDesc);
    // Spare the newest usable install, not merely the newest directory.
    let spared: string | undefined;
    for (const entry of others) {
        if (await fsapi.pathExists(getExecutablePath(context, entry))) {
            spared = entry;
            break;
        }
    }
    for (const entry of others.filter((entry) => entry !== spared)) {
        // Read just before deciding, so a use recorded by another window between
        // entries in this loop is not missed.
        const lastUsed = context.globalState.get<number>(versionLastUsedKey(entry)) ?? 0;
        if (Date.now() - lastUsed < PRUNE_UNUSED_MS) {
            continue;
        }
        const dir = path.join(libsRoot, entry);
        const discardDir = path.join(libsRoot, `.staging-${entry}-${crypto.randomBytes(6).toString('hex')}-discard`);
        try {
            await fs.rename(dir, discardDir);
        } catch (err) {
            logger.info(`Keeping old install ${dir}, which could not be moved: ${err}`);
            continue;
        }
        await fs.remove(discardDir).catch((err) => logger.warn(`Could not remove ${discardDir}: ${err}`));
        await context.globalState.update(versionLastUsedKey(entry), undefined);
        logger.info(`Removed old install ${dir}`);
    }
}

/**
 * Download and install the Hydrust Server binary.
 * `resolvedVersion` must already be a concrete, v-prefixed tag.
 */
async function downloadServer(
    resolvedVersion: string,
    context: vscode.ExtensionContext,
    progressCallback?: (message: string) => void
): Promise<string> {
    const progress = progressCallback || ((msg: string) => logger.info(msg));
    const versionedDir = getVersionedDir(context, resolvedVersion);
    // Other VS Code windows share this storage, so build the install somewhere
    // only this attempt uses and move it into place once it is complete.
    const stagingDir = path.join(
        getLibsRoot(context),
        `.staging-${path.basename(versionedDir)}-${crypto.randomBytes(6).toString('hex')}`
    );
    const stagingExecutablePath = path.join(stagingDir, path.relative(versionedDir, getExecutablePath(context, resolvedVersion)));

    await removeStaleStagingDirs(getLibsRoot(context));

    try {
        // Get platform info
        const platformInfo = getPlatformInfo();
        logger.info(`Platform: ${platformInfo.platform}`);

        // Get download URL
        const downloadUrl = getDownloadUrl(resolvedVersion, platformInfo);
        const checksumUrl = getChecksumUrl(resolvedVersion, platformInfo);
        logger.info(`Download URL: ${downloadUrl}`);

        await fsapi.ensureDir(stagingDir);

        const archiveFilename = path.basename(downloadUrl);
        const archivePath = path.join(stagingDir, archiveFilename);
        const executablePath = getExecutablePath(context, resolvedVersion);

        // Download archive
        await downloadFile(downloadUrl, archivePath, () => progress(`Downloading Hydrust Server ${resolvedVersion}...`));
        logger.info(`Downloaded to: ${archivePath}`);

        // Verify checksum
        progress('Verifying download...');
        const isValid = await verifyChecksum(archivePath, checksumUrl);
        if (!isValid) {
            throw new Error('Checksum verification failed');
        }
        logger.info('Checksum verified');

        // Extract archive
        progress('Extracting archive...');
        await extractArchive(archivePath, stagingDir);
        logger.info('Archive extracted');

        // Clean up archive
        await fs.unlink(archivePath);

        // Verify executable exists
        if (!(await fsapi.pathExists(stagingExecutablePath))) {
            throw new Error(`Executable not found after extraction: ${stagingExecutablePath}`);
        }

        // Make executable on Unix systems
        if (!isWindows()) {
            await fs.chmod(stagingExecutablePath, 0o755);
            logger.info('Made executable');
        }

        if (
            (await fsapi.pathExists(versionedDir)) &&
            !(await fsapi.pathExists(executablePath)) &&
            Date.now() - (await newestMtime(versionedDir).catch(() => Date.now())) > STALE_STAGING_MS
        ) {
            // A long-abandoned directory without the executable is in the way. Renaming
            // onto it fails with EPERM on Windows, so clear it first. Move it aside rather
            // than deleting in place, so an install another window finished just now
            // is never removed. A recently changed one may be another window's install
            // landing, so it is left alone.
            const discardDir = `${stagingDir}-discard`;
            try {
                await renameWithRetry(versionedDir, discardDir);
                if (await fsapi.pathExists(path.join(discardDir, path.relative(versionedDir, executablePath)))) {
                    await renameWithRetry(discardDir, versionedDir);
                } else {
                    logger.warn(`Replacing incomplete install at ${versionedDir}`);
                    await fs.remove(discardDir);
                }
            } catch (err) {
                logger.warn(`Could not clear incomplete install at ${versionedDir}: ${err}`);
            }
        }

        try {
            await renameWithRetry(stagingDir, versionedDir);
        } catch (err) {
            if (!(await fsapi.pathExists(executablePath))) {
                throw new Error(
                    `Could not install ${resolvedVersion}: ${versionedDir} already exists without the server ` +
                    `executable and could not be replaced. Remove that directory and try again. (${err})`
                );
            }
            // Another window finished installing this version first.
            logger.info(`Version ${resolvedVersion} was installed concurrently; using that install.`);
            await fs.remove(stagingDir).catch(() => undefined);
        }

        progress(`Hydrust Server ${resolvedVersion} installed successfully`);
        await pruneOldVersions(context, path.basename(versionedDir));
        return executablePath;
    } catch (err) {
        logger.error(`Failed to download server: ${err}`);
        await fs.remove(stagingDir).catch(() => undefined);
        throw err;
    }
}

/**
 * A binary on disk, together with the release tag it came from.
 */
export interface InstalledServer {
    /** Absolute path to the executable. */
    path: string;
    /** The concrete, v-prefixed release tag, e.g. 'v0.3.0'. */
    version: string;
}

function normaliseTag(version: string): string {
    return version.startsWith('v') ? version : `v${version}`;
}

/** Use the installed binary for a tag, downloading it first if needed. */
async function installVersion(tag: string, context: vscode.ExtensionContext): Promise<InstalledServer> {
    const executablePath = getExecutablePath(context, tag);
    // Mark before checking, so another window cannot prune it between the check and use.
    const usedAt = await markVersionUsed(context, tag);
    if (await fsapi.pathExists(executablePath)) {
        logger.info(`Binary for version ${tag} already exists`);
        return { path: executablePath, version: tag };
    }

    logger.info(`Downloading Hydrust Server version: ${tag}`);

    // The notification only opens once the archive is actually being served, so
    // a release without this platform's archive does not flash one on every start.
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
        finish = resolve;
    });
    let notification: Promise<vscode.Progress<{ message?: string }>> | undefined;
    const report = (message: string) => {
        logger.info(message);
        notification ??= new Promise((resolve) => {
            void vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Hydrust Server', cancellable: false },
                (progress) => {
                    resolve(progress);
                    return finished;
                }
            );
        });
        void notification.then((progress) => progress.report({ message }));
    };

    try {
        const installedPath = await downloadServer(tag, context, report);
        return { path: installedPath, version: tag };
    } catch (err) {
        if (!(await fsapi.pathExists(executablePath))) {
            await forgetVersionUsed(context, tag, usedAt);
        }
        throw err;
    } finally {
        finish();
    }
}

/**
 * Find a server for the `latest` setting, trying in order:
 *
 * 1. the tag resolved within the last day, if it is installed (no network);
 * 2. the latest release, read from the github.com releases page;
 * 3. the newest release with this platform's archive, from the GitHub API;
 * 4. the newest binary already installed;
 * 5. FALLBACK_SERVER_VERSION.
 *
 * Only a tag that was actually resolved from GitHub is cached, so a start that
 * fell back to 4 or 5 tries GitHub again next time.
 */
async function ensureLatest(context: vscode.ExtensionContext): Promise<InstalledServer> {
    const cached = context.globalState.get<CachedLatestTag>(LATEST_TAG_CACHE_KEY);
    if (cached && Date.now() - cached.checkedAt < LATEST_TAG_TTL_MS) {
        const executablePath = getExecutablePath(context, cached.tag);
        const usedAt = await markVersionUsed(context, cached.tag);
        if (await fsapi.pathExists(executablePath)) {
            logger.info(`Using ${cached.tag}, resolved as the latest release within the last day.`);
            return { path: executablePath, version: cached.tag };
        }
        await forgetVersionUsed(context, cached.tag, usedAt);
    }

    const useResolved = async (tag: string): Promise<InstalledServer> => {
        const failed = context.globalState.get<CachedLatestTag>(FAILED_INSTALL_KEY);
        if (failed?.tag === tag && Date.now() - failed.checkedAt < FAILED_INSTALL_TTL_MS) {
            throw new Error(`installing ${tag} failed recently; not retrying yet`);
        }
        const missing = context.globalState.get<CachedLatestTag>(MISSING_ASSET_KEY);
        if (missing?.tag === tag && Date.now() - missing.checkedAt < MISSING_ASSET_TTL_MS) {
            throw new AssetNotFoundError(`${tag} recently had no archive for this platform`);
        }
        let installed: InstalledServer;
        try {
            installed = await installVersion(tag, context);
        } catch (err) {
            if (err instanceof AssetNotFoundError) {
                await context.globalState.update(MISSING_ASSET_KEY, { tag, checkedAt: Date.now() } satisfies CachedLatestTag);
            } else if (!(err instanceof NetworkError)) {
                await context.globalState.update(FAILED_INSTALL_KEY, { tag, checkedAt: Date.now() } satisfies CachedLatestTag);
            }
            throw err;
        }
        await context.globalState.update(LATEST_TAG_CACHE_KEY, { tag, checkedAt: Date.now() } satisfies CachedLatestTag);
        return installed;
    };

    let firstError: unknown;
    const missing = context.globalState.get<CachedLatestTag>(MISSING_ASSET_KEY);
    const redirectTag = missing && Date.now() - missing.checkedAt < MISSING_ASSET_TTL_MS
        ? missing.tag
        : await resolveLatestFromRedirect();
    if (redirectTag) {
        try {
            return await useResolved(redirectTag);
        } catch (err) {
            if (!(err instanceof AssetNotFoundError)) {
                firstError = err;
                logger.warn(`Could not install ${redirectTag}: ${err}`);
            } else {
                logger.info(`Release ${redirectTag} has no archive for this platform; looking for an older one.`);
            }
        }
    }

    const apiTag = await resolveLatestFromApi(context);
    if (apiTag && apiTag !== redirectTag) {
        try {
            return await useResolved(apiTag);
        } catch (err) {
            firstError ??= err;
            logger.warn(`Could not install ${apiTag}: ${err}`);
        }
    }

    const existing = await findExistingExecutable(context);
    if (existing) {
        await markVersionUsed(context, existing.version);
        logger.warn(`Could not resolve the latest release; using the installed ${existing.version} instead.`);
        return existing;
    }

    logger.warn(`Could not resolve the latest release; installing the fallback ${FALLBACK_SERVER_VERSION} instead.`);
    try {
        return await installVersion(FALLBACK_SERVER_VERSION, context);
    } catch (err) {
        if (firstError === undefined) {
            throw err;
        }
        throw new Error(
            `Could not install the fallback ${FALLBACK_SERVER_VERSION} (${err}) ` +
            `after the latest release failed to install (${firstError})`
        );
    }
}

/**
 * Drop the last-used record for a version that turned out not to be installed,
 * unless another window has since recorded its own use of it.
 */
async function forgetVersionUsed(context: vscode.ExtensionContext, version: string, usedAt: number): Promise<void> {
    const key = versionLastUsedKey(path.basename(getVersionedDir(context, version)));
    if (context.globalState.get<number>(key) === usedAt) {
        await context.globalState.update(key, undefined);
    }
}

/**
 * Record that this window is using a version, so other windows do not prune it.
 * Called whenever the server is (re)started, including from a fallback binary.
 */
export async function markVersionUsed(context: vscode.ExtensionContext, version: string): Promise<number> {
    const dir = path.basename(getVersionedDir(context, version));
    const usedAt = Date.now();
    await context.globalState.update(versionLastUsedKey(dir), usedAt);
    return usedAt;
}

/**
 * Singleton guard: while a server is being resolved or downloaded, every
 * concurrent caller awaits the same promise rather than starting its own.
 */
const inFlight = new Map<string, Promise<InstalledServer>>();

/**
 * Ensure the server binary is available, downloading if necessary
 */
export function ensureServer(
    version: string,
    context: vscode.ExtensionContext
): Promise<InstalledServer> {
    const key = version === 'latest' || !version ? 'latest' : normaliseTag(version);
    if (key !== 'latest' && !TAG_PATTERN.test(key)) {
        return Promise.reject(new InvalidServerVersionError(`Invalid hydrust.serverVersion ${JSON.stringify(version)}: expected 'latest' or a version like 0.4.2`));
    }
    const existing = inFlight.get(key);
    if (existing) {
        logger.info('Server resolution already in progress, waiting for it to complete...');
        return existing;
    }

    const work = key === 'latest' ? ensureLatest(context) : installVersion(key, context);
    const shared = work.finally(() => {
        inFlight.delete(key);
    });
    inFlight.set(key, shared);
    return shared;
}

/**
 * Compare two version directory names (without 'v' prefix) descending.
 * Semver-aware on numeric segments; falls back to localeCompare for non-numeric tags.
 */
export function compareVersionsDesc(a: string, b: string): number {
    // Only the leading dotted numbers are the version; anything after is a
    // prerelease/build label ranking below the plain version (0.5.9 > 0.5.9-rc.2).
    const parse = (v: string): { segs: number[]; suffix: string } | null => {
        const match = /^\d+(\.\d+)*/.exec(v);
        return match ? { segs: match[0].split('.').map(Number), suffix: v.slice(match[0].length) } : null;
    };
    const aVer = parse(a);
    const bVer = parse(b);
    if (aVer && bVer) {
        const len = Math.max(aVer.segs.length, bVer.segs.length);
        for (let i = 0; i < len; i++) {
            const diff = (bVer.segs[i] ?? 0) - (aVer.segs[i] ?? 0);
            if (diff !== 0) {
                return diff;
            }
        }
        if (!aVer.suffix || !bVer.suffix) {
            return aVer.suffix === bVer.suffix ? 0 : aVer.suffix ? 1 : -1;
        }
        return bVer.suffix.localeCompare(aVer.suffix, undefined, { numeric: true });
    }
    return b.localeCompare(a);
}

/**
 * Scan the libs directory for any previously-installed binary and return the
 * path to the newest one (by semver). Returns undefined if none exists or the
 * directory can't be read.
 *
 * Used as a fallback when the normal download/resolve path fails (e.g. no
 * network) so the extension can still start with a previously-cached binary.
 *
 * Installs from either side of the rename can sit here together, since the
 * directory name is the version and `getExecutablePath` derives the archive
 * and executable names from it.
 */
export async function findExistingExecutable(
    context: vscode.ExtensionContext
): Promise<InstalledServer | undefined> {
    const libsRoot = getLibsRoot(context);

    let entries: string[];
    try {
        entries = await fs.readdir(libsRoot);
    } catch (err) {
        logger.debug(`No libs directory to scan for fallback: ${err}`);
        return undefined;
    }

    const candidates: { version: string; execPath: string }[] = [];
    for (const entry of entries) {
        if (entry.startsWith('.')) {
            continue;
        }
        const execPath = getExecutablePath(context, entry);
        if (await fsapi.pathExists(execPath)) {
            candidates.push({ version: entry, execPath });
        }
    }

    if (candidates.length === 0) {
        return undefined;
    }

    // Prefer releases over prereleases another workspace may have pinned.
    const isPrerelease = (version: string) => !/^\d+(\.\d+)*$/.test(version);
    candidates.sort((a, b) =>
        Number(isPrerelease(a.version)) - Number(isPrerelease(b.version)) || compareVersionsDesc(a.version, b.version));
    const newest = candidates[0];
    // Directory names have no 'v' prefix; put it back so callers see a tag.
    return { path: newest.execPath, version: `v${newest.version}` };
}

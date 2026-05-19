import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as https from 'https';
import * as crypto from 'crypto';
import { promisify } from 'util';
import { exec } from 'child_process';
import { logger } from './logger';
import { BINARY_NAME, getPlatformInfo, getDownloadUrl, getChecksumUrl } from './constants';
import { getVersionedDir, getExecutablePath, getLibsRoot, isWindows } from './constants';
import { fsapi } from './vscodeapi';
import { isDeveloperMode } from './settings';

const execAsync = promisify(exec);

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
 * Download a file from a URL
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        https.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                // Handle redirects
                if (response.headers.location) {
                    file.close();
                    fs.unlinkSync(destPath);
                    downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
                    return;
                }
            }

            if (response.statusCode !== 200) {
                file.close();
                fs.unlinkSync(destPath);
                reject(new Error(`Failed to download: ${response.statusCode} ${response.statusMessage}`));
                return;
            }

            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            fs.unlinkSync(destPath);
            reject(err);
        });
    });
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
        logger.warn(`Failed to verify checksum: ${err}`);
        notifyDeveloper(
            `Checksum verification was skipped because the checksum file could not be fetched (${checksumUrl}).`,
            'Error:',
            err
        );
        // Don't fail the download if checksum verification fails
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
 * Get the latest release version from GitHub that contains an asset
 * matching the expected binary name for the current platform.
 *
 * This ensures the extension only resolves to a release that actually
 * provides the binary it expects to download.
 */
async function getLatestVersion(): Promise<string> {
    const platformInfo = getPlatformInfo();
    const expectedAssetName = `${BINARY_NAME}-${platformInfo.platform}.${platformInfo.archiveExt}`;

    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: '/repos/m-lyon/hydra-lsp/releases',
            method: 'GET',
            headers: {
                'User-Agent': 'hydra-lsp-vscode',
            },
        };

        https.get(options, (response) => {
            let data = '';

            response.on('data', (chunk) => {
                data += chunk;
            });

            response.on('end', () => {
                try {
                    const releases = JSON.parse(data);
                    if (!Array.isArray(releases)) {
                        notifyDeveloper(
                            `Unexpected response from GitHub releases API (status ${response.statusCode}).`,
                            'Parsed payload:',
                            releases
                        );
                        reject(new Error('Unexpected response from GitHub releases API'));
                        return;
                    }
                    for (const release of releases) {
                        if (!release.tag_name || !Array.isArray(release.assets)) {
                            continue;
                        }
                        const hasMatchingAsset = release.assets.some(
                            (asset: { name: string }) => asset.name === expectedAssetName
                        );
                        if (hasMatchingAsset) {
                            resolve(release.tag_name);
                            return;
                        }
                    }
                    notifyDeveloper(
                        `No GitHub release found with asset matching '${expectedAssetName}'.`,
                        'Inspected releases:',
                        releases.map((r: { tag_name?: string; assets?: { name: string }[] }) => ({
                            tag_name: r.tag_name,
                            asset_names: Array.isArray(r.assets) ? r.assets.map((a) => a.name) : [],
                        }))
                    );
                    reject(new Error(`No release found with asset matching '${expectedAssetName}'`));
                } catch (err) {
                    notifyDeveloper(
                        `Failed to parse GitHub releases API response (status ${response.statusCode}).`,
                        'Error:',
                        err,
                        'Raw body:',
                        data
                    );
                    reject(err);
                }
            });
        }).on('error', (err) => {
            notifyDeveloper(
                'Network error while contacting the GitHub releases API.',
                'Error:',
                err
            );
            reject(err);
        });
    });
}

/**
 * Resolve a version string to a concrete, v-prefixed tag.
 * 'latest' (or empty) hits the GitHub API; anything else is normalized in place.
 */
async function resolveVersion(version: string): Promise<string> {
    let resolved = version;
    if (version === 'latest' || !version) {
        resolved = await getLatestVersion();
        logger.info(`Latest version resolved to: ${resolved}`);
    }
    if (!resolved.startsWith('v')) {
        resolved = `v${resolved}`;
    }
    return resolved;
}

/**
 * Download and install the Hydrust Server binary.
 * `resolvedVersion` must already be a concrete, v-prefixed tag (see resolveVersion).
 */
async function downloadServer(
    resolvedVersion: string,
    context: vscode.ExtensionContext,
    progressCallback?: (message: string) => void
): Promise<string> {
    const progress = progressCallback || ((msg: string) => logger.info(msg));

    try {
        // Get platform info
        const platformInfo = getPlatformInfo();
        logger.info(`Platform: ${platformInfo.platform}`);

        // Get download URL
        const downloadUrl = getDownloadUrl(resolvedVersion, platformInfo);
        const checksumUrl = getChecksumUrl(resolvedVersion, platformInfo);
        logger.info(`Download URL: ${downloadUrl}`);

        // Set up paths with versioned directory
        const versionedDir = getVersionedDir(context, resolvedVersion);
        await fsapi.ensureDir(versionedDir);

        const archiveFilename = path.basename(downloadUrl);
        const archivePath = path.join(versionedDir, archiveFilename);
        const executablePath = getExecutablePath(context, resolvedVersion);

        // Download archive
        progress(`Downloading Hydrust Server ${resolvedVersion}...`);
        await downloadFile(downloadUrl, archivePath);
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
        await extractArchive(archivePath, versionedDir);
        logger.info('Archive extracted');

        // Clean up archive
        await fs.unlink(archivePath);

        // Verify executable exists
        if (!(await fsapi.pathExists(executablePath))) {
            throw new Error(`Executable not found after extraction: ${executablePath}`);
        }

        // Make executable on Unix systems
        if (!isWindows()) {
            await execAsync(`chmod +x "${executablePath}"`);
            logger.info('Made executable');
        }

        progress(`Hydrust Server ${resolvedVersion} installed successfully`);
        return executablePath;
    } catch (err) {
        logger.error(`Failed to download server: ${err}`);
        throw err;
    }
}

/**
 * Check if the server binary needs to be downloaded.
 * `resolvedVersion` must already be a concrete, v-prefixed tag (see resolveVersion).
 */
async function needsDownload(
    resolvedVersion: string,
    context: vscode.ExtensionContext
): Promise<boolean> {
    const executablePath = getExecutablePath(context, resolvedVersion);

    const exists = await fsapi.pathExists(executablePath);
    if (!exists) {
        logger.info(`Binary for version ${resolvedVersion} not found, download needed`);
        return true;
    }

    logger.info(`Binary for version ${resolvedVersion} already exists`);
    return false;
}

/**
 * Singleton guard: if a download is already in progress, all concurrent callers
 * will await the same promise rather than triggering a second download.
 */
let activeDownload: Promise<string> | undefined;

/**
 * Ensure the server binary is available, downloading if necessary
 */
export async function ensureServer(
    version: string,
    context: vscode.ExtensionContext
): Promise<string> {
    // If a download is already running, wait for it instead of starting a new one
    if (activeDownload) {
        logger.info('Download already in progress, waiting for it to complete...');
        return activeDownload;
    }

    const resolvedVersion = await resolveVersion(version);

    if (await needsDownload(resolvedVersion, context)) {
        // Re-check after the async needsDownload call: another caller may have
        // started the download while we were awaiting.
        if (activeDownload) {
            logger.info('Download started by another caller, waiting...');
            return activeDownload;
        }

        logger.info(`Downloading Hydrust Server version: ${resolvedVersion}`);

        // Show progress to user
        activeDownload = Promise.resolve(vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Hydrust Server',
                cancellable: false,
            },
            async (progress) => {
                return await downloadServer(resolvedVersion, context, (message) => {
                    progress.report({ message });
                });
            }
        )).finally(() => {
            activeDownload = undefined;
        });

        return activeDownload;
    }

    return getExecutablePath(context, resolvedVersion);
}

/**
 * Compare two version directory names (without 'v' prefix) descending.
 * Semver-aware on numeric segments; falls back to localeCompare for non-numeric tags.
 */
function compareVersionsDesc(a: string, b: string): number {
    const parseSegs = (v: string): number[] | null => {
        const segs = v.split('.').map((s) => parseInt(s, 10));
        return segs.every((n) => Number.isFinite(n)) ? segs : null;
    };
    const aSegs = parseSegs(a);
    const bSegs = parseSegs(b);
    if (aSegs && bSegs) {
        const len = Math.max(aSegs.length, bSegs.length);
        for (let i = 0; i < len; i++) {
            const diff = (bSegs[i] ?? 0) - (aSegs[i] ?? 0);
            if (diff !== 0) {
                return diff;
            }
        }
        return 0;
    }
    return b.localeCompare(a);
}

/**
 * Scan the bundled libs directory for any previously-installed binary and
 * return the path to the newest one (by semver). Returns undefined if none
 * exists or the directory can't be read.
 *
 * Used as a fallback when the normal download/resolve path fails (e.g. no
 * network) so the extension can still start with a previously-cached binary.
 */
export async function findExistingExecutable(
    context: vscode.ExtensionContext
): Promise<string | undefined> {
    const libsRoot = getLibsRoot(context);

    let entries: string[];
    try {
        entries = await fs.readdir(libsRoot);
    } catch (err) {
        logger.debug(`No bundled libs directory to scan for fallback: ${err}`);
        return undefined;
    }

    const candidates: { version: string; execPath: string }[] = [];
    for (const entry of entries) {
        const execPath = getExecutablePath(context, entry);
        if (await fsapi.pathExists(execPath)) {
            candidates.push({ version: entry, execPath });
        }
    }

    if (candidates.length === 0) {
        return undefined;
    }

    candidates.sort((a, b) => compareVersionsDesc(a.version, b.version));
    return candidates[0].execPath;
}

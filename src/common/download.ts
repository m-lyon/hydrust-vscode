import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as https from 'https';
import * as crypto from 'crypto';
import { promisify } from 'util';
import { exec } from 'child_process';
import { logger } from './logger';
import { getPlatformInfo, getDownloadUrl, getChecksumUrl, getVersionedDir, getArchiveDirectoryName, isWindows } from './constants';
import { fsapi } from './vscodeapi';

const execAsync = promisify(exec);

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
 * Get the latest release version from GitHub
 */
async function getLatestVersion(): Promise<string> {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: '/repos/m-lyon/hydra-lsp/releases/latest',
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
                    const release = JSON.parse(data);
                    if (release.tag_name) {
                        resolve(release.tag_name);
                    } else {
                        reject(new Error('No tag_name in release data'));
                    }
                } catch (err) {
                    reject(err);
                }
            });
        }).on('error', reject);
    });
}

/**
 * Download and install the Hydra LSP server binary
 */
export async function downloadServer(
    version: string,
    context: vscode.ExtensionContext,
    progressCallback?: (message: string) => void
): Promise<string> {
    const progress = progressCallback || ((msg: string) => logger.info(msg));

    try {
        // Resolve version
        let resolvedVersion = version;
        if (version === 'latest' || !version) {
            progress('Fetching latest release version...');
            resolvedVersion = await getLatestVersion();
            logger.info(`Latest version: ${resolvedVersion}`);
        }

        // Ensure version starts with 'v'
        if (!resolvedVersion.startsWith('v')) {
            resolvedVersion = `v${resolvedVersion}`;
        }

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
        const archiveDirName = getArchiveDirectoryName(platformInfo);
        const executablePath = path.join(versionedDir, archiveDirName, platformInfo.executableName);

        // Download archive
        progress(`Downloading Hydra LSP ${resolvedVersion}...`);
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

        // Make executable on Unix systems
        if (!isWindows()) {
            await execAsync(`chmod +x "${executablePath}"`);
            logger.info('Made executable');
        }

        // Verify executable exists
        if (!(await fsapi.pathExists(executablePath))) {
            throw new Error(`Executable not found after extraction: ${executablePath}`);
        }

        progress(`Hydra LSP ${resolvedVersion} installed successfully`);
        return executablePath;
    } catch (err) {
        logger.error(`Failed to download server: ${err}`);
        throw err;
    }
}

/**
 * Check if the server binary needs to be downloaded
 */
export async function needsDownload(
    version: string,
    context: vscode.ExtensionContext
): Promise<boolean> {
    // Resolve version if 'latest'
    let resolvedVersion = version;
    if (version === 'latest' || !version) {
        try {
            resolvedVersion = await getLatestVersion();
            logger.info(`Latest version resolved to: ${resolvedVersion}`);
        } catch (err) {
            logger.warn(`Failed to resolve latest version: ${err}`);
            // If we can't resolve latest, we need to download
            return true;
        }
    }

    // Ensure version starts with 'v'
    if (!resolvedVersion.startsWith('v')) {
        resolvedVersion = `v${resolvedVersion}`;
    }

    const platformInfo = getPlatformInfo();
    const versionedDir = getVersionedDir(context, resolvedVersion);
    const archiveDirName = getArchiveDirectoryName(platformInfo);
    const executablePath = path.join(versionedDir, archiveDirName, platformInfo.executableName);

    // Check if executable exists in the versioned directory
    const exists = await fsapi.pathExists(executablePath);
    if (!exists) {
        logger.info(`Binary for version ${resolvedVersion} not found, download needed`);
        return true;
    }

    logger.info(`Binary for version ${resolvedVersion} already exists`);
    return false;
}

/**
 * Ensure the server binary is available, downloading if necessary
 */
export async function ensureServer(
    version: string,
    context: vscode.ExtensionContext
): Promise<string> {
    if (await needsDownload(version, context)) {
        logger.info(`Downloading Hydra LSP server version: ${version}`);

        // Show progress to user
        return await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Hydra LSP',
                cancellable: false,
            },
            async (progress) => {
                return await downloadServer(version, context, (message) => {
                    progress.report({ message });
                });
            }
        );
    }

    // Binary exists, return the versioned path
    let resolvedVersion = version;
    if (version === 'latest' || !version) {
        resolvedVersion = await getLatestVersion();
    }

    // Ensure version starts with 'v'
    if (!resolvedVersion.startsWith('v')) {
        resolvedVersion = `v${resolvedVersion}`;
    }

    const platformInfo = getPlatformInfo();
    const versionedDir = getVersionedDir(context, resolvedVersion);
    const archiveDirName = getArchiveDirectoryName(platformInfo);
    const executablePath = path.join(versionedDir, archiveDirName, platformInfo.executableName);

    return executablePath;
}

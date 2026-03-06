import * as path from 'path';
import * as os from 'os';

/**
 * Platform information for binary downloads
 */
export interface PlatformInfo {
    /** The platform identifier used in the archive filename */
    platform: string;
    /** The archive extension (tar.xz or zip) */
    archiveExt: string;
    /** The executable name */
    executableName: string;
}

/**
 * Get platform-specific information for downloads
 */
export function getPlatformInfo(): PlatformInfo {
    const platform = process.platform;
    const arch = process.arch;

    let platformId: string;
    let archiveExt: string;
    let executableName: string;

    if (platform === 'win32') {
        platformId = 'x86_64-pc-windows-msvc';
        archiveExt = 'zip';
        executableName = 'hydra-lsp.exe';
    } else if (platform === 'darwin') {
        if (arch === 'arm64') {
            platformId = 'aarch64-apple-darwin';
        } else {
            platformId = 'x86_64-apple-darwin';
        }
        archiveExt = 'tar.xz';
        executableName = 'hydra-lsp';
    } else if (platform === 'linux') {
        if (arch === 'arm64') {
            platformId = 'aarch64-unknown-linux-gnu';
        } else {
            // Default to glibc version, musl is less common
            platformId = 'x86_64-unknown-linux-gnu';
        }
        archiveExt = 'tar.xz';
        executableName = 'hydra-lsp';
    } else {
        throw new Error(`Unsupported platform: ${platform} ${arch}`);
    }

    return {
        platform: platformId,
        archiveExt,
        executableName,
    };
}

/**
 * Get the download URL for a specific version and platform
 */
export function getDownloadUrl(version: string, platformInfo: PlatformInfo): string {
    const { platform, archiveExt } = platformInfo;
    const filename = `hydra-lsp-${platform}.${archiveExt}`;
    return `https://github.com/m-lyon/hydra-lsp/releases/download/${version}/${filename}`;
}

/**
 * Get the checksum URL for a specific version and platform
 */
export function getChecksumUrl(version: string, platformInfo: PlatformInfo): string {
    const downloadUrl = getDownloadUrl(version, platformInfo);
    return `${downloadUrl}.sha256`;
}

/**
 * Get the archive directory name (the nested directory created when extracting)
 */
export function getArchiveDirectoryName(platformInfo: PlatformInfo): string {
    return `hydra-lsp-${platformInfo.platform}`;
}

/**
 * Get the platform-specific executable name
 */
export function getExecutableName(): string {
    return process.platform === 'win32' ? 'hydra-lsp.exe' : 'hydra-lsp';
}

/**
 * Get the bundled executable path
 */
export function getBundledExecutablePath(context: any): string {
    const executableName = getExecutableName();
    return path.join(context.extensionPath, 'bundled', 'libs', 'bin', executableName);
}

/**
 * Get the bundled directory path
 */
export function getBundledDir(context: any): string {
    return path.join(context.extensionPath, 'bundled', 'libs', 'bin');
}

/**
 * Get the versioned directory path for a specific version
 */
export function getVersionedDir(context: any, version: string): string {
    // Normalize version (remove 'v' prefix for directory name)
    const normalizedVersion = version.startsWith('v') ? version.slice(1) : version;
    return path.join(context.extensionPath, 'bundled', 'libs', normalizedVersion);
}

/**
 * Check if the current platform is Windows
 */
export function isWindows(): boolean {
    return process.platform === 'win32';
}

/**
 * Check if the current platform is macOS
 */
export function isMacOS(): boolean {
    return process.platform === 'darwin';
}

/**
 * Check if the current platform is Linux
 */
export function isLinux(): boolean {
    return process.platform === 'linux';
}

/**
 * Get the home directory
 */
export function getHomeDir(): string {
    return os.homedir();
}

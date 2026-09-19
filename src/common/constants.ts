import * as path from 'path';
import * as os from 'os';
import {
    BINARY_NAME_CANDIDATES,
    DISPLAY_NAME,
    LEGACY_BINARY_NAME,
    archiveName,
    parseServerVersion,
    serverExecutableName,
} from './compatTable';

/**
 * Names to look for when finding a server on PATH.
 *
 * Two entries where the server's own `find_hydrust_bin()` needs only
 * `hydrust`, because the extension has to keep working with a `hydra-lsp` a
 * user installed before the rename.
 *
 * When both are found, the higher version wins (see findBinaryPath), so an
 * old `hydra-lsp` left on PATH cannot shadow a newer `hydrust`. A `hydrust`
 * is only accepted if it reports v0.5.0 or later: before the two binaries
 * were merged it was the CLI, which exits 2 on `server`. On a tie, the
 * earlier name here wins.
 */
export const PATH_CANDIDATES: readonly string[] = [DISPLAY_NAME, LEGACY_BINARY_NAME];

/** The GitHub repository the server is released from, as `owner/name`. */
export const SERVER_REPO = 'm-lyon/hydra-lsp';

/**
 * A server release known to have an archive for every supported platform.
 *
 * Used when `latest` cannot be resolved and nothing is installed yet. Release
 * asset downloads are not subject to the GitHub API rate limit, so this still
 * works when the API is refusing requests. The release workflow rewrites it to
 * the newest suitable release before packaging (scripts/pin-server-version.mjs),
 * so the value committed here only has to be a working floor.
 */
export const FALLBACK_SERVER_VERSION = 'v0.4.2';

/**
 * Platform information for binary downloads
 */
export interface PlatformInfo {
    /** The platform identifier used in the archive filename */
    platform: string;
    /** The archive extension (tar.xz or zip) */
    archiveExt: string;
    /** What is appended to the executable's basename: '.exe', or nothing */
    executableSuffix: string;
}

/**
 * Get platform-specific information for downloads
 *
 * Deliberately says nothing about what the binary is called: that depends on
 * the server version, which this has no way of knowing.
 */
export function getPlatformInfo(): PlatformInfo {
    const platform = process.platform;
    const arch = process.arch;

    let platformId: string;
    let archiveExt: string;
    let executableSuffix: string;

    if (platform === 'win32') {
        platformId = 'x86_64-pc-windows-msvc';
        archiveExt = 'zip';
        executableSuffix = '.exe';
    } else if (platform === 'darwin') {
        if (arch === 'arm64') {
            platformId = 'aarch64-apple-darwin';
        } else {
            platformId = 'x86_64-apple-darwin';
        }
        archiveExt = 'tar.xz';
        executableSuffix = '';
    } else if (platform === 'linux') {
        if (arch === 'arm64') {
            platformId = 'aarch64-unknown-linux-gnu';
        } else {
            // Default to glibc version, musl is less common
            platformId = 'x86_64-unknown-linux-gnu';
        }
        archiveExt = 'tar.xz';
        executableSuffix = '';
    } else {
        throw new Error(`Unsupported platform: ${platform} ${arch}`);
    }

    return {
        platform: platformId,
        archiveExt,
        executableSuffix,
    };
}

/**
 * Get the download URL for a specific version and platform
 */
export function getDownloadUrl(version: string, platformInfo: PlatformInfo): string {
    const filename = getArchiveFileName(platformInfo, version);
    return `https://github.com/${SERVER_REPO}/releases/download/${version}/${filename}`;
}

/**
 * Get the checksum URL for a specific version and platform
 */
export function getChecksumUrl(version: string, platformInfo: PlatformInfo): string {
    const downloadUrl = getDownloadUrl(version, platformInfo);
    return `${downloadUrl}.sha256`;
}

/** Build an archive directory name from an already-chosen basename. */
function archiveDirectoryNameFor(baseName: string, platformInfo: PlatformInfo): string {
    return `${baseName}-${platformInfo.platform}`;
}

/**
 * Get the archive directory name (the nested directory created when extracting)
 *
 * `version` is a release tag or a bundled directory name, with or without the
 * 'v'. Anything unparseable is treated as a pre-rename version, which is what
 * every name on disk today is.
 */
export function getArchiveDirectoryName(platformInfo: PlatformInfo, version: string): string {
    return archiveDirectoryNameFor(archiveName(parseServerVersion(version)), platformInfo);
}

/** Get the release asset name for a specific version and platform */
export function getArchiveFileName(platformInfo: PlatformInfo, version: string): string {
    return `${getArchiveDirectoryName(platformInfo, version)}.${platformInfo.archiveExt}`;
}

/**
 * Every release asset name that could be the right one for this platform.
 *
 * Only for scanning releases, where the version is the thing being looked for.
 * Ordered newest naming first.
 */
export function getArchiveFileNameCandidates(platformInfo: PlatformInfo): string[] {
    return BINARY_NAME_CANDIDATES.map(
        (baseName) => `${archiveDirectoryNameFor(baseName, platformInfo)}.${platformInfo.archiveExt}`
    );
}

/**
 * The only part of the extension context these path helpers need.
 *
 * Declared here rather than importing vscode, so this file stays free of any
 * dependency on the extension host.
 */
export interface ExtensionPaths {
    globalStorageUri: { fsPath: string };
}

/**
 * Get the expected executable path for a specific version
 *
 * Both the directory and the file inside it are version-keyed, so a v0.4.0 and
 * a v0.5.0 install sit side by side under `bundled/libs` without either
 * needing to know about the other.
 */
export function getExecutablePath(context: ExtensionPaths, version: string): string {
    const platformInfo = getPlatformInfo();
    const versionedDir = getVersionedDir(context, version);
    const archiveDirName = getArchiveDirectoryName(platformInfo, version);
    const executable = `${serverExecutableName(parseServerVersion(version))}${platformInfo.executableSuffix}`;
    return path.join(versionedDir, archiveDirName, executable);
}

/**
 * Get the root directory that holds all per-version subdirectories of the
 * downloaded server.
 *
 * This lives in global storage rather than under the extension's install
 * directory, because that directory is replaced on every extension update and
 * would take every downloaded binary with it.
 */
export function getLibsRoot(context: ExtensionPaths): string {
    return path.join(context.globalStorageUri.fsPath, 'libs');
}

/**
 * Get the versioned directory path for a specific version
 */
export function getVersionedDir(context: ExtensionPaths, version: string): string {
    // Normalize version (remove 'v' prefix for directory name)
    const normalizedVersion = version.startsWith('v') ? version.slice(1) : version;
    return path.join(getLibsRoot(context), normalizedVersion);
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

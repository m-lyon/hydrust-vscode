import * as path from 'path';
import * as os from 'os';

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

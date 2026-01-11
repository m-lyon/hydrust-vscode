import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

/**
 * VSCode API wrappers for file system operations
 */
export const fsapi = {
    /**
     * Check if a path exists
     */
    async pathExists(path: string): Promise<boolean> {
        try {
            await fs.access(path);
            return true;
        } catch {
            return false;
        }
    },

    /**
     * Read file contents
     */
    async readFile(path: string, encoding: BufferEncoding = 'utf8'): Promise<string> {
        return await fs.readFile(path, encoding);
    },

    /**
     * Write file contents
     */
    async writeFile(path: string, content: string): Promise<void> {
        await fs.writeFile(path, content);
    },

    /**
     * Ensure directory exists
     */
    async ensureDir(path: string): Promise<void> {
        await fs.ensureDir(path);
    },

    /**
     * Get stat information
     */
    async stat(path: string): Promise<fs.Stats> {
        return await fs.stat(path);
    },
};

/**
 * Execute a file with arguments
 */
export async function executeFile(
    executable: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<string> {
    const command = `"${executable}" ${args.map((arg) => `"${arg}"`).join(' ')}`;
    const { stdout } = await execAsync(command, {
        cwd: options?.cwd,
        env: options?.env || process.env,
        maxBuffer: 1024 * 1024 * 10, // 10MB
    });
    return stdout;
}

/**
 * Get workspace folder for a URI
 */
export function getWorkspaceFolder(uri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
    if (!uri) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        return workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0] : undefined;
    }
    return vscode.workspace.getWorkspaceFolder(uri);
}

/**
 * Get the project root directory
 */
export async function getProjectRoot(): Promise<string | undefined> {
    const workspaceFolder = getWorkspaceFolder();
    return workspaceFolder?.uri.fsPath;
}

/**
 * Check if workspace is trusted
 */
export function isWorkspaceTrusted(): boolean {
    return vscode.workspace.isTrusted;
}

/**
 * Register a command
 */
export function registerCommand(
    command: string,
    callback: (...args: unknown[]) => unknown,
    thisArg?: unknown
): vscode.Disposable {
    return vscode.commands.registerCommand(command, callback, thisArg);
}

/**
 * Show error message
 */
export function showErrorMessage(message: string, ...items: string[]): Thenable<string | undefined> {
    return vscode.window.showErrorMessage(message, ...items);
}

/**
 * Show warning message
 */
export function showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined> {
    return vscode.window.showWarningMessage(message, ...items);
}

/**
 * Show information message
 */
export function showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined> {
    return vscode.window.showInformationMessage(message, ...items);
}

/**
 * Watch configuration changes
 */
export function onDidChangeConfiguration(
    listener: (e: vscode.ConfigurationChangeEvent) => unknown,
    thisArgs?: unknown,
    disposables?: vscode.Disposable[]
): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(listener, thisArgs, disposables);
}

import * as vscode from 'vscode';
import * as fs from 'fs-extra';

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
     * Ensure directory exists
     */
    async ensureDir(path: string): Promise<void> {
        await fs.ensureDir(path);
    },
};

/**
 * Get the project root directory
 */
export function getProjectRoot(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    return workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : undefined;
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
 * Watch configuration changes
 */
export function onDidChangeConfiguration(
    listener: (e: vscode.ConfigurationChangeEvent) => unknown,
    thisArgs?: unknown,
    disposables?: vscode.Disposable[]
): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(listener, thisArgs, disposables);
}

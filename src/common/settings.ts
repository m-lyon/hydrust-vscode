import * as vscode from 'vscode';

/**
 * Extension settings interface
 */
export interface ExtensionSettings {
    path: string[];
    interpreter: string[];
    importStrategy: 'fromEnvironment' | 'useBundled';
    serverVersion: string;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    traceServer: 'off' | 'messages' | 'verbose';
}

/**
 * Get extension settings from workspace configuration
 */
export function getExtensionSettings(serverId: string, projectRoot?: string): ExtensionSettings {
    const config = vscode.workspace.getConfiguration(serverId, projectRoot ? vscode.Uri.file(projectRoot) : undefined);

    return {
        path: config.get<string[]>('path', []),
        interpreter: config.get<string[]>('interpreter', []),
        importStrategy: config.get<'fromEnvironment' | 'useBundled'>('importStrategy', 'fromEnvironment'),
        serverVersion: config.get<string>('serverVersion', 'latest'),
        logLevel: config.get<'debug' | 'info' | 'warn' | 'error'>('logLevel', 'info'),
        traceServer: config.get<'off' | 'messages' | 'verbose'>('trace.server', 'off'),
    };
}

/**
 * Check if configuration changed for our extension
 */
export function checkIfConfigurationChanged(e: vscode.ConfigurationChangeEvent, serverId: string): boolean {
    const sections = ['path', 'interpreter', 'importStrategy', 'serverVersion', 'logLevel', 'trace.server'];
    return sections.some((section) => e.affectsConfiguration(`${serverId}.${section}`));
}

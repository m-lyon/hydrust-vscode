import * as vscode from 'vscode';

/**
 * Status bar item for the extension
 */
export class StatusBar {
    private statusBarItem: vscode.StatusBarItem;

    constructor(private readonly serverId: string) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = `${serverId}.showLogs`;
        this.statusBarItem.text = '$(loading~spin) Hydra LSP';
        this.statusBarItem.tooltip = 'Hydra LSP is starting...';
    }

    public show(): void {
        this.statusBarItem.show();
    }

    public hide(): void {
        this.statusBarItem.hide();
    }

    public dispose(): void {
        this.statusBarItem.dispose();
    }

    public setReady(): void {
        this.statusBarItem.text = '$(check) Hydra LSP';
        this.statusBarItem.tooltip = 'Hydra LSP is ready';
        this.statusBarItem.backgroundColor = undefined;
    }

    public setError(message: string): void {
        this.statusBarItem.text = '$(error) Hydra LSP';
        this.statusBarItem.tooltip = message;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }

    public setWarning(message: string): void {
        this.statusBarItem.text = '$(warning) Hydra LSP';
        this.statusBarItem.tooltip = message;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }

    public setLoading(message?: string): void {
        this.statusBarItem.text = '$(loading~spin) Hydra LSP';
        this.statusBarItem.tooltip = message || 'Hydra LSP is starting...';
        this.statusBarItem.backgroundColor = undefined;
    }

    public setText(text: string): void {
        this.statusBarItem.text = text;
    }

    public setTooltip(tooltip: string): void {
        this.statusBarItem.tooltip = tooltip;
    }
}

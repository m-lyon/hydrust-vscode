import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { LazyOutputChannel, logger } from "./common/logger";
import { startServer, stopServer } from './common/server';
import { getExtensionSettings, checkIfConfigurationChanged } from './common/settings';
import { getProjectRoot, registerCommand, onDidChangeConfiguration } from './common/vscodeapi';

let lsClient: LanguageClient | undefined;

/**
 * Server information
 */
interface ServerInfo {
    name: string;
    module: string;
}

/**
 * Load server defaults
 */
function loadServerDefaults(): ServerInfo {
    return {
        name: 'Hydra LSP',
        module: 'hydra-lsp',
    };
}

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const serverInfo = loadServerDefaults();
    const serverName = serverInfo.name;
    const serverId = serverInfo.module;

    // Log Server information
    logger.info(`Name: ${serverInfo.name}`);
    logger.info(`Module: ${serverInfo.module}`);
    logger.debug(`Full Server Info: ${JSON.stringify(serverInfo)}`);

    // Create output channels for the server and trace logs
    const outputChannel = vscode.window.createOutputChannel(`${serverName} Language Server`);
    const traceOutputChannel = new LazyOutputChannel(`${serverName} Language Server Trace`);

    // Make sure that these channels are disposed when the extension is deactivated.
    context.subscriptions.push(outputChannel);
    context.subscriptions.push(traceOutputChannel);
    context.subscriptions.push(logger.channel);

    // Server startup function
    const runServer = async () => {
        try {
            if (lsClient) {
                await stopServer(lsClient);
            }

            const projectRoot = await getProjectRoot();
            const settings = getExtensionSettings(serverId, projectRoot);

            // Validate Python interpreter (if workspace is trusted)
            if (vscode.workspace.isTrusted) {
                if (settings.interpreter.length === 0) {
                    const message = 'Python interpreter not configured. Please configure a Python interpreter.';
                    logger.warn(message);
                    // return;
                }
            }

            lsClient = await startServer(settings, serverId, serverName, outputChannel, traceOutputChannel, context);

            // Set up client event handlers
            lsClient.onDidChangeState((event) => {
                logger.debug(`Client state changed: ${JSON.stringify(event)}`);
            });

        } catch (err) {
            const message = `Failed to start Hydra LSP server: ${err}`;
            logger.error(message);
            vscode.window.showErrorMessage(message);
        }
    };

    // Register event handlers
    context.subscriptions.push(
        onDidChangeConfiguration(async (e: vscode.ConfigurationChangeEvent) => {
            if (checkIfConfigurationChanged(e, serverId)) {
                logger.info('Configuration changed, restarting server...');
                await runServer();
            }
        }),
        registerCommand(`${serverId}.restart`, async () => {
            logger.info('Restart command triggered');
            await runServer();
        }),
        registerCommand(`${serverId}.showLogs`, () => {
            logger.channel.show();
        }),
        registerCommand(`${serverId}.showServerLogs`, () => {
            outputChannel.show();
        }),
    );

    // Initialize
    setImmediate(async () => {
        await runServer();
    });
}

/**
 * Extension deactivation
 */
export async function deactivate(): Promise<void> {
    logger.info('Deactivating Hydra LSP extension...');
    if (lsClient) {
        await stopServer(lsClient);
    }
}

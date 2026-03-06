
import * as vscode from 'vscode';
import which from 'which';
import { logger } from './logger';
import { ExtensionSettings } from './settings';
import { ensureServer } from './download';
import { fsapi } from './vscodeapi';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    Executable,
} from 'vscode-languageclient/node';

/**
 * Find the path to the hydra-lsp binary
 */
async function findBinaryPath(settings: ExtensionSettings, context: vscode.ExtensionContext): Promise<string> {

    // 1. User-specified path takes priority
    if (settings.path.length > 0) {
        for (const p of settings.path) {
            if (await fsapi.pathExists(p)) {
                logger.info(`Using 'path' setting: ${p}`);
                return p;
            }
        }
        logger.warn('No valid path found in settings.path');
    }

    // 2. Use environment if explicitly requested
    if (settings.importStrategy === 'fromEnvironment') {
        try {
            const environmentPath = await which('hydra-lsp', { nothrow: true });
            if (environmentPath) {
                logger.info(`Using environment executable: ${environmentPath}`);
                return environmentPath;
            }
        } catch (err) {
            logger.debug(`Error checking PATH: ${err}`);
        }
    }

    // 3. Fallback to bundled
    logger.info('Falling back to bundled executable');
    return await ensureServer(settings.serverVersion, context);
}

/**
 * Start the language server
 */
export async function startServer(
    settings: ExtensionSettings,
    serverId: string,
    serverName: string,
    outputChannel: vscode.OutputChannel,
    traceOutputChannel: vscode.OutputChannel,
    context: vscode.ExtensionContext
): Promise<LanguageClient> {
    logger.info('Starting Hydra LSP server...');

    // Find the binary
    const serverPath = await findBinaryPath(settings, context);
    logger.info(`Server path: ${serverPath}`);

    // Check if binary exists
    if (!(await fsapi.pathExists(serverPath))) {
        const message = `Hydra LSP binary not found at: ${serverPath}`;
        logger.error(message);
        throw new Error(message);
    }

    // Set up server options
    const serverExecutable: Executable = {
        command: serverPath,
        args: [],
        options: {
            env: process.env,
        },
    };

    const serverOptions: ServerOptions = {
        run: serverExecutable,
        debug: serverExecutable,
    };

    // Set up client options
    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'yaml' }],
        outputChannel: outputChannel,
        traceOutputChannel: traceOutputChannel,
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{yaml,yml}'),
        },
        initializationOptions: {
            settings: {
                pythonInterpreter: settings.interpreter.length > 0 ? settings.interpreter[0] : undefined,
                logLevel: settings.logLevel,
                disabledRules: settings.disabledRules,
                enableHover: settings.enableHover,
                enableCompletion: settings.enableCompletion,
                enableSignatureHelp: settings.enableSignatureHelp,
                enableGotoDefinition: settings.enableGotoDefinition,
                enableSemanticTokens: settings.enableSemanticTokens,
                enableDiagnostics: settings.enableDiagnostics,
            },
        },
    };

    // Create and start the client
    const client = new LanguageClient(serverId, serverName, serverOptions, clientOptions);

    try {
        await client.start();
        logger.info('Hydra LSP server started successfully');
    } catch (err) {
        logger.error(`Failed to start server: ${err}`);
        throw err;
    }

    return client;
}

/**
 * Stop the language server
 */
export async function stopServer(client: LanguageClient): Promise<void> {
    logger.info('Stopping Hydra LSP server...');
    try {
        await client.stop();
        logger.info('Hydra LSP server stopped');
    } catch (err) {
        logger.error(`Error stopping server: ${err}`);
    }
}

/**
 * Restart the language server
 */
export async function restartServer(
    client: LanguageClient,
    settings: ExtensionSettings,
    serverId: string,
    serverName: string,
    outputChannel: vscode.OutputChannel,
    traceOutputChannel: vscode.OutputChannel,
    context: vscode.ExtensionContext
): Promise<LanguageClient> {
    await stopServer(client);
    return await startServer(settings, serverId, serverName, outputChannel, traceOutputChannel, context);
}

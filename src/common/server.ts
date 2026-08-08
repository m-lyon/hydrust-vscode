
import * as vscode from 'vscode';
import which from 'which';
import { logger } from './logger';
import { BINARY_NAME } from './constants';
import { ExtensionSettings } from './settings';
import { ensureServer, findExistingExecutable } from './download';
import { ResolvedBinary, ServerCompat } from './compat';
import { fsapi } from './vscodeapi';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    Executable,
} from 'vscode-languageclient/node';

/**
 * A running server, together with what the extension knows about what it
 * supports.
 */
export interface StartedServer {
    client: LanguageClient;
    compat: ServerCompat;
}

/**
 * Find the hydrust server binary, and note which of the three resolution paths
 * found it. The bundled path also knows the release tag, which saves having to
 * ask the binary its version later.
 */
async function findBinaryPath(settings: ExtensionSettings, context: vscode.ExtensionContext): Promise<ResolvedBinary> {

    // 1. User-specified path takes priority
    if (settings.path.length > 0) {
        if (await fsapi.pathExists(settings.path)) {
            logger.info(`Using 'path' setting: ${settings.path}`);
            return { path: settings.path, source: 'serverPath' };
        }
        logger.warn('No valid path found in settings.path');
    }

    // 2. Use environment if explicitly requested
    if (settings.importStrategy === 'fromEnvironment') {
        try {
            const environmentPath = await which(BINARY_NAME, { nothrow: true });
            if (environmentPath) {
                logger.info(`Using environment executable: ${environmentPath}`);
                return { path: environmentPath, source: 'environment' };
            }
        } catch (err) {
            logger.debug(`Error checking PATH: ${err}`);
        }
    }

    // 3. Fallback to bundled (download if needed)
    logger.info('Falling back to bundled executable');
    try {
        const installed = await ensureServer(settings.serverVersion, context);
        return { path: installed.path, source: 'bundled', version: installed.version };
    } catch (err) {
        // ensureServer can fail for network/API reasons (GitHub down, offline,
        // unexpected payload, etc.). Before giving up, look for a previously
        // downloaded binary on disk so the extension can still start.
        logger.warn(`ensureServer failed: ${err}`);
        const cached = await findExistingExecutable(context);
        if (cached) {
            logger.warn(`Falling back to previously installed binary: ${cached.path}`);
            return { path: cached.path, source: 'bundled', version: cached.version };
        }
        logger.error('No previously installed binary available to fall back to.');
        throw err;
    }
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
    context: vscode.ExtensionContext,
    projectRoot?: string
): Promise<StartedServer> {
    logger.info('Starting Hydrust Server...');

    // Find the binary
    const binary = await findBinaryPath(settings, context);
    logger.info(`Server path: ${binary.path}`);

    // Check if binary exists
    if (!(await fsapi.pathExists(binary.path))) {
        const message = `Hydrust Server binary not found at: ${binary.path}`;
        logger.error(message);
        throw new Error(message);
    }

    // Work out what this particular server understands before talking to it,
    // so the payload below can be adjusted if it turns out to be an old one.
    const compat = await ServerCompat.beforeLaunch(
        binary,
        serverId,
        settings.disabledRules,
        projectRoot,
        context
    );

    // Set up server options
    const serverExecutable: Executable = {
        command: binary.path,
        args: [],
        options: {
            env: process.env,
        },
    };

    const serverOptions: ServerOptions = {
        run: serverExecutable,
        debug: serverExecutable,
    };

    const initializationSettings = compat.transformSettings({
        pythonInterpreter: settings.interpreter ? settings.interpreter : undefined,
        disabledRules: settings.disabledRules,
        enableHover: settings.enableHover,
        enableCompletion: settings.enableCompletion,
        enableSignatureHelp: settings.enableSignatureHelp,
        enableGotoDefinition: settings.enableGotoDefinition,
        enableSemanticTokens: settings.enableSemanticTokens,
        enableDiagnostics: settings.enableDiagnostics,
        // Omit the setting entirely when left at 0: the server sizes its
        // thread pools from the CPU count when the value is absent, but
        // clamps an explicit 0 up to a single thread.
        numThreads: settings.numThreads > 0 ? settings.numThreads : undefined,
    });

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'yaml' }],
        outputChannel: outputChannel,
        traceOutputChannel: traceOutputChannel,
        initializationOptions: {
            settings: initializationSettings,
        },
    };

    // Create and start the client
    const client = new LanguageClient(serverId, serverName, serverOptions, clientOptions);

    try {
        await client.start();
        logger.info('Hydrust Server started successfully');
    } catch (err) {
        logger.error(`Failed to start server: ${err}`);
        throw err;
    }

    // The server has now told us who it is, which beats anything guessed above.
    await compat.afterLaunch(client.initializeResult, context);

    return { client, compat };
}

/**
 * Stop the language server
 */
export async function stopServer(client: LanguageClient): Promise<void> {
    logger.info('Stopping Hydrust Server...');
    try {
        await client.stop();
        logger.info('Hydrust Server stopped');
    } catch (err) {
        logger.error(`Error stopping server: ${err}`);
    }
}


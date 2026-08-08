import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { LazyOutputChannel, logger } from "./common/logger";
import { startServer, stopServer } from './common/server';
import { getExtensionSettings, checkIfConfigurationChanged } from './common/settings';
import { getProjectRoot, registerCommand, onDidChangeConfiguration } from './common/vscodeapi';
import { CompatReporter } from './common/compat';
import { createRunQueue } from './common/runQueue';

let lsClient: LanguageClient | undefined;

/**
 * The most recently requested server run, so `deactivate` can wait for it.
 *
 * A run clears `lsClient` at the start and only sets it again at the end, so a
 * deactivation landing in between would stop nothing and leave the client the
 * run went on to create with no owner. Runs settle in the order they were
 * requested, so waiting on the last one waits for all of them.
 */
let pendingRun: Promise<void> | undefined;

/** Set once `deactivate` starts, so a run in flight does not outlive it. */
let deactivating = false;

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
        name: 'Hydrust',
        module: 'hydrust',
    };
}

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // Both outlive a single activation, so start from a clean slate in case the
    // extension is activated again without the module being reloaded.
    deactivating = false;
    pendingRun = undefined;

    const serverInfo = loadServerDefaults();
    const serverName = serverInfo.name;
    const serverId = serverInfo.module;

    // Log Server information
    logger.info(`Name: ${serverInfo.name}`);
    logger.info(`Module: ${serverInfo.module}`);
    logger.debug(`Full Server Info: ${JSON.stringify(serverInfo)}`);

    // Create output channels for the server and trace logs
    const outputChannel = vscode.window.createOutputChannel(`${serverName} Server`);
    const traceOutputChannel = new LazyOutputChannel(`${serverName} Server Trace`);

    // Make sure that these channels are disposed when the extension is deactivated.
    context.subscriptions.push(outputChannel);
    context.subscriptions.push(traceOutputChannel);
    context.subscriptions.push(logger.channel);

    // Tracks which server is running and what it supports. Lives for the whole
    // session and is refreshed after every start, so the `when` clause contexts
    // and the "Show server info" command survive restarts.
    const compatReporter = new CompatReporter(serverId);

    // Server startup, serialized so concurrent triggers don't overlap and leave
    // a language client behind that nothing holds on to. See createRunQueue.
    const queueServerRun = createRunQueue(() => doRunServer());
    const runServer = (): Promise<void> => {
        pendingRun = queueServerRun();
        return pendingRun;
    };

    const doRunServer = async () => {
        if (deactivating) {
            return;
        }
        try {
            if (lsClient) {
                await stopServer(lsClient);
                lsClient = undefined;
                await compatReporter.update(undefined);
            }

            const projectRoot = await getProjectRoot();
            const settings = getExtensionSettings(serverId, projectRoot);

            // Try to get Python interpreter from Python extension first
            const pythonPath = await getPythonInterpreter();

            if (settings.interpreter) {
                logger.info(`Using configured Python interpreter: ${settings.interpreter}`);
            } else if (pythonPath) {
                logger.info(`Using Python interpreter from Python extension: ${pythonPath}`);
                settings.interpreter = pythonPath;
            } else {
                logger.info('No Python interpreter found, Hydrust will attempt to auto-detect one.');
            }

            const started = await startServer(
                settings,
                serverId,
                serverName,
                outputChannel,
                traceOutputChannel,
                context,
                projectRoot
            );
            lsClient = started.client;

            if (deactivating) {
                // Deactivation happened while this start was in flight, after
                // it was too late to bail out. Stop what was just created
                // rather than leaving it running with nobody to stop it.
                await stopServer(lsClient);
                lsClient = undefined;
                return;
            }

            // Set up client event handlers
            lsClient.onDidChangeState((event) => {
                logger.debug(`Client state changed: ${JSON.stringify(event)}`);
            });

            await compatReporter.update(started.compat);

        } catch (err) {
            const message = `Failed to start Hydrust Server: ${err}`;
            logger.error(message);
            vscode.window.showErrorMessage(message);
            await compatReporter.update(undefined);
        }
    };

    // Listen for Python interpreter changes from ms-python extension
    try {
        const pythonExtension = vscode.extensions.getExtension('ms-python.python');
        if (pythonExtension) {
            if (!pythonExtension.isActive) {
                await pythonExtension.activate();
            }
            const pythonApi = pythonExtension.exports;
            if (pythonApi?.environments?.onDidChangeActiveEnvironmentPath) {
                context.subscriptions.push(
                    pythonApi.environments.onDidChangeActiveEnvironmentPath(async () => {
                        logger.info('Python environment changed, restarting server...');
                        await runServer();
                    }),
                );
            }
        }
    } catch (error) {
        logger.warn(`Failed to register Python environment change listener: ${error}`);
    }

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
        registerCommand(`${serverId}.showServerInfo`, () => {
            compatReporter.showDetails();
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
    logger.info('Deactivating Hydrust extension...');
    deactivating = true;
    // Let any start in flight finish first. Until it does, `lsClient` says
    // nothing useful: a restart clears it before stopping and only sets it
    // again once the new client is up.
    if (pendingRun) {
        await pendingRun.catch(() => undefined);
        pendingRun = undefined;
    }
    if (lsClient) {
        await stopServer(lsClient);
        lsClient = undefined;
    }
    // The output channels, commands and listeners are disposed through
    // context.subscriptions, so there is nothing extra to tear down here.
}

// Add this function to get the Python interpreter
async function getPythonInterpreter(): Promise<string | undefined> {
    try {
        const pythonExtension = vscode.extensions.getExtension('ms-python.python');
        if (!pythonExtension) {
            logger.warn('Python extension not found');
            return undefined;
        }

        if (!pythonExtension.isActive) {
            await pythonExtension.activate();
        }

        const pythonApi = pythonExtension.exports;

        // Get the active environment path
        const activeEnvPath = pythonApi.environments.getActiveEnvironmentPath();
        const activeEnv = await pythonApi.environments.resolveEnvironment(activeEnvPath);

        return activeEnv?.executable.uri?.fsPath;
    } catch (error) {
        logger.error(`Failed to get Python interpreter: ${error}`);
        return undefined;
    }
}

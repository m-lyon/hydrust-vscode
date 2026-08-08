import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { LazyOutputChannel, logger } from "./common/logger";
import { startServer, stopServer } from './common/server';
import { getExtensionSettings, checkIfConfigurationChanged } from './common/settings';
import { getProjectRoot, registerCommand, onDidChangeConfiguration } from './common/vscodeapi';
import { CompatReporter } from './common/compat';

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
        name: 'Hydrust',
        module: 'hydrust',
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

    // Server startup function — serialized so concurrent triggers don't overlap.
    // At most one start runs at a time and at most one waits behind it; any
    // further request while one is already waiting joins that same queued start.
    let activeRun: Promise<void> | undefined;
    let queuedRun: Promise<void> | undefined;

    // Chain one start onto `previous`, keeping the two variables above honest as
    // it moves from queued, to running, to finished. The queue slot is freed at
    // the moment the start actually begins rather than when it ends, so a
    // request arriving mid-run queues behind it instead of running alongside it.
    const chainRunServer = (previous: Promise<void>): Promise<void> => {
        const run: Promise<void> = previous.then(() => {
            if (queuedRun === run) {
                queuedRun = undefined;
            }
            activeRun = run;
            return doRunServer();
        });
        const clear = () => {
            if (activeRun === run) {
                activeRun = undefined;
            }
        };
        void run.then(clear, clear);
        return run;
    };

    const runServer = (): Promise<void> => {
        if (activeRun) {
            if (!queuedRun) {
                queuedRun = chainRunServer(activeRun.catch(() => undefined));
            }
            return queuedRun;
        }
        activeRun = chainRunServer(Promise.resolve());
        return activeRun;
    };

    const doRunServer = async () => {
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

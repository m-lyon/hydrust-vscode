
import * as path from 'path';
import * as vscode from 'vscode';
import which from 'which';
import { logger } from './logger';
import { PATH_CANDIDATES } from './constants';
import {
    DISPLAY_NAME,
    SERVER_ARGS,
    ServerVersion,
    UNIFIED_BINARY_VERSION,
    compareServerVersions,
    formatServerVersion,
    isAtLeast,
} from './compatTable';
import { ExtensionSettings } from './settings';
import { InvalidServerVersionError, ensureServer, findExistingExecutable, markVersionUsed } from './download';
import { ResolvedBinary, ServerCompat, probeBinaryVersion } from './compat';
import { buildInitializationSettings } from './initializationSettings';
import { fsapi } from './vscodeapi';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    Executable,
    State,
} from 'vscode-languageclient/node';

/** How often a running bundled server re-records its version as used, so other windows do not prune it. */
const MARK_USED_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * A running server, together with what the extension knows about what it
 * supports.
 */
export interface StartedServer {
    client: LanguageClient;
    compat: ServerCompat;
}

/**
 * Whether a binary is called `hydrust`. Windows file names are
 * case-insensitive and `which` can hand back `hydrust.EXE`.
 */
function isHydrustBinary(binaryPath: string): boolean {
    return path.basename(binaryPath).toLowerCase().replace(/\.exe$/, '') === DISPLAY_NAME;
}

/**
 * Whether a binary called `hydrust` can be launched as a language server.
 *
 * A pre-merge `hydrust` is the CLI, which answers --version but exits 2 on
 * `server`. Only a merged release is a language server. Anything not called
 * `hydrust` is assumed to be one. An unknown version is accepted only when
 * `allowUnknown` is set.
 */
function isUsableServer(binaryPath: string, version: ServerVersion | undefined, allowUnknown = false): boolean {
    if (!isHydrustBinary(binaryPath)) {
        return true;
    }
    if (!version) {
        return allowUnknown;
    }
    return isAtLeast(version, UNIFIED_BINARY_VERSION);
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
            const version = isHydrustBinary(settings.path)
                ? await probeBinaryVersion(settings.path, context)
                : undefined;
            // Respect the user's choice unless the binary is known to be too old.
            if (isUsableServer(settings.path, version, true)) {
                logger.info(`Using 'path' setting: ${settings.path}`);
                return { path: settings.path, source: 'serverPath' };
            }
            logger.warn(
                `Ignoring 'path' setting ${settings.path}: not ${DISPLAY_NAME} ` +
                `${formatServerVersion(UNIFIED_BINARY_VERSION)} or later, so not a language server.`
            );
            void vscode.window.showWarningMessage(
                `${settings.path} is not ${DISPLAY_NAME} ${formatServerVersion(UNIFIED_BINARY_VERSION)} ` +
                'or later, so it cannot run the language server. Falling back to another server.'
            );
        } else {
            logger.warn('No valid path found in settings.path');
        }
    }

    // 2. Use environment if explicitly requested
    if (settings.importStrategy === 'fromEnvironment') {
        try {
            // Pick the highest version among the names on PATH, so an old
            // `hydra-lsp` cannot shadow a newer `hydrust`. A version that
            // cannot be determined loses to any known one.
            let best: { path: string; version?: ServerVersion } | undefined;
            for (const candidate of PATH_CANDIDATES) {
                const environmentPath = await which(candidate, { nothrow: true });
                if (!environmentPath) {
                    continue;
                }
                let version = await probeBinaryVersion(environmentPath, context);
                if (!version && isHydrustBinary(environmentPath)) {
                    // A remembered failure may just have been a slow first
                    // run, so ask again before ruling a hydrust out.
                    version = await probeBinaryVersion(environmentPath, context, undefined, true);
                }
                if (!isUsableServer(environmentPath, version)) {
                    logger.info(
                        `Ignoring ${environmentPath}: not ${DISPLAY_NAME} ` +
                        `${formatServerVersion(UNIFIED_BINARY_VERSION)} or later, so not a language server.`
                    );
                    continue;
                }
                if (!best) {
                    best = { path: environmentPath, version };
                } else if (version && (!best.version || compareServerVersions(version, best.version) > 0)) {
                    logger.info(`Ignoring ${best.path}: ${environmentPath} is newer.`);
                    best = { path: environmentPath, version };
                } else {
                    logger.info(`Ignoring ${environmentPath}: ${best.path} is at least as new.`);
                }
            }
            if (best) {
                logger.info(`Using environment executable: ${best.path}`);
                return { path: best.path, source: 'environment' };
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
        if (err instanceof InvalidServerVersionError) {
            throw err;
        }
        // ensureServer can fail for network/API reasons (GitHub down, offline,
        // unexpected payload, etc.). Before giving up, look for a previously
        // downloaded binary on disk so the extension can still start.
        logger.warn(`ensureServer failed: ${err}`);
        // `latest` already falls back to installed binaries inside ensureServer.
        const isLatest = settings.serverVersion === 'latest' || !settings.serverVersion;
        const cached = isLatest ? undefined : await findExistingExecutable(context);
        if (cached) {
            logger.warn(`Falling back to previously installed binary: ${cached.path}`);
            await markVersionUsed(context, cached.version);
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

    // Set up server options. SERVER_ARGS is unconditional, including for
    // servers released before the subcommand existed; see the constant.
    const serverExecutable: Executable = {
        command: binary.path,
        args: [...SERVER_ARGS],
        options: {
            env: process.env,
        },
    };

    const serverOptions: ServerOptions = {
        run: serverExecutable,
        debug: serverExecutable,
    };

    const initializationSettings = compat.transformSettings(buildInitializationSettings(settings));

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

    const bundledVersion = binary.source === 'bundled' ? binary.version : undefined;
    if (bundledVersion) {
        let refresh: NodeJS.Timeout | undefined;
        const markUsed = () => void markVersionUsed(context, bundledVersion).catch((err) => logger.debug(`Could not record server use: ${err}`));
        client.onDidChangeState(({ newState }) => {
            if (newState === State.Running) {
                markUsed();
                refresh ??= setInterval(markUsed, MARK_USED_INTERVAL_MS);
            } else if (newState === State.Stopped && refresh) {
                clearInterval(refresh);
                refresh = undefined;
            }
        });
    }

    try {
        await client.start();
        logger.info('Hydrust Server started successfully');
    } catch (err) {
        logger.error(`Failed to start server: ${err}`);
        throw err;
    }

    // The server has now told us who it is, which beats anything guessed above.
    // Failing here must not throw: the client is already running, and the caller
    // only gets a handle to stop it if this function returns.
    try {
        await compat.afterLaunch(client.initializeResult, context);
    } catch (err) {
        logger.warn(`Could not work out what the running server supports: ${err}`);
    }

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


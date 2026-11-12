
import * as path from 'path';
import * as vscode from 'vscode';
import which from 'which';
import { logger } from './logger';
import { PATH_CANDIDATES } from './constants';
import {
    DISPLAY_NAME,
    SERVER_ARGS,
    ServerSource,
    ServerVersion,
    UNIFIED_BINARY_VERSION,
    compareServerVersions,
    formatServerVersion,
    isAtLeast,
} from './compatTable';
import { ExtensionSettings } from './settings';
import { InvalidServerVersionError, ensureServer, findExistingExecutable, markVersionUsed } from './download';
import { ProbeOptions, ResolvedBinary, ServerCompat, probeBinaryVersion } from './compat';
import { buildInitializationSettings } from './initializationSettings';
import { fsapi } from './vscodeapi';
import { findHydrustInInterpreter } from './pythonEnvironment';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    Executable,
    State,
} from 'vscode-languageclient/node';

/** How often a running bundled server re-records its version as used, so other windows do not prune it. */
const MARK_USED_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** hydrust binaries whose remembered unknown version has been re-checked this session. */
const recheckedUnknown = new Set<string>();

/** `serverPath` settings already warned about this session, so restarts do not repeat the toast. */
const warnedServerPaths = new Set<string>();

/** Why a `hydrust` too old to be a language server is ignored. */
const NOT_A_LANGUAGE_SERVER =
    `not ${DISPLAY_NAME} ${formatServerVersion(UNIFIED_BINARY_VERSION)} or later, so not a language server.`;

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
 * case-insensitive and `which` can hand back `hydrust.EXE` or a shim such as
 * `hydrust.cmd`.
 */
function isHydrustBinary(binaryPath: string): boolean {
    return path.basename(binaryPath).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '') === DISPLAY_NAME;
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
 * Whether a remembered unknown version for this binary should be asked again:
 * true the first time per session, since the failure may just have been a
 * slow first run.
 */
function recheckUnknownOnce(binaryPath: string): boolean {
    if (recheckedUnknown.has(binaryPath)) {
        return false;
    }
    recheckedUnknown.add(binaryPath);
    return true;
}

/** A binary found by one of the resolution paths, with its probed version if any. */
function resolved(binaryPath: string, source: ServerSource, version?: ServerVersion): ResolvedBinary {
    return { path: binaryPath, source, version: version && formatServerVersion(version) };
}

/**
 * The binary named by the `serverPath` setting, unless it is missing or known
 * to be too old to be a language server.
 */
async function findFromServerPath(
    serverPath: string,
    context: vscode.ExtensionContext,
    probe: ProbeOptions
): Promise<ResolvedBinary | undefined> {
    if (!(await fsapi.pathExists(serverPath))) {
        logger.warn('No valid path found in settings.path');
        return undefined;
    }
    const version = isHydrustBinary(serverPath)
        ? await probeBinaryVersion(serverPath, context, { ...probe, retryUnknown: recheckUnknownOnce(serverPath) })
        : undefined;
    // Respect the user's choice unless the binary is known to be too old.
    if (isUsableServer(serverPath, version, true)) {
        logger.info(`Using 'path' setting: ${serverPath}`);
        return resolved(serverPath, 'serverPath', version);
    }
    logger.warn(`Ignoring 'path' setting ${serverPath}: ${NOT_A_LANGUAGE_SERVER}`);
    if (!warnedServerPaths.has(serverPath)) {
        warnedServerPaths.add(serverPath);
        void vscode.window.showWarningMessage(
            `${serverPath} is not ${DISPLAY_NAME} ${formatServerVersion(UNIFIED_BINARY_VERSION)} ` +
            'or later, so it cannot run the language server. Falling back to another server.'
        );
    }
    return undefined;
}

/**
 * Look for a hydrust installed in the selected Python environment.
 */
async function findInPythonEnvironment(
    interpreter: string,
    context: vscode.ExtensionContext,
    probe: ProbeOptions
): Promise<ResolvedBinary | undefined> {
    try {
        const binaryPath = await findHydrustInInterpreter(interpreter, context.extensionPath);
        if (!binaryPath) {
            return undefined;
        }
        if (!(await fsapi.pathExists(binaryPath))) {
            logger.warn(`Ignoring ${binaryPath}: reported by ${interpreter} but not found on disk.`);
            return undefined;
        }
        const version = await probeBinaryVersion(binaryPath, context, {
            ...probe,
            retryUnknown: recheckUnknownOnce(binaryPath),
        });
        if (!isUsableServer(binaryPath, version)) {
            logger.warn(
                `Ignoring ${binaryPath} from ${interpreter}: ` +
                (version ? NOT_A_LANGUAGE_SERVER : 'could not determine its version.')
            );
            return undefined;
        }
        logger.info(`Using ${binaryPath}, installed in the environment of ${interpreter}`);
        return resolved(binaryPath, 'pythonEnvironment', version);
    } catch (err) {
        logger.debug(`Error checking the Python environment: ${err}`);
        return undefined;
    }
}

/**
 * Look for a language server on PATH, picking the highest version among the
 * names on PATH so an old `hydra-lsp` cannot shadow a newer `hydrust`. A
 * version that cannot be determined loses to any known one.
 */
async function findOnPath(context: vscode.ExtensionContext, probe: ProbeOptions): Promise<ResolvedBinary | undefined> {
    try {
        let best: { path: string; version?: ServerVersion } | undefined;
        for (const candidate of PATH_CANDIDATES) {
            const environmentPath = await which(candidate, { nothrow: true });
            if (!environmentPath) {
                continue;
            }
            // A remembered failure may just have been a slow first run,
            // so a hydrust gets asked again once per session before it
            // is ruled out.
            const recheck = isHydrustBinary(environmentPath) && recheckUnknownOnce(environmentPath);
            const version = await probeBinaryVersion(environmentPath, context, { ...probe, retryUnknown: recheck });
            if (!isUsableServer(environmentPath, version)) {
                if (version) {
                    logger.info(`Ignoring ${environmentPath}: ${NOT_A_LANGUAGE_SERVER}`);
                } else {
                    logger.warn(
                        `Ignoring ${environmentPath}: could not determine its version, so cannot tell ` +
                        `whether it is ${DISPLAY_NAME} ${formatServerVersion(UNIFIED_BINARY_VERSION)} or later.`
                    );
                }
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
            return resolved(best.path, 'environment', best.version);
        }
    } catch (err) {
        logger.debug(`Error checking PATH: ${err}`);
    }
    return undefined;
}

/**
 * The bundled server, downloaded if needed. If the download fails, fall back
 * to one downloaded earlier.
 */
async function findBundled(serverVersion: string, context: vscode.ExtensionContext): Promise<ResolvedBinary> {
    logger.info('Falling back to bundled executable');
    try {
        const installed = await ensureServer(serverVersion, context);
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
        const isLatest = serverVersion === 'latest' || !serverVersion;
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
 * Find the hydrust server binary, and note which of the resolution paths
 * found it, along with its version when already known (the bundled release
 * tag, or a probe made while choosing), which saves asking the binary again.
 */
async function findBinaryPath(
    settings: ExtensionSettings,
    context: vscode.ExtensionContext,
    probe: ProbeOptions
): Promise<ResolvedBinary> {
    // 1. User-specified path takes priority
    if (settings.path.length > 0) {
        const fromSetting = await findFromServerPath(settings.path, context, probe);
        if (fromSetting) {
            return fromSetting;
        }
    }

    // 2. Use environment if explicitly requested: the selected Python
    // environment, then PATH.
    if (settings.importStrategy === 'fromEnvironment') {
        const fromEnvironment =
            (settings.interpreter ? await findInPythonEnvironment(settings.interpreter, context, probe) : undefined) ??
            (await findOnPath(context, probe));
        if (fromEnvironment) {
            return fromEnvironment;
        }
    }

    // 3. Fallback to bundled (download if needed)
    return findBundled(settings.serverVersion, context);
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
    projectRoot?: string,
    probe: ProbeOptions = {}
): Promise<StartedServer> {
    logger.info('Starting Hydrust Server...');

    // Find the binary
    const binary = await findBinaryPath(settings, context, probe);
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
        context,
        probe
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


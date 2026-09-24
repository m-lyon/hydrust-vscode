
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
import { ResolvedBinary, ServerCompat, interpreterFingerprint, probeBinaryVersion } from './compat';
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

/**
 * What each Python interpreter last reported as its hydrust, including the
 * common answer of nothing at all. Starting an interpreter is slow, and a
 * restart happens for every settings change and every interpreter change, so
 * the answer is remembered for the session; `forgetServerLookups` drops it
 * when the user asks for a restart, which is what they do after installing
 * hydrust into the environment.
 */
const interpreterBinaries = new Map<string, string | undefined>();

/** globalState key holding what each interpreter last reported. */
export const INTERPRETER_CACHE_KEY = 'hydrust.interpreterLookup.v1';

/** How many interpreter answers to keep. The oldest are dropped past this. */
export const INTERPRETER_CACHE_LIMIT = 16;

/**
 * Forget what the interpreters reported, so the next start asks them again,
 * along with the once-per-session `--version` recheck of binaries whose
 * version is remembered as unknown, so a restart re-probes those too. The
 * stored interpreter answers go too when a context is given, since a window
 * reload is not what the user runs after installing hydrust into the
 * environment.
 */
export async function forgetServerLookups(context?: vscode.ExtensionContext): Promise<void> {
    interpreterBinaries.clear();
    recheckedUnknown.clear();
    if (context) {
        try {
            await context.globalState.update(INTERPRETER_CACHE_KEY, {});
        } catch (err) {
            logger.warn(`Could not forget what the interpreters reported: ${err}`);
        }
    }
}

/** Store what an interpreter answered, dropping the oldest entries past the cap. */
async function rememberInterpreterLookup(
    context: vscode.ExtensionContext,
    fingerprint: string,
    found: string | undefined
): Promise<void> {
    const existing = context.globalState.get<Record<string, string | null>>(INTERPRETER_CACHE_KEY, {});
    const cache: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(existing)) {
        if (key !== fingerprint) {
            cache[key] = value;
        }
    }
    cache[fingerprint] = found ?? null;

    const keys = Object.keys(cache);
    for (const stale of keys.slice(0, Math.max(0, keys.length - INTERPRETER_CACHE_LIMIT))) {
        delete cache[stale];
    }

    await context.globalState.update(INTERPRETER_CACHE_KEY, cache);
}

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

/**
 * Ask an interpreter where its hydrust is, or hand back what it said earlier.
 * A remembered path that has since gone (a reinstall, a deleted environment)
 * is worth asking about again; anything else it answered stands for the
 * session, apart from a path that is not on disk at all. An interpreter that
 * could not be asked at all is not remembered,
 * so a later start asks it again, except one that hung: every start would
 * otherwise stall for the whole lookup timeout before falling back to PATH.
 *
 * A definitive answer is also stored in globalState against the interpreter's
 * path, its own file stats (not the symlink target's) and the state of the
 * directory it lives in, so a new window does not pay the interpreter startup
 * again, while installing hydrust into the environment drops the entry. A hang is only remembered for the
 * session, since it says nothing about the environment, and an installed
 * hydrust that could not say where its binary is is not remembered at all,
 * since fixing that does not change the interpreter the entry is keyed on.
 * **Hydrust: Restart Server** clears both.
 */
async function lookUpInterpreter(
    interpreter: string,
    context: vscode.ExtensionContext,
    probeTimeoutMs?: number
): Promise<string | undefined> {
    if (interpreterBinaries.has(interpreter)) {
        const remembered = interpreterBinaries.get(interpreter);
        if (!remembered || await fsapi.pathExists(remembered)) {
            return remembered;
        }
    }

    const fingerprint = await interpreterFingerprint(interpreter);
    const stored = context.globalState.get<Record<string, string | null>>(INTERPRETER_CACHE_KEY, {});
    if (fingerprint && Object.prototype.hasOwnProperty.call(stored, fingerprint)) {
        const remembered = stored[fingerprint] ?? undefined;
        if (!remembered || await fsapi.pathExists(remembered)) {
            interpreterBinaries.set(interpreter, remembered);
            // Rewrite it so an interpreter still in use keeps its place.
            await rememberInterpreterLookup(context, fingerprint, remembered);
            return remembered;
        }
    }

    const lookup = await findHydrustInInterpreter(interpreter, probeTimeoutMs);
    if (lookup.kind === 'couldNotAsk') {
        if (lookup.timedOut) {
            interpreterBinaries.set(interpreter, undefined);
        }
        return undefined;
    }
    const found = lookup.kind === 'found' ? lookup.path : undefined;
    if (found && !(await fsapi.pathExists(found))) {
        // Not remembered: the interpreter did answer, so the environment has
        // hydrust and a later start should ask again rather than be stuck on
        // PATH for the session (a half-finished install, or output that ran
        // into the answer).
        logger.warn(`Ignoring ${found}: reported by ${interpreter} but not found on disk.`);
        return undefined;
    }
    if (lookup.kind === 'notInstalled' && lookup.broken) {
        // Not remembered at all: fixing a half-finished install does not
        // change the interpreter, so every later start should ask again.
        return undefined;
    }
    interpreterBinaries.set(interpreter, found);
    if (fingerprint) {
        await rememberInterpreterLookup(context, fingerprint, found);
    }
    return found;
}

/**
 * Look for a hydrust installed in the selected Python environment, for example
 * by `uv add --dev hydrust`. Resolves to undefined whenever that does not give a
 * usable server, so the caller can carry on to PATH: in particular for every
 * environment without the `hydrust` package, which includes every server before
 * v0.5.0, since none was published to PyPI.
 *
 * `probeTimeoutMs` covers both the interpreter lookup and the `--version`
 * probe, and only exists so the tests can make a hang happen quickly.
 */
async function findInPythonEnvironment(
    interpreter: string,
    context: vscode.ExtensionContext,
    probeTimeoutMs?: number
): Promise<ResolvedBinary | undefined> {
    const binaryPath = await lookUpInterpreter(interpreter, context, probeTimeoutMs);
    if (!binaryPath) {
        return undefined;
    }
    const version = await probeBinaryVersion(binaryPath, context, probeTimeoutMs, recheckUnknownOnce(binaryPath));
    if (!isUsableServer(binaryPath, version)) {
        logger.warn(
            `Ignoring ${binaryPath} from ${interpreter}: ` +
            (version
                ? `not ${DISPLAY_NAME} ${formatServerVersion(UNIFIED_BINARY_VERSION)} or later, so not a language server.`
                : 'could not determine its version.')
        );
        return undefined;
    }
    logger.info(`Using ${binaryPath}, installed in the environment of ${interpreter}`);
    return { path: binaryPath, source: 'pythonEnvironment', version: version && formatServerVersion(version) };
}

/**
 * Find the hydrust server binary, and note which of the resolution paths
 * found it, along with its version when already known (the bundled release
 * tag, or a probe made while choosing), which saves asking the binary again.
 */
async function findBinaryPath(
    settings: ExtensionSettings,
    context: vscode.ExtensionContext,
    probeTimeoutMs?: number
): Promise<ResolvedBinary> {

    // 1. User-specified path takes priority
    if (settings.path.length > 0) {
        if (await fsapi.pathExists(settings.path)) {
            const version = isHydrustBinary(settings.path)
                ? await probeBinaryVersion(settings.path, context, probeTimeoutMs, recheckUnknownOnce(settings.path))
                : undefined;
            // Respect the user's choice unless the binary is known to be too old.
            if (isUsableServer(settings.path, version, true)) {
                logger.info(`Using 'path' setting: ${settings.path}`);
                return { path: settings.path, source: 'serverPath', version: version && formatServerVersion(version) };
            }
            logger.warn(
                `Ignoring 'path' setting ${settings.path}: not ${DISPLAY_NAME} ` +
                `${formatServerVersion(UNIFIED_BINARY_VERSION)} or later, so not a language server.`
            );
            if (!warnedServerPaths.has(settings.path)) {
                warnedServerPaths.add(settings.path);
                void vscode.window.showWarningMessage(
                    `${settings.path} is not ${DISPLAY_NAME} ${formatServerVersion(UNIFIED_BINARY_VERSION)} ` +
                    'or later, so it cannot run the language server. Falling back to another server.'
                );
            }
        } else {
            logger.warn('No valid path found in settings.path');
        }
    }

    // 2. Use environment if explicitly requested
    if (settings.importStrategy === 'fromEnvironment') {
        // 2a. The selected Python environment. Its hydrust wins over one on
        // PATH even when that one is newer: it is the version the project
        // pinned, and the one `hydrust check` in that environment would run.
        if (settings.interpreter) {
            try {
                const fromPython = await findInPythonEnvironment(settings.interpreter, context, probeTimeoutMs);
                if (fromPython) {
                    return fromPython;
                }
            } catch (err) {
                logger.debug(`Error checking the Python environment: ${err}`);
            }
        }

        // 2b. PATH.
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
                // A remembered failure may just have been a slow first run,
                // so a hydrust gets asked again once per session before it
                // is ruled out.
                const recheck = isHydrustBinary(environmentPath) && recheckUnknownOnce(environmentPath);
                const version = await probeBinaryVersion(environmentPath, context, probeTimeoutMs, recheck);
                if (!isUsableServer(environmentPath, version)) {
                    if (version) {
                        logger.info(
                            `Ignoring ${environmentPath}: not ${DISPLAY_NAME} ` +
                            `${formatServerVersion(UNIFIED_BINARY_VERSION)} or later, so not a language server.`
                        );
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
                return {
                    path: best.path,
                    source: 'environment',
                    version: best.version && formatServerVersion(best.version),
                };
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
    projectRoot?: string,
    probeTimeoutMs?: number
): Promise<StartedServer> {
    logger.info('Starting Hydrust Server...');

    // Find the binary
    const binary = await findBinaryPath(settings, context, probeTimeoutMs);
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
        probeTimeoutMs
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


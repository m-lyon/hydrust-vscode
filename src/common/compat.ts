import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import { spawn } from 'child_process';
import { logger } from './logger';
import { BINARY_NAME } from './constants';
import {
    ASSUMED_PRE_NEGOTIATION_VERSION,
    CAPABILITY_NEGOTIATION_VERSION,
    CLIENT_PROTOCOL_VERSION,
    CompatReport,
    FEATURE_COMPAT,
    HydrustCapabilities,
    MINIMUM_SERVER_VERSION,
    RuleRewrite,
    SETTING_COMPAT,
    ServerSource,
    ServerVersion,
    advertisesPullDiagnostics,
    buildCompatReport,
    compareServerVersions,
    formatServerVersion,
    isAtLeast,
    parseHydrustCapabilities,
    parseServerVersion,
    readServerInfoVersion,
    transformSettingsPayload,
} from './compatTable';

/** How long to wait for `--version` before giving up on the binary. */
export const PROBE_TIMEOUT_MS = 2000;

/** globalState key holding remembered `--version` results. */
export const PROBE_CACHE_KEY = 'hydrust.serverVersionProbe.v1';

/** How many probe results to keep. The oldest are dropped past this. */
export const PROBE_CACHE_LIMIT = 32;

/** A server binary the extension has picked out, before it has been started. */
export interface ResolvedBinary {
    /** Absolute path to the executable. */
    path: string;
    /** Which of the three resolution paths found it. */
    source: ServerSource;
    /** Release tag, when the resolution path already knows it. */
    version?: string;
}

/** Human-readable name for each way the binary can be found. */
const SOURCE_LABELS: Record<ServerSource, string> = {
    serverPath: 'hydrust.serverPath setting',
    environment: 'found on PATH',
    bundled: 'downloaded by the extension',
};

/**
 * Build the cache key for a binary: its path plus enough of its file stats to
 * notice when it has been replaced in place.
 */
async function binaryFingerprint(binaryPath: string): Promise<string | undefined> {
    try {
        const stats = await fs.stat(binaryPath);
        return `${binaryPath}|${Math.round(stats.mtimeMs)}|${stats.size}`;
    } catch (err) {
        logger.debug(`Could not stat ${binaryPath} for the version cache: ${err}`);
        return undefined;
    }
}

/**
 * Run `<binary> --version` and hand back whatever it printed on stdout.
 *
 * A server from v0.4.0 prints one line and exits. Anything older has no such
 * flag: it ignores its arguments and starts its stdio LSP loop instead, so it
 * prints nothing and never exits. That is why this always runs under a short
 * timeout and kills the child.
 *
 * A hang is a valid answer, but it only means "could not tell". It does not
 * prove the server is old — any server given a flag it does not recognise falls
 * through to the same LSP loop.
 *
 * `timeoutMs` only exists so the tests can make a hang happen quickly. Nothing
 * in the extension passes it, so the real wait is always PROBE_TIMEOUT_MS.
 */
function runVersionFlag(binaryPath: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<string | undefined> {
    return new Promise((resolve) => {
        let settled = false;
        let stdout = '';

        const finish = (value: string | undefined) => {
            if (!settled) {
                settled = true;
                resolve(value);
            }
        };

        let child;
        try {
            child = spawn(binaryPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            logger.debug(`Could not spawn ${binaryPath} --version: ${err}`);
            finish(undefined);
            return;
        }

        const timer = setTimeout(() => {
            logger.debug(
                `${binaryPath} --version did not answer within ${timeoutMs}ms. ` +
                'It has most likely started its LSP loop instead, so it will be killed ' +
                'and the version treated as unknown.'
            );
            child.kill('SIGKILL');
            finish(undefined);
        }, timeoutMs);

        child.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        // Drain stderr as well. Old servers log there on startup and a full pipe
        // would stall the child before the timeout can fire.
        child.stderr?.on('data', () => undefined);
        child.on('error', (err) => {
            clearTimeout(timer);
            logger.debug(`${binaryPath} --version failed: ${err}`);
            finish(undefined);
        });
        child.on('close', () => {
            clearTimeout(timer);
            finish(stdout.trim().length > 0 ? stdout : undefined);
        });
    });
}

/**
 * Work out the version of a binary, remembering the answer so restarts do not
 * keep spawning processes.
 */
async function probeBinaryVersion(
    binaryPath: string,
    context: vscode.ExtensionContext,
    timeoutMs?: number
): Promise<ServerVersion | undefined> {
    const fingerprint = await binaryFingerprint(binaryPath);
    const cache = context.globalState.get<Record<string, string | null>>(PROBE_CACHE_KEY, {});

    if (fingerprint && Object.prototype.hasOwnProperty.call(cache, fingerprint)) {
        const cached = cache[fingerprint];
        if (cached === null) {
            logger.debug(`Version of ${binaryPath} is still unknown (remembered from an earlier check).`);
            // Rewrite it so using a binary keeps it alive in the cache.
            await rememberVersion(context, fingerprint, undefined);
            return undefined;
        }
        const parsed = parseServerVersion(cached);
        if (parsed) {
            logger.debug(`Version of ${binaryPath} is ${formatServerVersion(parsed)} (remembered).`);
            await rememberVersion(context, fingerprint, parsed);
            return parsed;
        }
    }

    const output = await runVersionFlag(binaryPath, timeoutMs);
    const version = parseServerVersion(output);
    if (fingerprint) {
        await rememberVersion(context, fingerprint, version);
    }
    if (version) {
        logger.info(`${BINARY_NAME} at ${binaryPath} reports ${formatServerVersion(version)}.`);
    }
    return version;
}

/**
 * Store a probe result (or the lack of one) against a binary fingerprint.
 *
 * The fingerprint changes every time the binary is replaced, so without a cap
 * the cache would collect one dead entry per upgrade and keep it for the life
 * of the install. Entries are rewritten in order with the one just used last,
 * and anything past the cap falls off the front. Reads call this too, so the
 * binary that falls off is the one left untouched the longest rather than the
 * one written the longest ago.
 */
async function rememberVersion(
    context: vscode.ExtensionContext,
    fingerprint: string,
    version: ServerVersion | undefined
): Promise<void> {
    const existing = context.globalState.get<Record<string, string | null>>(PROBE_CACHE_KEY, {});
    const cache: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(existing)) {
        if (key !== fingerprint) {
            cache[key] = value;
        }
    }
    cache[fingerprint] = version ? formatServerVersion(version) : null;

    const keys = Object.keys(cache);
    for (const stale of keys.slice(0, Math.max(0, keys.length - PROBE_CACHE_LIMIT))) {
        delete cache[stale];
    }

    await context.globalState.update(PROBE_CACHE_KEY, cache);
}

/** True when the two configuration values should be treated as the same. */
function valuesEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The configuration scopes VS Code resolves, strongest first.
 *
 * A folder value beats a workspace value, which beats a user value, and a
 * language-specific value beats the plain value in the same scope. The list has
 * to be walked in this order: taking the first scope that happens to hold a
 * value would report a setting the server never sees.
 */
const SCOPE_PRECEDENCE = [
    'workspaceFolderLanguageValue',
    'workspaceFolderValue',
    'workspaceLanguageValue',
    'workspaceValue',
    'globalLanguageValue',
    'globalValue',
] as const;

/**
 * List the settings the user has actually changed.
 *
 * A setting left at its default is not worth warning about, even if the server
 * ignores it, so only settings whose effective value differs from the default
 * are returned.
 */
function findConfiguredSettings(serverId: string, resource: vscode.Uri | undefined): string[] {
    const config = vscode.workspace.getConfiguration(serverId, resource);
    const configured: string[] = [];

    for (const setting of SETTING_COMPAT) {
        const details = config.inspect(setting.configKey);
        if (!details) {
            continue;
        }
        const effective = SCOPE_PRECEDENCE.map((scope) => details[scope]).find((value) => value !== undefined);
        if (effective === undefined) {
            continue;
        }
        if (valuesEqual(effective, details.defaultLanguageValue ?? details.defaultValue)) {
            continue;
        }
        configured.push(setting.configKey);
    }

    return configured;
}

/**
 * Everything known about one server run: which binary it is, what version, and
 * what it will quietly ignore.
 *
 * One of these is built per server start. It is created before launch so the
 * settings payload can be adjusted, then updated from the server's own
 * InitializeResult once it is running.
 */
export class ServerCompat {
    private version: ServerVersion | undefined;
    private capabilities: HydrustCapabilities | undefined;
    private report: CompatReport;
    /**
     * Renames actually made to the payload that was sent.
     *
     * The payload is built from the pre-launch version guess, but the report is
     * rebuilt from the version the server reports. Without this, a rule that
     * needed renaming for an old server but was sent unchanged because the
     * guess was missing would look handled when it was not.
     */
    private appliedRewrites: RuleRewrite[] = [];

    private constructor(
        readonly binary: ResolvedBinary,
        private readonly serverId: string,
        private readonly configuredSettings: string[],
        private readonly configuredRules: string[],
        version: ServerVersion | undefined
    ) {
        this.version = version;
        this.report = buildCompatReport({
            version,
            configuredSettings,
            configuredRules,
        });
    }

    /**
     * Find out everything possible about the binary before it is launched.
     *
     * The bundled path already knows its release tag, so no process is spawned.
     * The other two paths have to ask the binary itself.
     *
     * `probeTimeoutMs` only exists so the tests can make the `--version` probe
     * give up quickly. The extension never passes it.
     */
    static async beforeLaunch(
        binary: ResolvedBinary,
        serverId: string,
        disabledRules: string[],
        projectRoot: string | undefined,
        context: vscode.ExtensionContext,
        probeTimeoutMs?: number
    ): Promise<ServerCompat> {
        const resource = projectRoot ? vscode.Uri.file(projectRoot) : undefined;
        const configuredSettings = findConfiguredSettings(serverId, resource);

        let version = parseServerVersion(binary.version);
        if (version) {
            logger.info(`Server version ${formatServerVersion(version)} (${SOURCE_LABELS[binary.source]}).`);
        } else {
            version = await probeBinaryVersion(binary.path, context, probeTimeoutMs);
        }

        if (!version) {
            logger.warn(
                `Could not determine the ${BINARY_NAME} version before launch. ` +
                'Assuming the least capable behaviour: no optional features, and the ' +
                'settings payload will be sent exactly as configured.'
            );
        } else if (!isAtLeast(version, MINIMUM_SERVER_VERSION)) {
            logger.warn(
                `${BINARY_NAME} ${formatServerVersion(version)} is older than the minimum ` +
                `supported ${formatServerVersion(MINIMUM_SERVER_VERSION)}.`
            );
        }

        return new ServerCompat(binary, serverId, configuredSettings, disabledRules, version);
    }

    /**
     * Adjust the `initializationOptions.settings` payload for this server.
     *
     * Currently this only renames diagnostic rules that the target server spells
     * differently. Nothing is changed when the version is unknown.
     *
     * The renames that were made are kept, because they are the only record of
     * what the server was really sent once the version turns out to be
     * something other than the pre-launch guess.
     */
    transformSettings(payload: Record<string, unknown>): Record<string, unknown> {
        const { payload: next, rewrites, droppedRules } = transformSettingsPayload(payload, this.version);
        this.appliedRewrites = rewrites;
        for (const dropped of droppedRules) {
            logger.warn(
                `Ignoring ${this.serverId}.disabledRules entry ${JSON.stringify(dropped)}: ` +
                'rule codes have to be strings.'
            );
        }
        for (const rewrite of rewrites) {
            logger.info(
                `Sending disabled rule '${rewrite.from}' as '${rewrite.to}': that is what ` +
                `${BINARY_NAME} ${this.versionLabel} calls it.`
            );
        }
        return next;
    }

    /**
     * Take the server at its word now that it has started.
     *
     * `serverInfo.version` is filled in by every release, so this is the most
     * reliable version source there is and it always replaces the pre-launch
     * guess. The experimental capability block, when present, replaces the
     * version table completely.
     */
    async afterLaunch(initializeResult: unknown, context: vscode.ExtensionContext): Promise<void> {
        const reported = readServerInfoVersion(initializeResult);
        if (reported) {
            if (!this.version || compareServerVersions(reported, this.version) !== 0) {
                logger.info(`Server reported itself as ${formatServerVersion(reported)} during initialize.`);
            }
            this.version = reported;
            // Remember it so the next launch can adjust the payload correctly
            // even for a binary with no --version flag.
            const fingerprint = await binaryFingerprint(this.binary.path);
            if (fingerprint) {
                await rememberVersion(context, fingerprint, reported);
            }
        }

        this.capabilities = parseHydrustCapabilities(initializeResult);
        if (this.capabilities) {
            logger.info(
                'Server described its own capabilities; using them instead of the built-in version table.'
            );
            logger.debug(`Capability block: ${JSON.stringify(this.capabilities)}`);
        } else if (this.version && isAtLeast(this.version, CAPABILITY_NEGOTIATION_VERSION)) {
            logger.warn(
                `${BINARY_NAME} ${this.versionLabel} should describe its own capabilities but did not. ` +
                'Falling back to the built-in version table.'
            );
        } else if (!this.version) {
            logger.info(
                'No capability block and no version: every server from ' +
                `${formatServerVersion(CAPABILITY_NEGOTIATION_VERSION)} sends one, so this must be ` +
                `${formatServerVersion(ASSUMED_PRE_NEGOTIATION_VERSION)} or older. Assuming ` +
                `${formatServerVersion(ASSUMED_PRE_NEGOTIATION_VERSION)}.`
            );
        }

        this.report = buildCompatReport({
            version: this.version,
            capabilities: this.capabilities,
            configuredSettings: this.configuredSettings,
            configuredRules: this.configuredRules,
            appliedRuleRewrites: this.appliedRewrites,
            pullDiagnosticsAdvertised: advertisesPullDiagnostics(initializeResult),
        });

        if (this.report.protocolNewerThanClient) {
            logger.warn(
                `Server speaks capability protocol ${this.capabilities?.protocolVersion}, but this ` +
                `extension only understands up to ${CLIENT_PROTOCOL_VERSION}. Some server features ` +
                'may not be picked up. Updating the extension should fix that.'
            );
        }

        this.logFindings();
    }

    /** Write the full picture to the log channel. */
    private logFindings(): void {
        for (const entry of this.report.unsupportedSettings) {
            logger.warn(`${this.serverId}.${entry.name} has no effect: ${entry.reason}`);
        }
        for (const entry of this.report.unsupportedRules) {
            logger.warn(`Disabled rule '${entry.name}' has no effect: ${entry.reason}`);
        }
        for (const [name, available] of Object.entries(this.report.features)) {
            logger.debug(`Feature ${name}: ${available ? 'yes' : 'no'}`);
        }
    }

    /** 'v0.3.0', or 'unknown version' when it could not be worked out. */
    get versionLabel(): string {
        return this.version ? formatServerVersion(this.version) : 'unknown version';
    }

    /** Settings the user changed that this server ignores. */
    get unsupportedSettings(): readonly { name: string; reason: string }[] {
        return this.report.unsupportedSettings;
    }

    /** Rule codes the user listed that this server ignores. */
    get unsupportedRules(): readonly { name: string; reason: string }[] {
        return this.report.unsupportedRules;
    }

    /** Feature name to whether this server has it. */
    get features(): Record<string, boolean> {
        return this.report.features;
    }

    /** The whole story, as lines suitable for the log. */
    describe(): string[] {
        const lines = [
            `Version: ${this.versionLabel}`,
            `Binary: ${this.binary.path}`,
            `Found via: ${SOURCE_LABELS[this.binary.source]}`,
            `Capability source: ${this.report.authoritative ? 'reported by the server' : 'built-in version table'}`,
        ];

        const featureNames = Object.entries(this.report.features).map(
            ([name, available]) => `${name}: ${available ? 'yes' : 'no'}`
        );
        lines.push(`Features: ${featureNames.join(', ')}`);

        if (this.report.unsupportedSettings.length === 0 && this.report.unsupportedRules.length === 0) {
            lines.push('All configured settings are supported by this server.');
            return lines;
        }

        if (this.report.unsupportedSettings.length > 0) {
            lines.push('Settings this server ignores:');
            for (const entry of this.report.unsupportedSettings) {
                lines.push(`  ${this.serverId}.${entry.name} — ${entry.reason}`);
            }
        }
        if (this.report.unsupportedRules.length > 0) {
            lines.push('Disabled rules this server ignores:');
            for (const entry of this.report.unsupportedRules) {
                lines.push(`  ${entry.name} — ${entry.reason}`);
            }
        }
        return lines;
    }
}

/**
 * Owns the parts of the compatibility story that outlive a single server run:
 * the `when` clause contexts and the answer to "what is running right now".
 *
 * Nothing here interrupts the user. Everything the extension works out about a
 * server goes to the log channel, which the "Show server info" command reveals
 * on demand.
 *
 * Created once during activation and updated after each start.
 */
export class CompatReporter {
    private current: ServerCompat | undefined;
    private publishedContexts = new Set<string>();

    constructor(private readonly serverId: string) {}

    /** Take on a freshly started server, or clear everything when it failed. */
    async update(compat: ServerCompat | undefined): Promise<void> {
        this.current = compat;
        await this.publishContexts();
    }

    /** Show what the extension knows, and reveal the log channel. */
    showDetails(): void {
        if (!this.current) {
            void vscode.window.showInformationMessage('Hydrust: the language server is not running.');
            logger.channel.show();
            return;
        }
        logger.info('Hydrust server details:');
        for (const line of this.current.describe()) {
            logger.info(`  ${line}`);
        }
        logger.channel.show();
    }

    /**
     * Publish feature availability for `when` clauses in package.json.
     *
     * Covers the features this extension knows about plus anything extra the
     * server named, and clears keys set by a previous run so a restart onto an
     * older server can't leave a stale `true` behind.
     */
    private async publishContexts(): Promise<void> {
        const available = this.current?.features ?? {};
        const names = new Set([...FEATURE_COMPAT.map((feature) => feature.name), ...Object.keys(available)]);

        for (const stale of this.publishedContexts) {
            names.add(stale);
        }

        for (const name of names) {
            await vscode.commands.executeCommand(
                'setContext',
                `${this.serverId}.supports.${name}`,
                available[name] ?? false
            );
        }

        // Only the keys currently on need clearing next time. A key already
        // published as false is off whatever the next server looks like, so
        // keeping it here would grow the set for the rest of the session.
        this.publishedContexts = new Set(
            Object.entries(available)
                .filter(([, isAvailable]) => isAvailable)
                .map(([name]) => name)
        );
    }
}

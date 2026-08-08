/**
 * What each released hydra-lsp server actually understands.
 *
 * The extension can be pointed at any released server binary, and older
 * servers quietly ignore settings they were never taught to read. This file
 * records which server release first read each setting and first accepted each
 * diagnostic rule code, so the extension can tell the user what is being
 * dropped instead of leaving them guessing.
 *
 * Everything here is a plain function or plain data. Nothing imports 'vscode',
 * so this file can be exercised by a plain node script or test runner without
 * an extension host.
 *
 * Evidence for every entry was read out of the tagged sources in the server
 * repository (github.com/m-lyon/hydra-lsp). Tag and line references are quoted
 * next to each entry so the table can be re-checked later.
 */

import { BINARY_NAME } from './constants';

/** A server version with the leading 'v' and any suffix stripped off. */
export interface ServerVersion {
    major: number;
    minor: number;
    patch: number;
}

/** Where the extension found the server binary it is about to run. */
export type ServerSource = 'serverPath' | 'environment' | 'bundled';

/** Build a version literal. Only used to keep the table below readable. */
function ver(major: number, minor: number, patch: number): ServerVersion {
    return { major, minor, patch };
}

/**
 * Pull the first version-looking token out of arbitrary text.
 *
 * Deliberately forgiving: it copes with 'hydrust-server 0.4.0', 'hydra-lsp
 * 0.4.0', 'v0.3.0', '0.3.0-dev' and a trailing newline, because the exact
 * shape of `--version` output is not something the extension should depend on.
 */
export function parseServerVersion(text: string | undefined): ServerVersion | undefined {
    if (!text) {
        return undefined;
    }
    const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
    if (!match) {
        return undefined;
    }
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: match[3] ? Number(match[3]) : 0,
    };
}

/** Render a version the way the release tags do, e.g. 'v0.3.0'. */
export function formatServerVersion(version: ServerVersion): string {
    return `v${version.major}.${version.minor}.${version.patch}`;
}

/** Negative when a is older, positive when a is newer, zero when equal. */
export function compareServerVersions(a: ServerVersion, b: ServerVersion): number {
    return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** True when `version` is `minimum` or anything newer. */
export function isAtLeast(version: ServerVersion, minimum: ServerVersion): boolean {
    return compareServerVersions(version, minimum) >= 0;
}

/**
 * The oldest server this client refuses to run.
 *
 * Set to the very first release on purpose. Every released server from v0.1.0
 * onwards speaks the same core LSP surface this client uses (full text sync,
 * hover, completion, signature help, goto definition, semantic tokens and push
 * diagnostics), and unknown keys in `initializationOptions.settings` are simply
 * skipped rather than treated as an error. No released version is genuinely
 * broken with this client, only less capable, so the extension warns instead of
 * refusing to start. Raise this only if a future client change actually stops
 * working against an old server.
 */
export const MINIMUM_SERVER_VERSION: ServerVersion = ver(0, 1, 0);

/**
 * The highest `experimental.hydrust.protocolVersion` this extension knows how
 * to read. A server reporting a higher number is newer than this client, which
 * is worth a log line but is not an error.
 */
export const CLIENT_PROTOCOL_VERSION = 1;

/**
 * First release that describes itself through
 * `capabilities.experimental.hydrust` in its InitializeResult.
 */
export const CAPABILITY_NEGOTIATION_VERSION: ServerVersion = ver(0, 4, 0);

/**
 * What to assume when the server did not send a capability block and its
 * version could not be read.
 *
 * The absence of the block is itself a signal: every server from v0.4.0 sends
 * one, so a server without it is v0.3.0 or older. v0.3.0 is the most capable
 * version in that range, so assuming it keeps warnings to the things that are
 * genuinely unsupported by any old server rather than inventing complaints.
 */
export const ASSUMED_PRE_NEGOTIATION_VERSION: ServerVersion = ver(0, 3, 0);

/** A setting the extension puts into `initializationOptions.settings`. */
export interface SettingCompat {
    /** Key inside `initializationOptions.settings`. */
    key: string;
    /** The VS Code setting that feeds it, without the 'hydrust.' prefix. */
    configKey: string;
    /**
     * First server release that reads the key, or undefined when no server
     * has ever read it.
     */
    since?: ServerVersion;
    /** Where that was confirmed in the server sources. */
    evidence: string;
}

/**
 * Settings the extension sends, and the release that started reading each one.
 *
 * Checked against every released tag (v0.1.0, v0.1.1, v0.1.2, v0.1.3, v0.1.4,
 * v0.1.5, v0.2.0, v0.3.0) by grepping each key in `src/` at that tag.
 */
export const SETTING_COMPAT: readonly SettingCompat[] = [
    {
        key: 'pythonInterpreter',
        configKey: 'pythonInterpreterPath',
        since: ver(0, 1, 0),
        evidence: 'v0.1.0 src/backend.rs:45 — read in the initialize handler; present unchanged in every later tag (v0.3.0 src/backend.rs:164).',
    },
    {
        key: 'disabledRules',
        configKey: 'disabledRules',
        since: ver(0, 2, 0),
        evidence: 'v0.2.0 src/backend.rs:162 — first appearance; absent from all v0.1.x tags, which have no DiagnosticRule type at all.',
    },
    {
        key: 'enableHover',
        configKey: 'enableHover',
        since: ver(0, 2, 0),
        evidence: 'v0.2.0 src/backend.rs:87 — FeatureToggles::from_json; absent from all v0.1.x tags.',
    },
    {
        key: 'enableCompletion',
        configKey: 'enableCompletion',
        since: ver(0, 2, 0),
        evidence: 'v0.2.0 src/backend.rs:88 — FeatureToggles::from_json.',
    },
    {
        key: 'enableSignatureHelp',
        configKey: 'enableSignatureHelp',
        since: ver(0, 2, 0),
        evidence: 'v0.2.0 src/backend.rs:89 — FeatureToggles::from_json.',
    },
    {
        key: 'enableGotoDefinition',
        configKey: 'enableGotoDefinition',
        since: ver(0, 2, 0),
        evidence: 'v0.2.0 src/backend.rs:90 — FeatureToggles::from_json.',
    },
    {
        key: 'enableSemanticTokens',
        configKey: 'enableSemanticTokens',
        since: ver(0, 2, 0),
        evidence: 'v0.2.0 src/backend.rs:91 — FeatureToggles::from_json.',
    },
    {
        key: 'enableDiagnostics',
        configKey: 'enableDiagnostics',
        since: ver(0, 2, 0),
        evidence: 'v0.2.0 src/backend.rs:92 — FeatureToggles::from_json.',
    },
    {
        key: 'numThreads',
        configKey: 'numThreads',
        since: ver(0, 4, 0),
        evidence: 'Not read by any released tag. First read on the v0.4.0 development branch (src/backend.rs, initialize).',
    },
];

/** A diagnostic rule code that `hydrust.disabledRules` can name. */
export interface RuleCompat {
    /** The code as this extension spells it. */
    code: string;
    /** First server release whose `DiagnosticRule::from_code` accepts it. */
    since: ServerVersion;
    /** The code older servers used for the same rule, if it was renamed. */
    previousCode?: string;
    /** First release that accepted `previousCode`. */
    previousCodeSince?: ServerVersion;
    /** Where that was confirmed in the server sources. */
    evidence: string;
}

/**
 * Rule codes and when each became valid.
 *
 * `DiagnosticRule::from_code` returns None for anything it does not recognise
 * and the server drops the entry without comment, so a stale code in
 * `hydrust.disabledRules` looks applied but does nothing.
 *
 * No v0.1.x tag has a DiagnosticRule type at all, so on those servers the whole
 * `disabledRules` list is inert regardless of its contents.
 */
export const RULE_COMPAT: readonly RuleCompat[] = [
    {
        code: 'missing-argument',
        since: ver(0, 2, 0),
        evidence: 'v0.2.0 src/diagnostics.rs:33 in from_code; still present at v0.3.0 src/diagnostics.rs:40.',
    },
    {
        code: 'unknown-argument',
        since: ver(0, 2, 0),
        evidence: 'v0.2.0 src/diagnostics.rs:34; still present at v0.3.0 src/diagnostics.rs:41.',
    },
    {
        code: 'unresolved-reference',
        since: ver(0, 2, 0),
        evidence: 'v0.2.0 src/diagnostics.rs:35; still present at v0.3.0 src/diagnostics.rs:42.',
    },
    {
        code: 'unresolved-import',
        since: ver(0, 2, 0),
        evidence: 'v0.2.0 src/diagnostics.rs:36; still present at v0.3.0 src/diagnostics.rs:43.',
    },
    {
        code: 'invalid-hydra-parameter',
        since: ver(0, 3, 0),
        previousCode: 'invalid-target',
        previousCodeSince: ver(0, 2, 0),
        evidence: 'Renamed in v0.3.0: v0.2.0 src/diagnostics.rs:37 accepts "invalid-target", v0.3.0 src/diagnostics.rs:44 accepts "invalid-hydra-parameter" and no longer accepts the old spelling. The v0.3.0 rule also absorbed extra checks, so the two are close but not identical.',
    },
    {
        code: 'parameter-already-assigned',
        since: ver(0, 3, 0),
        evidence: 'v0.3.0 src/diagnostics.rs:45 — new in v0.3.0, absent from v0.2.0 from_code.',
    },
    {
        code: 'too-many-positional-arguments',
        since: ver(0, 3, 0),
        evidence: 'v0.3.0 src/diagnostics.rs:46 — new in v0.3.0, absent from v0.2.0 from_code.',
    },
];

/** Optional server behaviours the extension may want to branch on. */
export const FEATURE_PULL_DIAGNOSTICS = 'pullDiagnostics';
export const FEATURE_WATCHED_FILES = 'watchedFiles';
export const FEATURE_DIAGNOSTIC_REFRESH = 'diagnosticRefresh';

/** A server behaviour and the release that introduced it. */
export interface FeatureCompat {
    name: string;
    since: ServerVersion;
    evidence: string;
}

/**
 * Optional behaviours, and when they arrived.
 *
 * The always-on capabilities are deliberately not listed here. Every released
 * tag from v0.1.0 to v0.3.0 advertises exactly the same set — full text sync,
 * hover, completion, signature help, goto definition and full-document semantic
 * tokens — so there is nothing to gate. (Only the signature help trigger
 * characters changed, from "(" and "," at v0.2.0 to ":", "-", "[" and "," at
 * v0.3.0 src/backend.rs:235.) Note also that the v0.2.0 feature toggles turn
 * features off inside the request handlers; the advertised capabilities stay
 * the same either way, so the toggles cannot be detected from the capability
 * set.
 *
 * This list is not closed. Servers may name features this extension has never
 * heard of, and new names can appear without the protocol version changing, so
 * everything downstream tests for membership rather than matching the list.
 *
 * The `since` versions below only decide what the fallback table assumes for a
 * server too old to describe itself. When a server does report its own
 * features, that list is negotiated per connection: it holds what the server
 * will actually do for this client, not everything the binary can do. So a name
 * missing from it means the behaviour is off for this session — usually because
 * the client never advertised the matching capability — rather than the server
 * being too old to have it.
 */
export const FEATURE_COMPAT: readonly FeatureCompat[] = [
    {
        name: FEATURE_PULL_DIAGNOSTICS,
        since: ver(0, 4, 0),
        evidence: 'No released tag sets diagnostic_provider — v0.1.0 to v0.3.0 push diagnostics only. Added on the v0.4.0 branch at src/backend.rs:884 (interFileDependencies true, workspaceDiagnostics false).',
    },
    {
        name: FEATURE_WATCHED_FILES,
        since: ver(0, 4, 0),
        evidence: 'No released tag registers a file watcher or handles did_change_watched_files. Added on the v0.4.0 branch: dynamic registration in `initialized` at src/backend.rs:956 and the handler at src/backend.rs:1063.',
    },
    {
        name: FEATURE_DIAGNOSTIC_REFRESH,
        since: ver(0, 4, 0),
        evidence: 'The server sends workspace/diagnostic/refresh after a watched Python file changes. Nothing like it exists in any released tag, which has no file watching at all. New in v0.4.0.',
    },
];

/** The `experimental.hydrust` block a v0.4.0-or-later server sends back. */
export interface HydrustCapabilities {
    protocolVersion?: number;
    supportedSettings?: string[];
    supportedRules?: string[];
    features?: string[];
}

/** Narrow an unknown value to a plain object without throwing. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined;
    }
    return value as Record<string, unknown>;
}

/** Keep only the strings out of an unknown value that should be a string list. */
function asStringList(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Read `capabilities.experimental.hydrust` out of an InitializeResult.
 *
 * Every field is optional and anything unexpected is dropped, so a malformed or
 * partly-written block degrades to "we learned less" rather than an exception.
 * Returns undefined when the block is missing entirely, which is how every
 * server up to v0.3.0 behaves.
 */
export function parseHydrustCapabilities(initializeResult: unknown): HydrustCapabilities | undefined {
    const result = asRecord(initializeResult);
    const capabilities = asRecord(result?.capabilities);
    const experimental = asRecord(capabilities?.experimental);
    const block = asRecord(experimental?.hydrust);
    if (!block) {
        return undefined;
    }
    const protocolVersion = typeof block.protocolVersion === 'number' ? block.protocolVersion : undefined;
    return {
        protocolVersion,
        supportedSettings: asStringList(block.supportedSettings),
        supportedRules: asStringList(block.supportedRules),
        features: asStringList(block.features),
    };
}

/** Read `serverInfo.version` out of an InitializeResult. */
export function readServerInfoVersion(initializeResult: unknown): ServerVersion | undefined {
    const result = asRecord(initializeResult);
    const serverInfo = asRecord(result?.serverInfo);
    return typeof serverInfo?.version === 'string' ? parseServerVersion(serverInfo.version) : undefined;
}

/** True when the started server advertises pull diagnostics in the standard way. */
export function advertisesPullDiagnostics(initializeResult: unknown): boolean {
    const result = asRecord(initializeResult);
    const capabilities = asRecord(result?.capabilities);
    return capabilities?.diagnosticProvider !== undefined && capabilities?.diagnosticProvider !== null;
}

/** One thing the server will not act on, with a sentence explaining why. */
export interface UnsupportedEntry {
    /** The VS Code setting name, or the rule code, the user wrote. */
    name: string;
    /** Plain-language reason, suitable for showing to the user. */
    reason: string;
}

/** Everything the extension worked out about a particular running server. */
export interface CompatReport {
    /** Settings the user changed that this server will not read. */
    unsupportedSettings: UnsupportedEntry[];
    /** Rule codes the user listed that this server will not recognise. */
    unsupportedRules: UnsupportedEntry[];
    /** Feature name to whether the server has it. */
    features: Record<string, boolean>;
    /** True when the findings came from the server's own capability block. */
    authoritative: boolean;
    /** True when the server speaks a newer capability protocol than this client. */
    protocolNewerThanClient: boolean;
}

/** Inputs needed to work out what a server will ignore. */
export interface CompatInput {
    /** Server version, if it could be determined. */
    version?: ServerVersion;
    /** The parsed capability block, when the server sent one. */
    capabilities?: HydrustCapabilities;
    /** VS Code setting names (without the 'hydrust.' prefix) the user changed. */
    configuredSettings: string[];
    /** Rule codes the user put in hydrust.disabledRules. */
    configuredRules: string[];
    /**
     * Renames that were really applied to the payload that was sent.
     *
     * A renamed rule only reaches an old server if the payload was rewritten,
     * and the payload is built before the server has said which version it is.
     * When the pre-launch guess was wrong, or there was no guess at all, no
     * rewrite happened and the user still needs telling.
     */
    appliedRuleRewrites?: readonly RuleRewrite[];
    /** True when pull diagnostics were seen in the standard capability field. */
    pullDiagnosticsAdvertised?: boolean;
}

/**
 * Work out what the server will quietly ignore.
 *
 * The capability block wins whenever the server sent one: it is the server
 * telling us directly, so it replaces the version table completely. Without a
 * block the version table is used, falling back to the newest version that
 * predates the block when the version is unknown.
 */
export function buildCompatReport(input: CompatInput): CompatReport {
    const capabilities = input.capabilities;
    const authoritative = capabilities !== undefined;
    const effectiveVersion = input.version ?? ASSUMED_PRE_NEGOTIATION_VERSION;
    const versionLabel = formatServerVersion(effectiveVersion);

    const unsupportedSettings: UnsupportedEntry[] = [];
    for (const configKey of input.configuredSettings) {
        const entry = SETTING_COMPAT.find((setting) => setting.configKey === configKey);
        if (!entry) {
            // A client-only setting such as hydrust.serverPath. Never sent, so
            // there is nothing for the server to support.
            continue;
        }
        if (authoritative) {
            const supported = capabilities.supportedSettings;
            if (supported && !supported.includes(entry.key)) {
                unsupportedSettings.push({
                    name: entry.configKey,
                    reason: `${BINARY_NAME} ${versionLabel} reports that it does not read '${entry.key}'.`,
                });
            }
            continue;
        }
        if (!entry.since) {
            unsupportedSettings.push({
                name: entry.configKey,
                reason: `no released ${BINARY_NAME} reads '${entry.key}', so this setting does nothing.`,
            });
            continue;
        }
        if (!isAtLeast(effectiveVersion, entry.since)) {
            unsupportedSettings.push({
                name: entry.configKey,
                reason: `needs ${BINARY_NAME} ${formatServerVersion(entry.since)} or later; ${versionLabel} ignores it.`,
            });
        }
    }

    // If the server does not read disabledRules at all there is no point
    // listing each individual rule as well; the one line covers it.
    const disabledRulesIgnored = unsupportedSettings.some((entry) => entry.name === 'disabledRules');

    const rewrittenCodes = new Set((input.appliedRuleRewrites ?? []).map((rewrite) => rewrite.from));

    const unsupportedRules: UnsupportedEntry[] = [];
    for (const code of disabledRulesIgnored ? [] : input.configuredRules) {
        if (authoritative) {
            const supported = capabilities.supportedRules;
            if (supported && !supported.includes(code)) {
                unsupportedRules.push({
                    name: code,
                    reason: `${BINARY_NAME} ${versionLabel} does not know this rule code, so the entry does nothing.`,
                });
            }
            continue;
        }
        const entry = RULE_COMPAT.find((rule) => rule.code === code);
        if (!entry) {
            unsupportedRules.push({
                name: code,
                reason: 'not a rule code this extension knows about, so no server will match it.',
            });
            continue;
        }
        if (isAtLeast(effectiveVersion, entry.since)) {
            continue;
        }
        if (entry.previousCode && entry.previousCodeSince && isAtLeast(effectiveVersion, entry.previousCodeSince)) {
            if (rewrittenCodes.has(code)) {
                // The payload really was sent with the older spelling, so the
                // rule is switched off and there is nothing to report.
                continue;
            }
            unsupportedRules.push({
                name: code,
                reason:
                    `${BINARY_NAME} ${versionLabel} calls this rule '${entry.previousCode}', and the ` +
                    'version was not known in time to send it under that name. Restarting the server ' +
                    'will fix it.',
            });
            continue;
        }
        unsupportedRules.push({
            name: code,
            reason: `added in ${BINARY_NAME} ${formatServerVersion(entry.since)}; ${versionLabel} ignores it.`,
        });
    }

    const features: Record<string, boolean> = {};
    for (const feature of FEATURE_COMPAT) {
        if (authoritative && capabilities.features) {
            features[feature.name] = capabilities.features.includes(feature.name);
        } else if (feature.name === FEATURE_PULL_DIAGNOSTICS && input.pullDiagnosticsAdvertised !== undefined) {
            // The standard diagnosticProvider field is reliable on every
            // version, so prefer it over guessing from the version number.
            features[feature.name] = input.pullDiagnosticsAdvertised;
        } else {
            features[feature.name] = isAtLeast(effectiveVersion, feature.since);
        }
    }
    // Servers are free to add feature names without bumping the protocol
    // version, so carry through anything this extension has not heard of rather
    // than dropping it.
    for (const name of capabilities?.features ?? []) {
        if (!Object.prototype.hasOwnProperty.call(features, name)) {
            features[name] = true;
        }
    }

    const protocolVersion = capabilities?.protocolVersion;
    const protocolNewerThanClient = protocolVersion !== undefined && protocolVersion > CLIENT_PROTOCOL_VERSION;

    return {
        unsupportedSettings,
        unsupportedRules,
        features,
        authoritative,
        protocolNewerThanClient,
    };
}

/** A rule code that had to be spelled differently for an older server. */
export interface RuleRewrite {
    from: string;
    to: string;
}

/** The outcome of adjusting a disabled-rules list for a particular server. */
export interface RuleTransformResult {
    rules: string[];
    rewrites: RuleRewrite[];
}

/**
 * Rewrite rule codes that were renamed, so an older server still matches them.
 *
 * Today this only covers 'invalid-hydra-parameter', which v0.2.0 spelled
 * 'invalid-target'. Nothing is rewritten when the version is unknown: guessing
 * wrong would send a stale code to a modern server, which is worse than leaving
 * the list alone.
 */
export function transformDisabledRules(
    rules: readonly string[],
    version: ServerVersion | undefined
): RuleTransformResult {
    if (!version) {
        return { rules: [...rules], rewrites: [] };
    }
    const rewrites: RuleRewrite[] = [];
    const rewritten = rules.map((code) => {
        const entry = RULE_COMPAT.find((rule) => rule.code === code);
        if (!entry || !entry.previousCode || !entry.previousCodeSince) {
            return code;
        }
        const tooNewForThisServer = !isAtLeast(version, entry.since);
        const oldNameWorks = isAtLeast(version, entry.previousCodeSince);
        if (tooNewForThisServer && oldNameWorks) {
            rewrites.push({ from: code, to: entry.previousCode });
            return entry.previousCode;
        }
        return code;
    });
    return { rules: rewritten, rewrites };
}

/**
 * Apply every payload adjustment an older server needs.
 *
 * Anything in `disabledRules` that is not a string is dropped, whether or not a
 * rename also applies, so the server is sent the same list either way. The
 * dropped entries come back so the caller can say what it threw away.
 *
 * Returns a fresh object; the input is left untouched.
 */
export function transformSettingsPayload(
    payload: Readonly<Record<string, unknown>>,
    version: ServerVersion | undefined
): { payload: Record<string, unknown>; rewrites: RuleRewrite[]; droppedRules: unknown[] } {
    const next: Record<string, unknown> = { ...payload };
    const disabledRules = next.disabledRules;
    if (!Array.isArray(disabledRules)) {
        return { payload: next, rewrites: [], droppedRules: [] };
    }
    const codes = disabledRules.filter((entry): entry is string => typeof entry === 'string');
    const droppedRules = disabledRules.filter((entry) => typeof entry !== 'string');
    const { rules, rewrites } = transformDisabledRules(codes, version);
    next.disabledRules = rules;
    return { payload: next, rewrites, droppedRules };
}

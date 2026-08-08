import { describe, expect, it } from 'vitest';

import {
    ASSUMED_PRE_NEGOTIATION_VERSION,
    CAPABILITY_NEGOTIATION_VERSION,
    CLIENT_PROTOCOL_VERSION,
    FEATURE_COMPAT,
    FEATURE_DIAGNOSTIC_REFRESH,
    FEATURE_PULL_DIAGNOSTICS,
    FEATURE_WATCHED_FILES,
    MINIMUM_SERVER_VERSION,
    RULE_COMPAT,
    SETTING_COMPAT,
    ServerVersion,
    advertisesPullDiagnostics,
    buildCompatReport,
    compareServerVersions,
    formatServerVersion,
    isAtLeast,
    parseHydrustCapabilities,
    parseServerVersion,
    readServerInfoVersion,
    transformDisabledRules,
    transformSettingsPayload,
} from '../../src/common/compatTable';

/** Shorthand so the expectations below stay readable. */
function v(major: number, minor: number, patch: number): ServerVersion {
    return { major, minor, patch };
}

/** Wrap a capability block the way a real InitializeResult carries it. */
function initializeResult(hydrust: unknown, extra: Record<string, unknown> = {}): unknown {
    return { capabilities: { experimental: { hydrust }, ...extra } };
}

describe('parseServerVersion', () => {
    it('reads the exact shape hydra-lsp --version prints', () => {
        expect(parseServerVersion('hydra-lsp 0.4.0')).toEqual(v(0, 4, 0));
        expect(parseServerVersion('hydra-lsp 0.4.0\n')).toEqual(v(0, 4, 0));
    });

    it('accepts a leading v, a bare number and a pre-release suffix', () => {
        expect(parseServerVersion('v0.3.0')).toEqual(v(0, 3, 0));
        expect(parseServerVersion('0.3.0')).toEqual(v(0, 3, 0));
        expect(parseServerVersion('0.3.0-dev')).toEqual(v(0, 3, 0));
        expect(parseServerVersion('0.3.0+build.7')).toEqual(v(0, 3, 0));
    });

    it('treats a missing patch part as zero', () => {
        expect(parseServerVersion('1.2')).toEqual(v(1, 2, 0));
        expect(parseServerVersion('v2.0')).toEqual(v(2, 0, 0));
    });

    it('picks the first version-looking token out of surrounding noise', () => {
        expect(parseServerVersion('  hydrust-server 1.2.3 (built 2026-01-01)  ')).toEqual(v(1, 2, 3));
        expect(parseServerVersion('warning: something\nhydra-lsp 0.4.1')).toEqual(v(0, 4, 1));
    });

    it('gives up on junk rather than inventing a version', () => {
        expect(parseServerVersion(undefined)).toBeUndefined();
        expect(parseServerVersion('')).toBeUndefined();
        expect(parseServerVersion('not a version at all')).toBeUndefined();
        expect(parseServerVersion('v')).toBeUndefined();
        // A single number is not a version; two parts are the minimum.
        expect(parseServerVersion('7')).toBeUndefined();
    });

    it('handles large and zero-padded numbers without losing digits', () => {
        expect(parseServerVersion('10.20.30')).toEqual(v(10, 20, 30));
        expect(parseServerVersion('v0.04.0')).toEqual(v(0, 4, 0));
    });
});

describe('formatServerVersion', () => {
    it('renders versions the way the release tags spell them', () => {
        expect(formatServerVersion(v(0, 3, 0))).toBe('v0.3.0');
        expect(formatServerVersion(v(1, 0, 12))).toBe('v1.0.12');
    });

    it('round-trips through the parser', () => {
        for (const version of [v(0, 1, 0), v(0, 2, 0), v(0, 3, 0), v(0, 4, 0), v(12, 34, 56)]) {
            expect(parseServerVersion(formatServerVersion(version))).toEqual(version);
        }
    });
});

describe('compareServerVersions and isAtLeast', () => {
    it('orders by major, then minor, then patch', () => {
        expect(compareServerVersions(v(0, 1, 0), v(0, 2, 0))).toBeLessThan(0);
        expect(compareServerVersions(v(0, 2, 0), v(0, 1, 9))).toBeGreaterThan(0);
        expect(compareServerVersions(v(1, 0, 0), v(0, 99, 99))).toBeGreaterThan(0);
        expect(compareServerVersions(v(0, 3, 1), v(0, 3, 2))).toBeLessThan(0);
        expect(compareServerVersions(v(0, 3, 0), v(0, 3, 0))).toBe(0);
    });

    it('sorts the released tags into release order', () => {
        const tags = ['v0.3.0', 'v0.1.10', 'v0.1.2', 'v0.2.0', 'v0.1.0', 'v0.4.0'];
        const sorted = tags
            .map((tag) => parseServerVersion(tag)!)
            .sort(compareServerVersions)
            .map(formatServerVersion);
        expect(sorted).toEqual(['v0.1.0', 'v0.1.2', 'v0.1.10', 'v0.2.0', 'v0.3.0', 'v0.4.0']);
    });

    it('treats equal versions as good enough', () => {
        expect(isAtLeast(v(0, 3, 0), v(0, 3, 0))).toBe(true);
        expect(isAtLeast(v(0, 3, 1), v(0, 3, 0))).toBe(true);
        expect(isAtLeast(v(0, 2, 9), v(0, 3, 0))).toBe(false);
    });
});

describe('the table itself', () => {
    it('names every setting the extension can send exactly once', () => {
        const keys = SETTING_COMPAT.map((entry) => entry.key);
        expect(new Set(keys).size).toBe(keys.length);
        const configKeys = SETTING_COMPAT.map((entry) => entry.configKey);
        expect(new Set(configKeys).size).toBe(configKeys.length);
    });

    it('names every rule code exactly once', () => {
        const codes = RULE_COMPAT.map((entry) => entry.code);
        expect(new Set(codes).size).toBe(codes.length);
    });

    it('gives every entry a piece of evidence to check later', () => {
        for (const entry of [...SETTING_COMPAT, ...RULE_COMPAT, ...FEATURE_COMPAT]) {
            expect(entry.evidence.length).toBeGreaterThan(0);
        }
    });

    it('keeps the anchor versions where the rest of the code expects them', () => {
        expect(MINIMUM_SERVER_VERSION).toEqual(v(0, 1, 0));
        expect(CAPABILITY_NEGOTIATION_VERSION).toEqual(v(0, 4, 0));
        expect(ASSUMED_PRE_NEGOTIATION_VERSION).toEqual(v(0, 3, 0));
        expect(CLIENT_PROTOCOL_VERSION).toBe(1);
        // The assumption for an undescribed server must predate the release
        // that started describing itself, or the fallback would claim features
        // that only exist in the negotiating versions.
        expect(isAtLeast(ASSUMED_PRE_NEGOTIATION_VERSION, CAPABILITY_NEGOTIATION_VERSION)).toBe(false);
    });

    it('lists the three feature names the extension branches on', () => {
        expect(FEATURE_COMPAT.map((entry) => entry.name)).toEqual([
            FEATURE_PULL_DIAGNOSTICS,
            FEATURE_WATCHED_FILES,
            FEATURE_DIAGNOSTIC_REFRESH,
        ]);
    });
});

describe('buildCompatReport in fallback mode', () => {
    it('warns about settings the running version is too old to read', () => {
        const report = buildCompatReport({
            version: v(0, 2, 0),
            configuredSettings: ['pythonInterpreterPath', 'enableHover', 'numThreads'],
            configuredRules: [],
        });

        expect(report.authoritative).toBe(false);
        expect(report.unsupportedSettings.map((entry) => entry.name)).toEqual(['numThreads']);
        expect(report.unsupportedSettings[0].reason).toContain('v0.4.0');
        expect(report.unsupportedSettings[0].reason).toContain('v0.2.0 ignores it');
    });

    it('says nothing about a version new enough for everything', () => {
        const report = buildCompatReport({
            version: v(0, 4, 0),
            configuredSettings: SETTING_COMPAT.map((entry) => entry.configKey),
            configuredRules: RULE_COMPAT.map((entry) => entry.code),
        });

        expect(report.unsupportedSettings).toEqual([]);
        expect(report.unsupportedRules).toEqual([]);
    });

    it('ignores client-only settings that are never sent to the server', () => {
        const report = buildCompatReport({
            version: v(0, 1, 0),
            configuredSettings: ['serverPath', 'importStrategy', 'traceServer', 'developerMode'],
            configuredRules: [],
        });

        expect(report.unsupportedSettings).toEqual([]);
    });

    it('assumes v0.3.0 when the version could not be determined', () => {
        const unknown = buildCompatReport({
            configuredSettings: ['numThreads', 'enableHover'],
            configuredRules: [],
        });
        const explicit = buildCompatReport({
            version: ASSUMED_PRE_NEGOTIATION_VERSION,
            configuredSettings: ['numThreads', 'enableHover'],
            configuredRules: [],
        });

        expect(unknown.unsupportedSettings).toEqual(explicit.unsupportedSettings);
        expect(unknown.unsupportedSettings.map((entry) => entry.name)).toEqual(['numThreads']);
    });

    it('reports the whole disabledRules setting rather than each rule on a v0.1.x server', () => {
        const report = buildCompatReport({
            version: v(0, 1, 5),
            configuredSettings: ['disabledRules'],
            configuredRules: ['missing-argument', 'parameter-already-assigned'],
        });

        expect(report.unsupportedSettings.map((entry) => entry.name)).toEqual(['disabledRules']);
        expect(report.unsupportedRules).toEqual([]);
    });

    it('reports rules the server is too old to know', () => {
        const report = buildCompatReport({
            version: v(0, 2, 0),
            configuredSettings: ['disabledRules'],
            configuredRules: ['missing-argument', 'parameter-already-assigned', 'too-many-positional-arguments'],
        });

        expect(report.unsupportedRules.map((entry) => entry.name)).toEqual([
            'parameter-already-assigned',
            'too-many-positional-arguments',
        ]);
        expect(report.unsupportedRules[0].reason).toContain('added in hydra-lsp v0.3.0');
    });

    it('stays quiet about a renamed rule that gets rewritten instead', () => {
        const report = buildCompatReport({
            version: v(0, 2, 0),
            configuredSettings: ['disabledRules'],
            configuredRules: ['invalid-hydra-parameter'],
        });

        // v0.2.0 spells it 'invalid-target' and transformDisabledRules sends it
        // that way, so there is nothing for the user to fix.
        expect(report.unsupportedRules).toEqual([]);
    });

    it('flags a rule code no server has ever accepted', () => {
        const report = buildCompatReport({
            version: v(0, 3, 0),
            configuredSettings: ['disabledRules'],
            configuredRules: ['invented-rule'],
        });

        expect(report.unsupportedRules.map((entry) => entry.name)).toEqual(['invented-rule']);
        expect(report.unsupportedRules[0].reason).toContain('not a rule code this extension knows about');
    });

    it('derives features from the version table', () => {
        const old = buildCompatReport({ version: v(0, 3, 0), configuredSettings: [], configuredRules: [] });
        expect(old.features).toEqual({
            [FEATURE_PULL_DIAGNOSTICS]: false,
            [FEATURE_WATCHED_FILES]: false,
            [FEATURE_DIAGNOSTIC_REFRESH]: false,
        });

        const modern = buildCompatReport({ version: v(0, 4, 0), configuredSettings: [], configuredRules: [] });
        expect(modern.features[FEATURE_PULL_DIAGNOSTICS]).toBe(true);
        expect(modern.features[FEATURE_WATCHED_FILES]).toBe(true);
    });

    it('believes the standard diagnosticProvider field over the version table', () => {
        const report = buildCompatReport({
            version: v(0, 3, 0),
            configuredSettings: [],
            configuredRules: [],
            pullDiagnosticsAdvertised: true,
        });

        expect(report.features[FEATURE_PULL_DIAGNOSTICS]).toBe(true);
        // Only pull diagnostics has a standard field, so the rest still come
        // from the table.
        expect(report.features[FEATURE_WATCHED_FILES]).toBe(false);
    });

    it('never claims a newer protocol when nothing reported one', () => {
        const report = buildCompatReport({ version: v(0, 3, 0), configuredSettings: [], configuredRules: [] });
        expect(report.protocolNewerThanClient).toBe(false);
    });
});

describe('buildCompatReport in authoritative mode', () => {
    it('supersedes the table completely, even when the version says otherwise', () => {
        // A v0.1.0 server that somehow reports reading everything: the table
        // would complain about all of it, the capability block must not.
        const report = buildCompatReport({
            version: v(0, 1, 0),
            capabilities: {
                protocolVersion: 1,
                supportedSettings: SETTING_COMPAT.map((entry) => entry.key),
                supportedRules: RULE_COMPAT.map((entry) => entry.code),
                features: [],
            },
            configuredSettings: SETTING_COMPAT.map((entry) => entry.configKey),
            configuredRules: RULE_COMPAT.map((entry) => entry.code),
        });

        expect(report.authoritative).toBe(true);
        expect(report.unsupportedSettings).toEqual([]);
        expect(report.unsupportedRules).toEqual([]);
    });

    it('supersedes the table in the other direction too', () => {
        // A v0.4.0 server that reports reading nothing: the table would say
        // everything is fine, the capability block must win.
        const report = buildCompatReport({
            version: v(0, 4, 0),
            capabilities: {
                protocolVersion: 1,
                supportedSettings: [],
                supportedRules: [],
                features: [],
            },
            configuredSettings: ['enableHover', 'numThreads'],
            configuredRules: ['missing-argument'],
        });

        expect(report.unsupportedSettings.map((entry) => entry.name)).toEqual(['enableHover', 'numThreads']);
        expect(report.unsupportedSettings[0].reason).toContain('reports that it does not read');
        // disabledRules itself was not listed as configured, so the individual
        // rule is reported on its own merits.
        expect(report.unsupportedRules.map((entry) => entry.name)).toEqual(['missing-argument']);
    });

    it('leaves settings alone when the block did not list any', () => {
        // supportedSettings absent means "did not say", not "supports none".
        const report = buildCompatReport({
            version: v(0, 4, 0),
            capabilities: { protocolVersion: 1, features: [] },
            configuredSettings: ['numThreads'],
            configuredRules: ['missing-argument'],
        });

        expect(report.authoritative).toBe(true);
        expect(report.unsupportedSettings).toEqual([]);
        expect(report.unsupportedRules).toEqual([]);
    });

    it('reads features straight out of the block', () => {
        const report = buildCompatReport({
            version: v(0, 4, 0),
            capabilities: { protocolVersion: 1, features: [FEATURE_WATCHED_FILES] },
            configuredSettings: [],
            configuredRules: [],
        });

        expect(report.features).toEqual({
            [FEATURE_PULL_DIAGNOSTICS]: false,
            [FEATURE_WATCHED_FILES]: true,
            [FEATURE_DIAGNOSTIC_REFRESH]: false,
        });
    });

    it('turns an empty feature list into all-false, not all-true', () => {
        // features is negotiated per connection: [] is the honest answer for a
        // client that advertised nothing, and must not be mistaken for "the
        // server said nothing, fall back to the table".
        const report = buildCompatReport({
            version: v(0, 4, 0),
            capabilities: { protocolVersion: 1, features: [] },
            configuredSettings: [],
            configuredRules: [],
        });

        expect(Object.values(report.features).every((value) => value === false)).toBe(true);
    });

    it('does not let the standard diagnosticProvider field override an empty feature list', () => {
        // The server may well advertise diagnosticProvider while telling us pull
        // diagnostics are off for this session. The block is the negotiated
        // answer, so it wins.
        const report = buildCompatReport({
            version: v(0, 4, 0),
            capabilities: { protocolVersion: 1, features: [] },
            configuredSettings: [],
            configuredRules: [],
            pullDiagnosticsAdvertised: true,
        });

        expect(report.features[FEATURE_PULL_DIAGNOSTICS]).toBe(false);
    });

    it('carries through feature names it has never heard of', () => {
        const report = buildCompatReport({
            version: v(0, 4, 0),
            capabilities: { protocolVersion: 1, features: ['inlayHints', 'somethingFromTheFuture'] },
            configuredSettings: [],
            configuredRules: [],
        });

        expect(report.features.inlayHints).toBe(true);
        expect(report.features.somethingFromTheFuture).toBe(true);
        expect(report.features[FEATURE_PULL_DIAGNOSTICS]).toBe(false);
    });

    it('notices a server speaking a newer capability protocol', () => {
        const newer = buildCompatReport({
            version: v(0, 5, 0),
            capabilities: { protocolVersion: CLIENT_PROTOCOL_VERSION + 1, features: [] },
            configuredSettings: [],
            configuredRules: [],
        });
        expect(newer.protocolNewerThanClient).toBe(true);

        const same = buildCompatReport({
            version: v(0, 4, 0),
            capabilities: { protocolVersion: CLIENT_PROTOCOL_VERSION, features: [] },
            configuredSettings: [],
            configuredRules: [],
        });
        expect(same.protocolNewerThanClient).toBe(false);

        const silent = buildCompatReport({
            version: v(0, 4, 0),
            capabilities: { features: [] },
            configuredSettings: [],
            configuredRules: [],
        });
        expect(silent.protocolNewerThanClient).toBe(false);
    });
});

describe('transformDisabledRules', () => {
    it('rewrites invalid-hydra-parameter to invalid-target for a v0.2.0 server', () => {
        const result = transformDisabledRules(['missing-argument', 'invalid-hydra-parameter'], v(0, 2, 0));

        expect(result.rules).toEqual(['missing-argument', 'invalid-target']);
        expect(result.rewrites).toEqual([{ from: 'invalid-hydra-parameter', to: 'invalid-target' }]);
    });

    it('leaves the modern spelling alone from v0.3.0 onwards', () => {
        for (const version of [v(0, 3, 0), v(0, 4, 0), v(1, 0, 0)]) {
            const result = transformDisabledRules(['invalid-hydra-parameter'], version);
            expect(result.rules).toEqual(['invalid-hydra-parameter']);
            expect(result.rewrites).toEqual([]);
        }
    });

    it('does not rewrite for a v0.1.x server, which never knew either spelling', () => {
        const result = transformDisabledRules(['invalid-hydra-parameter'], v(0, 1, 5));

        expect(result.rules).toEqual(['invalid-hydra-parameter']);
        expect(result.rewrites).toEqual([]);
    });

    it('changes nothing at all when the version is unknown', () => {
        const rules = ['invalid-hydra-parameter', 'missing-argument'];
        const result = transformDisabledRules(rules, undefined);

        expect(result.rules).toEqual(rules);
        expect(result.rewrites).toEqual([]);
    });

    it('returns a fresh array rather than the caller\'s', () => {
        const rules = ['missing-argument'];
        const result = transformDisabledRules(rules, undefined);

        expect(result.rules).not.toBe(rules);
        expect(result.rules).toEqual(rules);
    });

    it('passes unknown codes straight through', () => {
        const result = transformDisabledRules(['not-a-rule'], v(0, 2, 0));

        expect(result.rules).toEqual(['not-a-rule']);
        expect(result.rewrites).toEqual([]);
    });
});

describe('transformSettingsPayload', () => {
    it('rewrites the rule inside the payload and leaves everything else', () => {
        const payload = {
            pythonInterpreter: '/usr/bin/python3',
            disabledRules: ['invalid-hydra-parameter', 'unknown-argument'],
            enableHover: true,
        };
        const result = transformSettingsPayload(payload, v(0, 2, 0));

        expect(result.payload).toEqual({
            pythonInterpreter: '/usr/bin/python3',
            disabledRules: ['invalid-target', 'unknown-argument'],
            enableHover: true,
        });
        expect(result.rewrites).toEqual([{ from: 'invalid-hydra-parameter', to: 'invalid-target' }]);
    });

    it('never touches the object it was handed', () => {
        const payload = { disabledRules: ['invalid-hydra-parameter'] };
        const result = transformSettingsPayload(payload, v(0, 2, 0));

        expect(payload.disabledRules).toEqual(['invalid-hydra-parameter']);
        expect(result.payload).not.toBe(payload);
    });

    it('applies no transform when the version is unknown', () => {
        const payload = { disabledRules: ['invalid-hydra-parameter'] };
        const result = transformSettingsPayload(payload, undefined);

        expect(result.payload.disabledRules).toEqual(['invalid-hydra-parameter']);
        expect(result.rewrites).toEqual([]);
    });

    it('copes with a missing or wrongly-typed disabledRules value', () => {
        expect(transformSettingsPayload({ enableHover: true }, v(0, 2, 0)).rewrites).toEqual([]);
        expect(transformSettingsPayload({ disabledRules: 'oops' }, v(0, 2, 0)).payload.disabledRules).toBe('oops');
        expect(transformSettingsPayload({ disabledRules: undefined }, v(0, 2, 0)).rewrites).toEqual([]);
    });

    it('drops non-string entries only when it has to rewrite', () => {
        const result = transformSettingsPayload(
            { disabledRules: ['invalid-hydra-parameter', 42, null] },
            v(0, 2, 0)
        );

        expect(result.payload.disabledRules).toEqual(['invalid-target']);
    });
});

describe('parseHydrustCapabilities', () => {
    it('reads a well-formed block', () => {
        const parsed = parseHydrustCapabilities(
            initializeResult({
                protocolVersion: 1,
                supportedSettings: ['pythonInterpreter', 'numThreads'],
                supportedRules: ['missing-argument'],
                features: [FEATURE_PULL_DIAGNOSTICS],
            })
        );

        expect(parsed).toEqual({
            protocolVersion: 1,
            supportedSettings: ['pythonInterpreter', 'numThreads'],
            supportedRules: ['missing-argument'],
            features: [FEATURE_PULL_DIAGNOSTICS],
        });
    });

    it('returns undefined when there is no block, which is every server up to v0.3.0', () => {
        expect(parseHydrustCapabilities({ capabilities: {} })).toBeUndefined();
        expect(parseHydrustCapabilities({ capabilities: { experimental: {} } })).toBeUndefined();
        expect(parseHydrustCapabilities({ serverInfo: { name: 'hydra-lsp', version: '0.3.0' } })).toBeUndefined();
    });

    it('survives every shape of malformed input without throwing', () => {
        const rubbish: unknown[] = [
            undefined,
            null,
            'a string',
            42,
            true,
            [],
            [{ capabilities: {} }],
            {},
            { capabilities: null },
            { capabilities: 'nope' },
            { capabilities: [] },
            { capabilities: { experimental: null } },
            { capabilities: { experimental: 'nope' } },
            { capabilities: { experimental: [] } },
            initializeResult(null),
            initializeResult('nope'),
            initializeResult([]),
            initializeResult(42),
        ];

        for (const value of rubbish) {
            expect(() => parseHydrustCapabilities(value)).not.toThrow();
            expect(parseHydrustCapabilities(value)).toBeUndefined();
        }
    });

    it('drops wrongly-typed fields instead of trusting them', () => {
        const parsed = parseHydrustCapabilities(
            initializeResult({
                protocolVersion: 'one',
                supportedSettings: 'enableHover',
                supportedRules: { 'missing-argument': true },
                features: null,
            })
        );

        expect(parsed).toEqual({
            protocolVersion: undefined,
            supportedSettings: undefined,
            supportedRules: undefined,
            features: undefined,
        });
    });

    it('keeps the string entries out of a partly-rotten list', () => {
        const parsed = parseHydrustCapabilities(
            initializeResult({
                supportedSettings: ['enableHover', 42, null, { key: 'x' }, 'numThreads'],
                features: [FEATURE_WATCHED_FILES, undefined],
            })
        );

        expect(parsed?.supportedSettings).toEqual(['enableHover', 'numThreads']);
        expect(parsed?.features).toEqual([FEATURE_WATCHED_FILES]);
    });

    it('returns a block for an empty one, because an empty block is still an answer', () => {
        const parsed = parseHydrustCapabilities(initializeResult({}));

        expect(parsed).toBeDefined();
        expect(parsed?.protocolVersion).toBeUndefined();
        expect(parsed?.features).toBeUndefined();
    });

    it('ignores extra fields a newer server might add', () => {
        const parsed = parseHydrustCapabilities(
            initializeResult({
                protocolVersion: 2,
                features: [],
                somethingNew: { nested: [1, 2, 3] },
                anotherThing: 'hello',
            })
        );

        expect(parsed?.protocolVersion).toBe(2);
        expect(parsed?.features).toEqual([]);
        expect(Object.keys(parsed!).sort()).toEqual([
            'features',
            'protocolVersion',
            'supportedRules',
            'supportedSettings',
        ]);
    });

    it('keeps an empty feature list distinct from a missing one', () => {
        expect(parseHydrustCapabilities(initializeResult({ features: [] }))?.features).toEqual([]);
        expect(parseHydrustCapabilities(initializeResult({}))?.features).toBeUndefined();
    });
});

describe('readServerInfoVersion', () => {
    it('reads the version every release fills in', () => {
        expect(readServerInfoVersion({ serverInfo: { name: 'hydra-lsp', version: '0.3.0' } })).toEqual(v(0, 3, 0));
        expect(readServerInfoVersion({ serverInfo: { name: 'hydra-lsp', version: 'v0.4.0' } })).toEqual(v(0, 4, 0));
    });

    it('returns undefined for anything it cannot read', () => {
        expect(readServerInfoVersion(undefined)).toBeUndefined();
        expect(readServerInfoVersion(null)).toBeUndefined();
        expect(readServerInfoVersion('nope')).toBeUndefined();
        expect(readServerInfoVersion({})).toBeUndefined();
        expect(readServerInfoVersion({ serverInfo: {} })).toBeUndefined();
        expect(readServerInfoVersion({ serverInfo: { version: 42 } })).toBeUndefined();
        expect(readServerInfoVersion({ serverInfo: { version: 'unreleased' } })).toBeUndefined();
    });
});

describe('advertisesPullDiagnostics', () => {
    it('spots the standard capability field', () => {
        expect(advertisesPullDiagnostics({ capabilities: { diagnosticProvider: { interFileDependencies: true } } }))
            .toBe(true);
    });

    it('is false when the field is missing, null or the whole result is rubbish', () => {
        expect(advertisesPullDiagnostics({ capabilities: {} })).toBe(false);
        expect(advertisesPullDiagnostics({ capabilities: { diagnosticProvider: null } })).toBe(false);
        expect(advertisesPullDiagnostics(undefined)).toBe(false);
        expect(advertisesPullDiagnostics('nope')).toBe(false);
    });
});

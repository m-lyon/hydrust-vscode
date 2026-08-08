/**
 * Check the compatibility table against the server sources it claims to
 * describe.
 *
 * Every entry in SETTING_COMPAT, RULE_COMPAT and FEATURE_COMPAT claims a
 * `since` version. This suite reads the tagged server sources with `git show`
 * and checks that claim from the sources themselves: the `since` version really
 * is the first tag where the thing appears, and it is absent from every tag
 * before it. A wrong `since` means the extension warns about the wrong things.
 *
 * The entries also carry an `evidence` string naming where the behaviour was
 * found. That is prose for whoever reads the table next, and nothing here
 * checks it. An earlier version of this suite parsed the file:line references
 * out of it and confirmed each one, but those checks restated what the `since`
 * checks already derive from the sources, and citations into released tags
 * point at frozen content that cannot drift.
 *
 * Run with `npm run test:table-audit`. Not part of `npm test`: it needs the
 * sibling server checkout with its tags.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
    FEATURE_COMPAT,
    FEATURE_DIAGNOSTIC_REFRESH,
    FEATURE_PULL_DIAGNOSTICS,
    FEATURE_WATCHED_FILES,
    RULE_COMPAT,
    SETTING_COMPAT,
    ServerVersion,
    formatServerVersion,
} from '../../src/common/compatTable';
import {
    existsAtTag,
    fileAtTag,
    fileInWorkingTree,
    filesContainingAtTag,
    releasedTags,
    requireServerRepo,
    serverRepoPath,
    tagAtLeast,
} from './serverRepo';

let tags: string[];

beforeAll(() => {
    requireServerRepo();
    tags = releasedTags();
    if (tags.length === 0) {
        throw new Error(
            `No release tags found in ${serverRepoPath()}.\n` +
            'The checkout probably has no tags. Fetch them with `git fetch --tags`, or\n' +
            'check out with fetch-depth 0 in CI.'
        );
    }
});

/**
 * The rule codes a tag's `DiagnosticRule::from_code` will accept.
 *
 * This has to be more precise than grepping the whole tree. Every v0.1.x tag
 * emits 'invalid-target' as a diagnostic code, but has no from_code and no way
 * to disable anything, so a plain grep would date the rule three releases too
 * early. Returns undefined when the tag has no from_code at all.
 */
function codesAcceptedAtTag(tag: string): string[] | undefined {
    const source = fileAtTag(tag, 'src/diagnostics.rs');
    if (!source) {
        return undefined;
    }
    const start = source.indexOf('fn from_code');
    if (start === -1) {
        return undefined;
    }
    // The body ends at the first closing brace back at method indentation.
    const end = source.indexOf('\n    }', start);
    const body = source.slice(start, end === -1 ? undefined : end);
    return [...body.matchAll(/"([a-z][a-z-]*)"\s*=>/g)].map((entry) => entry[1]);
}

/** The first released tag whose from_code accepts `code`. */
function firstTagAccepting(code: string): string | undefined {
    return tags.find((tag) => codesAcceptedAtTag(tag)?.includes(code));
}

/** Collect problems and report them all at once rather than one per run. */
function expectNoProblems(problems: string[]): void {
    expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
}

/** The first released tag where `needle` shows up under `src/`. */
function firstTagContaining(needle: string): string | undefined {
    return tags.find((tag) => existsAtTag(tag, needle));
}

/** `undefined` and a version both render, so error messages read cleanly. */
function label(version: ServerVersion | undefined): string {
    return version ? formatServerVersion(version) : 'never';
}

describe('SETTING_COMPAT', () => {
    it('names the first release that actually reads each key', () => {
        const problems: string[] = [];
        for (const setting of SETTING_COMPAT) {
            const first = firstTagContaining(`"${setting.key}"`);
            const claimed = setting.since ? formatServerVersion(setting.since) : undefined;

            if (claimed && tags.includes(claimed)) {
                if (first !== claimed) {
                    problems.push(
                        `${setting.key}: the table says since ${claimed}, but the key first ` +
                        `appears at ${first ?? 'no released tag'}.`
                    );
                }
                continue;
            }

            // The claim is either "no server ever" or a version with no tag yet
            // (v0.4.0). Either way, no released tag may read it.
            if (first !== undefined) {
                problems.push(
                    `${setting.key}: the table says since ${label(setting.since)}, which is not a ` +
                    `released tag, but the key already appears at ${first}.`
                );
            }
        }
        expectNoProblems(problems);
    });

    it('has every key still present in the newest released tag that first read it', () => {
        const problems: string[] = [];
        const newest = tags[tags.length - 1];
        for (const setting of SETTING_COMPAT) {
            if (!setting.since || !tags.includes(formatServerVersion(setting.since))) {
                continue;
            }
            // Once a key is read it should stay read; a silent removal would
            // make the table over-promise for every later version.
            if (!existsAtTag(newest, `"${setting.key}"`)) {
                problems.push(
                    `${setting.key}: read from ${formatServerVersion(setting.since)}, but it is ` +
                    `gone again by ${newest}.`
                );
            }
        }
        expectNoProblems(problems);
    });
});

describe('RULE_COMPAT', () => {
    it('names the first release whose from_code accepts each code', () => {
        const problems: string[] = [];
        for (const rule of RULE_COMPAT) {
            const claimed = formatServerVersion(rule.since);
            const first = firstTagAccepting(rule.code);

            if (!tags.includes(claimed)) {
                if (first !== undefined) {
                    problems.push(
                        `${rule.code}: the table says since ${claimed}, which is not a released ` +
                        `tag, but from_code already accepts it at ${first}.`
                    );
                }
                continue;
            }
            if (first !== claimed) {
                problems.push(
                    `${rule.code}: the table says since ${claimed}, but from_code first accepts ` +
                    `it at ${first ?? 'no released tag'}.`
                );
            }
        }
        expectNoProblems(problems);
    });

    it('finds every code in the diagnostics module, not just anywhere in src', () => {
        const problems: string[] = [];
        for (const rule of RULE_COMPAT) {
            const claimed = formatServerVersion(rule.since);
            if (!tags.includes(claimed)) {
                continue;
            }
            const files = filesContainingAtTag(claimed, `"${rule.code}"`);
            if (!files.includes('src/diagnostics.rs')) {
                problems.push(
                    `${rule.code}: at ${claimed} the code appears in ${files.join(', ') || 'nothing'}, ` +
                    'but not in src/diagnostics.rs where from_code lives.'
                );
            }
        }
        expectNoProblems(problems);
    });

    it('agrees that no v0.1.x server could disable anything at all', () => {
        // The table leans on this: on those servers the whole disabledRules
        // setting is inert, so the extension reports the setting rather than
        // each rule inside it.
        const problems: string[] = [];
        for (const tag of tags) {
            if (tagAtLeast(tag, 'v0.2.0')) {
                continue;
            }
            if (codesAcceptedAtTag(tag) !== undefined) {
                problems.push(`${tag} has a from_code after all, so disabledRules is not inert there.`);
            }
        }
        expectNoProblems(problems);
    });

    it('gets the renamed rule right in both directions', () => {
        const problems: string[] = [];
        for (const rule of RULE_COMPAT) {
            if (!rule.previousCode || !rule.previousCodeSince) {
                continue;
            }
            const oldFirst = firstTagAccepting(rule.previousCode);
            const claimedOld = formatServerVersion(rule.previousCodeSince);
            if (oldFirst !== claimedOld) {
                problems.push(
                    `${rule.code}: the table says the old spelling '${rule.previousCode}' was ` +
                    `accepted from ${claimedOld}, but from_code first accepts it at ` +
                    `${oldFirst ?? 'no released tag'}.`
                );
            }

            // The rewrite only makes sense if the old spelling really stopped
            // working when the new one arrived.
            for (const tag of tags) {
                if (!tagAtLeast(tag, formatServerVersion(rule.since))) {
                    continue;
                }
                if (codesAcceptedAtTag(tag)?.includes(rule.previousCode)) {
                    problems.push(
                        `${rule.code}: ${tag} still accepts the old spelling ` +
                        `'${rule.previousCode}', so rewriting for older servers is not the whole story.`
                    );
                }
            }
        }
        expectNoProblems(problems);
    });

    it('accounts for every code the newest released server accepts', () => {
        const newest = tags[tags.length - 1];
        const accepted = codesAcceptedAtTag(newest);
        expect(accepted, `no from_code found at ${newest}`).toBeDefined();

        const expected = RULE_COMPAT.filter((rule) => tagAtLeast(newest, formatServerVersion(rule.since)))
            .map((rule) => rule.code)
            .sort();

        // Both directions: nothing claimed that is missing, and nothing the
        // server accepts that the table never mentions.
        expect([...accepted!].sort()).toEqual(expected);
    });
});

/**
 * A token in the server sources that proves a feature is really implemented.
 *
 * The feature names themselves are a client-side vocabulary, so there is
 * nothing to grep for directly. These are the identifiers each behaviour is
 * built on instead.
 */
const FEATURE_MARKERS: Record<string, string[]> = {
    [FEATURE_PULL_DIAGNOSTICS]: ['diagnostic_provider'],
    [FEATURE_WATCHED_FILES]: ['did_change_watched_files'],
    [FEATURE_DIAGNOSTIC_REFRESH]: ['workspace_diagnostic_refresh'],
};

describe('FEATURE_COMPAT', () => {
    it('has an audit marker for every feature', () => {
        // The checks below index FEATURE_MARKERS directly, so a feature added
        // without a marker would fail them as a TypeError rather than as
        // something a reader can act on. Say it plainly first.
        const problems = FEATURE_COMPAT.filter((feature) => !FEATURE_MARKERS[feature.name]).map(
            (feature) =>
                `${feature.name}: no audit marker defined, so nothing here can tell whether the ` +
                'server implements it.'
        );
        expectNoProblems(problems);
    });

    it('claims no feature that a released tag already has', () => {
        const problems: string[] = [];
        for (const feature of FEATURE_COMPAT) {
            const claimed = formatServerVersion(feature.since);
            for (const tag of tags) {
                const has = FEATURE_MARKERS[feature.name].some((marker) => existsAtTag(tag, marker));
                const shouldHave = tagAtLeast(tag, claimed);
                if (has && !shouldHave) {
                    problems.push(
                        `${feature.name}: the table says since ${claimed}, but ${tag} already has ` +
                        `it (found '${FEATURE_MARKERS[feature.name].join("' or '")}' in src/).`
                    );
                }
                if (!has && shouldHave) {
                    problems.push(
                        `${feature.name}: the table says ${tag} has it, but none of ` +
                        `'${FEATURE_MARKERS[feature.name].join("', '")}' appear in src/.`
                    );
                }
            }
        }
        expectNoProblems(problems);
    });

    it('finds every feature really implemented on the unreleased branch', () => {
        const backend = fileInWorkingTree('src/backend.rs');
        expect(backend, 'src/backend.rs is missing from the server working tree').toBeDefined();

        const problems: string[] = [];
        for (const feature of FEATURE_COMPAT) {
            if (tags.includes(formatServerVersion(feature.since))) {
                continue;
            }
            const found = FEATURE_MARKERS[feature.name].some((marker) => backend!.includes(marker));
            if (!found) {
                problems.push(
                    `${feature.name}: the table says it is new in ${formatServerVersion(feature.since)}, ` +
                    'but nothing in the working tree implements it.'
                );
            }
        }
        expectNoProblems(problems);
    });

    it('uses the same feature names the server advertises', () => {
        const backend = fileInWorkingTree('src/backend.rs') ?? '';
        const problems = FEATURE_COMPAT.filter((feature) => !backend.includes(`"${feature.name}"`)).map(
            (feature) =>
                `${feature.name}: the extension branches on this name, but the server never ` +
                'sends it. The two lists have drifted apart.'
        );
        expectNoProblems(problems);
    });
});

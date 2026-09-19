// Rewrites FALLBACK_SERVER_VERSION in src/common/constants.ts to the newest
// stable server release that has an archive for every supported platform.
// Run by the release workflow before packaging; set GITHUB_TOKEN to avoid the
// unauthenticated API rate limit.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/** Must match TAG_PATTERN in src/common/download.ts. */
export const TAG_PATTERN = /^v?\d+\.\d+\.\d+[\w.-]*$/;

/** Must match UNIFIED_BINARY_VERSION in src/common/compatTable.ts. */
const UNIFIED_BINARY_VERSION = { major: 0, minor: 5, patch: 0 };

/** Every platform/extension combination getPlatformInfo() in src/common/constants.ts can ask for. */
const PLATFORM_TARGETS = [
    'x86_64-pc-windows-msvc.zip',
    'aarch64-apple-darwin.tar.xz',
    'x86_64-apple-darwin.tar.xz',
    'aarch64-unknown-linux-gnu.tar.xz',
    'x86_64-unknown-linux-gnu.tar.xz',
];

function parseVersion(tag) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag);
    return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : undefined;
}

function isAtLeast(version, minimum) {
    if (version.major !== minimum.major) return version.major > minimum.major;
    if (version.minor !== minimum.minor) return version.minor > minimum.minor;
    return version.patch >= minimum.patch;
}

/**
 * The archive basename a release of this tag uses: 'hydrust' from v0.5.0
 * onwards, 'hydra-lsp' before it. Must match archiveName in
 * src/common/compatTable.ts.
 */
function binaryBaseName(tag) {
    const version = parseVersion(tag);
    return version && isAtLeast(version, UNIFIED_BINARY_VERSION) ? 'hydrust' : 'hydra-lsp';
}

/** Every archive asset name a release of this tag must publish, one per supported platform. */
export function platformAssetsFor(tag) {
    const baseName = binaryBaseName(tag);
    return PLATFORM_TARGETS.map((target) => `${baseName}-${target}`);
}

const PIN_PATTERN = /(export const FALLBACK_SERVER_VERSION = ')[^']*(';)/;

/** Compare two tags newest first. Must match compareVersionsDesc in src/common/download.ts. */
export function compareTagsDesc(a, b) {
    const parse = (v) => {
        const match = /^\d+(\.\d+)*/.exec(v);
        return match ? { segs: match[0].split('.').map(Number), suffix: v.slice(match[0].length) } : null;
    };
    const [x, y] = [parse(a.replace(/^v/, '')), parse(b.replace(/^v/, ''))];
    if (x && y) {
        for (let i = 0; i < Math.max(x.segs.length, y.segs.length); i++) {
            const diff = (y.segs[i] ?? 0) - (x.segs[i] ?? 0);
            if (diff !== 0) {
                return diff;
            }
        }
        if (!x.suffix || !y.suffix) {
            return x.suffix === y.suffix ? 0 : x.suffix ? 1 : -1;
        }
        return y.suffix.localeCompare(x.suffix, undefined, { numeric: true });
    }
    return b.replace(/^v/, '').localeCompare(a.replace(/^v/, ''));
}

/** The highest stable release, by version, with every platform archive for its own naming era. */
export function pickPinnableRelease(releases) {
    const eligible = releases.filter((release) => typeof release.tag_name === 'string' && TAG_PATTERN.test(release.tag_name));
    eligible.sort((a, b) => compareTagsDesc(a.tag_name, b.tag_name));
    for (const release of eligible) {
        if (release.draft || release.prerelease || !Array.isArray(release.assets)) {
            continue;
        }
        const names = new Set(release.assets.map((asset) => asset.name));
        if (platformAssetsFor(release.tag_name).every((name) => names.has(name))) {
            return release.tag_name;
        }
    }
    return undefined;
}

export function rewritePin(source, tag) {
    if (!PIN_PATTERN.test(source)) {
        throw new Error('FALLBACK_SERVER_VERSION declaration not found');
    }
    return source.replace(PIN_PATTERN, `$1${tag}$2`);
}

async function main() {
    const constantsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/common/constants.ts');
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'hydrust-vscode-release' };
    if (process.env.GITHUB_TOKEN) {
        headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const response = await fetch('https://api.github.com/repos/m-lyon/hydra-lsp/releases?per_page=100', { headers });
    if (!response.ok) {
        throw new Error(`GitHub releases API returned ${response.status}`);
    }
    const tag = pickPinnableRelease(await response.json());
    if (!tag) {
        throw new Error('No stable release has an archive for every platform');
    }

    const source = await readFile(constantsPath, 'utf8');
    const current = source.match(PIN_PATTERN)?.[0].match(/'([^']*)'/)?.[1];
    if (current && TAG_PATTERN.test(current) && compareTagsDesc(tag, current) > 0) {
        throw new Error(`Refusing to lower FALLBACK_SERVER_VERSION from ${current} to ${tag}`);
    }
    await writeFile(constantsPath, rewritePin(source, tag));
    console.log(`FALLBACK_SERVER_VERSION pinned to ${tag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => {
        console.error(err.message);
        process.exit(1);
    });
}

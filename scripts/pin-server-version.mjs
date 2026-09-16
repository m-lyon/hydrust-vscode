// Rewrites FALLBACK_SERVER_VERSION in src/common/constants.ts to the newest
// stable hydra-lsp release that has an archive for every supported platform.
// Run by the release workflow before packaging; set GITHUB_TOKEN to avoid the
// unauthenticated API rate limit.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/** Every archive getPlatformInfo() in src/common/constants.ts can ask for. */
export const PLATFORM_ASSETS = [
    'hydra-lsp-x86_64-pc-windows-msvc.zip',
    'hydra-lsp-aarch64-apple-darwin.tar.xz',
    'hydra-lsp-x86_64-apple-darwin.tar.xz',
    'hydra-lsp-aarch64-unknown-linux-gnu.tar.xz',
    'hydra-lsp-x86_64-unknown-linux-gnu.tar.xz',
];

/** Must match TAG_PATTERN in src/common/download.ts. */
const TAG_PATTERN = /^v?\d+\.\d+\.\d+[\w.-]*$/;

const PIN_PATTERN = /(export const FALLBACK_SERVER_VERSION = ')[^']*(';)/;

/** The first stable release, in the API's newest-first order, with every platform archive. */
export function pickPinnableRelease(releases) {
    for (const release of releases) {
        if (release.draft || release.prerelease || typeof release.tag_name !== 'string' || !TAG_PATTERN.test(release.tag_name) || !Array.isArray(release.assets)) {
            continue;
        }
        const names = new Set(release.assets.map((asset) => asset.name));
        if (PLATFORM_ASSETS.every((name) => names.has(name))) {
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
        throw new Error('No stable hydra-lsp release has an archive for every platform');
    }

    const source = await readFile(constantsPath, 'utf8');
    await writeFile(constantsPath, rewritePin(source, tag));
    console.log(`FALLBACK_SERVER_VERSION pinned to ${tag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => {
        console.error(err.message);
        process.exit(1);
    });
}

/**
 * Tests for the paths and URLs the extension builds around the server binary.
 *
 * The names in them are version-keyed: everything up to v0.4.0 is called
 * `hydra-lsp`, everything from v0.5.0 is called `hydrust`. Getting that wrong
 * means downloading an asset that does not exist, or looking for an executable
 * next to the one that was extracted, so it is worth pinning per version rather
 * than trusting the table alone.
 */

import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
    getArchiveDirectoryName,
    getArchiveFileNameCandidates,
    getChecksumUrl,
    getDownloadUrl,
    getExecutablePath,
    getPlatformInfo,
} from '../../src/common/constants';

const platformInfo = getPlatformInfo();

/** The extension context the path helpers hang everything off. */
const context = { globalStorageUri: { fsPath: path.join('/tmp', 'hydrust-global-storage') } };

/** Where a given version's executable is expected to land, as path segments. */
function executableSegments(version: string): string[] {
    return getExecutablePath(context, version).split(path.sep).filter((segment) => segment.length > 0);
}

describe('the archive directory name', () => {
    it('is named after the release it came from', () => {
        expect(getArchiveDirectoryName(platformInfo, 'v0.4.0')).toBe(`hydra-lsp-${platformInfo.platform}`);
        expect(getArchiveDirectoryName(platformInfo, 'v0.5.0')).toBe(`hydrust-${platformInfo.platform}`);
    });

    it('does not care whether the version carries a leading v', () => {
        expect(getArchiveDirectoryName(platformInfo, '0.5.0')).toBe(
            getArchiveDirectoryName(platformInfo, 'v0.5.0')
        );
    });

    it('falls back to the old name for something it cannot read', () => {
        // A stray directory under bundled/libs, most likely. Every install that
        // exists today is pre-rename, so that is the safer guess.
        expect(getArchiveDirectoryName(platformInfo, 'nonsense')).toBe(`hydra-lsp-${platformInfo.platform}`);
    });
});

describe('the download and checksum URLs', () => {
    it('ask for the asset name that release really publishes', () => {
        expect(getDownloadUrl('v0.4.0', platformInfo)).toBe(
            'https://github.com/m-lyon/hydra-lsp/releases/download/v0.4.0/' +
            `hydra-lsp-${platformInfo.platform}.${platformInfo.archiveExt}`
        );
        expect(getDownloadUrl('v0.5.0', platformInfo)).toBe(
            'https://github.com/m-lyon/hydra-lsp/releases/download/v0.5.0/' +
            `hydrust-${platformInfo.platform}.${platformInfo.archiveExt}`
        );
    });

    it('keep pointing at the repository, which is not being renamed', () => {
        expect(getChecksumUrl('v0.5.0', platformInfo)).toBe(`${getDownloadUrl('v0.5.0', platformInfo)}.sha256`);
    });
});

describe('the candidate asset names used when scanning releases', () => {
    it('covers both namings, newest first', () => {
        expect(getArchiveFileNameCandidates(platformInfo)).toEqual([
            `hydrust-${platformInfo.platform}.${platformInfo.archiveExt}`,
            `hydra-lsp-${platformInfo.platform}.${platformInfo.archiveExt}`,
        ]);
    });
});

describe('the executable path', () => {
    it('points inside the directory the archive extracts to', () => {
        const suffix = platformInfo.executableSuffix;

        expect(executableSegments('v0.4.0').slice(-4)).toEqual([
            'libs',
            '0.4.0',
            `hydra-lsp-${platformInfo.platform}`,
            `hydra-lsp${suffix}`,
        ]);
        expect(executableSegments('v0.5.0').slice(-4)).toEqual([
            'libs',
            '0.5.0',
            `hydrust-${platformInfo.platform}`,
            `hydrust${suffix}`,
        ]);
    });

    it('keeps the two namings apart, so both installs can sit under the same libs root', () => {
        expect(getExecutablePath(context, '0.4.0')).not.toBe(getExecutablePath(context, '0.5.0'));
    });
});

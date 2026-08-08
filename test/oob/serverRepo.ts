/**
 * Helpers for the out-of-band suites, which need things a plain checkout of
 * this repository does not have.
 *
 * Both suites fail loudly when what they need is missing. A suite that quietly
 * skips looks green while checking nothing, which is worse than having no suite
 * at all: it is the drift between the two repositories these are meant to
 * catch, and drift is exactly when the prerequisites tend to go astray.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** This repository's root, worked out from this file's location. */
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Where the hydra-lsp server sources live.
 *
 * `$HYDRA_LSP_REPO` wins so CI can put the checkout wherever it likes;
 * otherwise the sibling directory is used, which is how it is laid out locally.
 */
export function serverRepoPath(): string {
    return process.env.HYDRA_LSP_REPO
        ? path.resolve(process.env.HYDRA_LSP_REPO)
        : path.resolve(REPO_ROOT, '..', 'hydra-lsp');
}

/**
 * Check the server checkout is really there, and stop with an explanation if
 * it is not.
 */
export function requireServerRepo(): string {
    const repo = serverRepoPath();
    if (!fs.existsSync(path.join(repo, '.git'))) {
        throw new Error(
            `The hydra-lsp server repository was not found at ${repo}.\n` +
            'This suite reads the tagged server sources, so it cannot run without it.\n' +
            'Clone https://github.com/m-lyon/hydra-lsp next to this repository, or set\n' +
            '$HYDRA_LSP_REPO to point at an existing checkout.'
        );
    }
    return repo;
}

/** Run a read-only git command in the server repository. */
export function git(args: string[]): string {
    return execFileSync('git', ['-C', requireServerRepo(), ...args], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        // Capture stderr rather than letting it through to the terminal: the
        // helpers below fold it into the error they throw.
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

/** What execFileSync attaches to the error when a command exits non-zero. */
interface GitFailure {
    status?: number;
    stdout?: string;
    stderr?: string;
}

/** Turn a git failure into an error that says what went wrong. */
function gitError(args: string[], err: GitFailure): Error {
    const stderr = (err.stderr ?? '').trim();
    return new Error(
        `git ${args.join(' ')} failed with exit code ${err.status ?? 'unknown'}` +
        (stderr ? `:\n${stderr}` : '')
    );
}

/**
 * Run a git command that is allowed to find nothing, e.g. `git grep`.
 *
 * Only the exit codes in `expectedFailures` count as "found nothing" — git uses
 * 1 for that and 128 for a real problem, such as a tag that does not exist or a
 * checkout too shallow to hold the commit. Those are rethrown, because a
 * broken checkout that reads as "no match" turns the audit suite's conclusions
 * into confident nonsense.
 */
export function gitMayFail(
    args: string[],
    expectedFailures: number[] = [1]
): { ok: boolean; output: string } {
    try {
        return { ok: true, output: git(args) };
    } catch (err) {
        const failure = err as GitFailure;
        if (failure.status !== undefined && expectedFailures.includes(failure.status)) {
            return { ok: false, output: failure.stdout ?? '' };
        }
        throw gitError(args, failure);
    }
}

/** Every release tag in the server repository, oldest first. */
export function releasedTags(): string[] {
    return git(['tag', '--list', 'v*'])
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^v\d+\.\d+\.\d+$/.test(line))
        .sort(compareTags);
}

/** Order two `vX.Y.Z` tags by release order. */
export function compareTags(a: string, b: string): number {
    const parse = (tag: string) => tag.slice(1).split('.').map(Number);
    const [aMajor, aMinor, aPatch] = parse(a);
    const [bMajor, bMinor, bPatch] = parse(b);
    return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
}

/** True when `tag` is `minimum` or newer. */
export function tagAtLeast(tag: string, minimum: string): boolean {
    return compareTags(tag, minimum) >= 0;
}

/**
 * Read a file as it was at a tag. Returns undefined when it did not exist.
 *
 * `git show` reports both "no such path" and "no such tag" as exit code 128, so
 * the two are told apart by what git says: only the missing path is a real
 * answer, and a tag git cannot resolve is a broken checkout that should stop
 * the suite.
 */
export function fileAtTag(tag: string, filePath: string): string | undefined {
    const args = ['show', `${tag}:${filePath}`];
    try {
        return git(args);
    } catch (err) {
        const failure = err as GitFailure;
        const stderr = failure.stderr ?? '';
        if (/does not exist in|exists on disk, but not in/.test(stderr)) {
            return undefined;
        }
        throw gitError(args, failure);
    }
}

/** Read a file from the server working tree, i.e. the unreleased branch. */
export function fileInWorkingTree(filePath: string): string | undefined {
    const full = path.join(requireServerRepo(), filePath);
    return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : undefined;
}

/** True when `needle` appears anywhere under `src/` at that tag. */
export function existsAtTag(tag: string, needle: string): boolean {
    return gitMayFail(['grep', '--fixed-strings', '--quiet', needle, tag, '--', 'src/']).ok;
}

/** The files under `src/` at a tag that contain `needle`. */
export function filesContainingAtTag(tag: string, needle: string): string[] {
    const result = gitMayFail(['grep', '--fixed-strings', '--name-only', needle, tag, '--', 'src/']);
    return result.output
        .split('\n')
        .map((line) => line.replace(`${tag}:`, '').trim())
        .filter((line) => line.length > 0);
}

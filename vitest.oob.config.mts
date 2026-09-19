import { defineConfig } from 'vitest/config';

/**
 * The out-of-band suites, which are deliberately kept out of `npm test`.
 *
 * These need things a plain checkout does not have: a built hydra-lsp binary
 * for the contract suite, and the sibling server repository with its tags for
 * the table audit. Both fail loudly when what they need is missing, rather than
 * skipping, because a suite that quietly passes with nothing to check is worse
 * than no suite at all.
 *
 * Nothing here imports 'vscode', so no alias is needed.
 */
export default defineConfig({
    test: {
        include: ['test/oob/**/*.test.ts'],
        environment: 'node',
        // Booting a debug build of the server and shelling out to git are both
        // slower than anything in the hermetic suite.
        testTimeout: 60000,
        hookTimeout: 60000,
    },
});

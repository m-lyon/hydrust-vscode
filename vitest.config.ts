import * as path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        alias: {
            vscode: path.resolve(__dirname, 'test/stubs/vscode.ts'),
        },
    },
    test: {
        include: ['test/unit/**/*.test.ts'],
        environment: 'node',
        testTimeout: 10000,
    },
});

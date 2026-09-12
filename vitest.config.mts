import * as path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

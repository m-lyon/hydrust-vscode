import { describe, expect, it } from 'vitest';

import { buildInitializationSettings } from '../../src/common/initializationSettings';
import type { ExtensionSettings } from '../../src/common/settings';

/** Settings as a fresh install would read them, with per-test overrides. */
function settings(overrides: Partial<ExtensionSettings> = {}): ExtensionSettings {
    return {
        path: '',
        interpreter: '',
        importStrategy: 'fromEnvironment',
        serverVersion: 'latest',
        traceServer: 'off',
        disabledRules: [],
        enableHover: true,
        enableCompletion: true,
        enableSignatureHelp: true,
        enableGotoDefinition: true,
        enableSemanticTokens: true,
        enableDiagnostics: true,
        numThreads: 0,
        developerMode: false,
        ...overrides,
    };
}

describe('buildInitializationSettings', () => {
    it('passes the feature switches and disabled rules through', () => {
        const payload = buildInitializationSettings(
            settings({
                disabledRules: ['missing-argument'],
                enableHover: false,
                enableCompletion: false,
                enableSignatureHelp: false,
                enableGotoDefinition: false,
                enableSemanticTokens: false,
                enableDiagnostics: false,
            })
        );

        expect(payload).toMatchObject({
            disabledRules: ['missing-argument'],
            enableHover: false,
            enableCompletion: false,
            enableSignatureHelp: false,
            enableGotoDefinition: false,
            enableSemanticTokens: false,
            enableDiagnostics: false,
        });
    });

    it('sends numThreads only when it is positive', () => {
        // The server sizes its pools from the CPU count when the value is
        // absent, but clamps an explicit 0 up to a single thread, so 0 has to
        // be left out rather than sent.
        expect(buildInitializationSettings(settings({ numThreads: 4 })).numThreads).toBe(4);
        expect(buildInitializationSettings(settings({ numThreads: 0 })).numThreads).toBeUndefined();
        expect(buildInitializationSettings(settings({ numThreads: -1 })).numThreads).toBeUndefined();
    });

    it('forwards a numThreads the settings enum does not offer', () => {
        // package.json offers 0 and 3..11, but the enum is advice: a
        // hand-edited settings.json can hold anything. The value is sent as it
        // stands rather than being second-guessed here, because the server owns
        // the bounds — it clamps 1, 2 and anything above its maximum, and says
        // in its initialize log what it did and why. Clamping here as well
        // would put the same two numbers in two repositories and hide the
        // explanation from the person who needs it.
        expect(buildInitializationSettings(settings({ numThreads: 2 })).numThreads).toBe(2);
        expect(buildInitializationSettings(settings({ numThreads: 64 })).numThreads).toBe(64);
    });

    it('sends the interpreter path only when one is set', () => {
        expect(buildInitializationSettings(settings({ interpreter: '/usr/bin/python' })).pythonInterpreter).toBe(
            '/usr/bin/python'
        );
        expect(buildInitializationSettings(settings({ interpreter: '' })).pythonInterpreter).toBeUndefined();
    });

    it('sends nothing beyond the keys the server reads', () => {
        // logLevel and the client-only settings (serverPath, importStrategy,
        // traceServer, developerMode) were removed on purpose.
        const payload = buildInitializationSettings(settings({ numThreads: 2, interpreter: '/usr/bin/python' }));

        expect(Object.keys(payload).sort()).toEqual([
            'disabledRules',
            'enableCompletion',
            'enableDiagnostics',
            'enableGotoDefinition',
            'enableHover',
            'enableSemanticTokens',
            'enableSignatureHelp',
            'numThreads',
            'pythonInterpreter',
        ]);
    });
});

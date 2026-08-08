/**
 * Builds the `initializationOptions.settings` object handed to the server.
 *
 * Kept apart from server.ts, and importing only the settings *type*, so it can
 * be tested without an extension host. The rules here are behavioural: what the
 * server is sent and what it is deliberately not sent.
 */

import type { ExtensionSettings } from './settings';

/**
 * Turn the extension's settings into the payload the server reads at
 * initialize time.
 */
export function buildInitializationSettings(settings: ExtensionSettings): Record<string, unknown> {
    return {
        pythonInterpreter: settings.interpreter ? settings.interpreter : undefined,
        disabledRules: settings.disabledRules,
        enableHover: settings.enableHover,
        enableCompletion: settings.enableCompletion,
        enableSignatureHelp: settings.enableSignatureHelp,
        enableGotoDefinition: settings.enableGotoDefinition,
        enableSemanticTokens: settings.enableSemanticTokens,
        enableDiagnostics: settings.enableDiagnostics,
        numThreads: settings.numThreads > 0 ? settings.numThreads : undefined,
    };
}

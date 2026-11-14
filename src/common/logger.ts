import * as util from 'node:util';
import * as vscode from 'vscode';

class ExtensionLogger {
    /**
     * The output channel used to log messages for the extension.
     */
    readonly channel = vscode.window.createOutputChannel('Hydrust', { log: true });

    /**
     * Whether the extension is running in a CI environment.
     */
    private readonly isCI = process.env.CI === 'true';

    /**
     * Logs messages to the console if the extension is running in a CI environment.
     */
    private logForCI(...messages: unknown[]): void {
        if (this.isCI) {
            console.log(...messages);
        }
    }

    error(...messages: unknown[]): void {
        this.logForCI(...messages);
        this.channel.error(util.format(...messages));
    }

    warn(...messages: unknown[]): void {
        this.logForCI(...messages);
        this.channel.warn(util.format(...messages));
    }

    info(...messages: unknown[]): void {
        this.logForCI(...messages);
        this.channel.info(util.format(...messages));
    }

    debug(...messages: unknown[]): void {
        this.logForCI(...messages);
        this.channel.debug(util.format(...messages));
    }

    trace(...messages: unknown[]): void {
        this.logForCI(...messages);
        this.channel.trace(util.format(...messages));
    }
}

/**
 * The logger used by the extension.
 *
 * This will log the messages to the "Hydrust" output channel, optionally logging them
 * to the console if the extension is running in a CI environment (e.g., GitHub Actions).
 *
 * This should mainly be used for logging messages that are intended for the user.
 */
export const logger = new ExtensionLogger();

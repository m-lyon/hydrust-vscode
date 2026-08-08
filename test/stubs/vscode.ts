/**
 * A stand-in for the 'vscode' module, used by the hermetic unit tests.
 *
 * The real module only exists inside a running extension host, so vitest is
 * configured (see vitest.config.ts) to resolve every `import 'vscode'` to this
 * file instead. Only the small slice of the API the compatibility layer touches
 * is implemented here, and every interesting call is recorded so a test can
 * check what the extension did rather than guessing.
 *
 * Call `resetVscodeStub()` in a beforeEach so one test cannot see another's
 * recorded calls.
 */

/** One `commands.executeCommand` call, in the order it was made. */
export interface RecordedCommand {
    command: string;
    args: unknown[];
}

/** One `window.showWarningMessage` / `showInformationMessage` call. */
export interface RecordedMessage {
    kind: 'warning' | 'information' | 'error';
    message: string;
    items: string[];
}

/** The shape `WorkspaceConfiguration.inspect` hands back. */
export interface InspectResult {
    key: string;
    defaultValue?: unknown;
    globalValue?: unknown;
    workspaceValue?: unknown;
    workspaceFolderValue?: unknown;
    globalLanguageValue?: unknown;
    workspaceLanguageValue?: unknown;
    workspaceFolderLanguageValue?: unknown;
}

/**
 * A status bar item, with its properties left readable for assertions.
 *
 * Nothing under src/ creates one today, and the tests assert exactly that: the
 * compatibility layer reports through the log and `when` clause contexts, never
 * by putting something permanent in front of the user.
 */
export class StubStatusBarItem {
    text = '';
    alignment: number;
    priority: number | undefined;
    visible = false;
    disposed = false;

    constructor(alignment: number, priority?: number) {
        this.alignment = alignment;
        this.priority = priority;
    }

    show(): void {
        this.visible = true;
    }

    hide(): void {
        this.visible = false;
    }

    dispose(): void {
        this.disposed = true;
    }
}

/** Everything the tests can read or steer, gathered in one place. */
export interface VscodeStubState {
    /** Values behind `context.globalState`, for tests that build a context. */
    globalState: Map<string, unknown>;
    /** Every `commands.executeCommand` call, oldest first. */
    commands: RecordedCommand[];
    /** Every message shown to the user, oldest first. */
    messages: RecordedMessage[];
    /** Status bar items handed out by `window.createStatusBarItem`. */
    statusBarItems: StubStatusBarItem[];
    /** Lines written to the output channel, as `level: text`. */
    logs: string[];
    /** What `workspace.getConfiguration(...).inspect(key)` should return. */
    configInspect: Map<string, InspectResult>;
    /** Every `getConfiguration` call, as `section` plus the resource path. */
    configurationRequests: { section: string | undefined; resource: string | undefined }[];
}

/** Live stub state. Replaced wholesale by `resetVscodeStub`. */
export const stub: VscodeStubState = freshState();

function freshState(): VscodeStubState {
    return {
        globalState: new Map<string, unknown>(),
        commands: [],
        messages: [],
        statusBarItems: [],
        logs: [],
        configInspect: new Map<string, InspectResult>(),
        configurationRequests: [],
    };
}

/** Wipe every recorded call and steering value back to its starting point. */
export function resetVscodeStub(): void {
    Object.assign(stub, freshState());
}

/** The `setContext` calls, flattened to key/value pairs for easy assertions. */
export function recordedContexts(): Map<string, unknown> {
    const contexts = new Map<string, unknown>();
    for (const entry of stub.commands) {
        if (entry.command === 'setContext') {
            contexts.set(String(entry.args[0]), entry.args[1]);
        }
    }
    return contexts;
}

class StubDisposable {
    disposed = false;

    constructor(private readonly onDispose?: () => void) {}

    dispose(): void {
        this.disposed = true;
        this.onDispose?.();
    }
}

function log(level: string, message: string): void {
    stub.logs.push(`${level}: ${message}`);
}

const outputChannel = {
    name: 'Hydrust',
    error: (message: string) => log('error', message),
    warn: (message: string) => log('warn', message),
    info: (message: string) => log('info', message),
    debug: (message: string) => log('debug', message),
    trace: (message: string) => log('trace', message),
    append: (message: string) => log('append', message),
    appendLine: (message: string) => log('append', message),
    replace: (message: string) => log('replace', message),
    clear: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
};

export const StatusBarAlignment = { Left: 1, Right: 2 };

export class Uri {
    private constructor(readonly scheme: string, readonly fsPath: string) {}

    static file(fsPath: string): Uri {
        return new Uri('file', fsPath);
    }

    static parse(value: string): Uri {
        return new Uri('file', value);
    }

    toString(): string {
        return `${this.scheme}://${this.fsPath}`;
    }
}

export const window = {
    createOutputChannel: () => outputChannel,

    createStatusBarItem: (alignment: number, priority?: number) => {
        const item = new StubStatusBarItem(alignment, priority);
        stub.statusBarItems.push(item);
        return item;
    },

    showWarningMessage: (message: string, ...items: string[]) => {
        stub.messages.push({ kind: 'warning', message, items });
        return Promise.resolve(undefined);
    },

    showInformationMessage: (message: string, ...items: string[]) => {
        stub.messages.push({ kind: 'information', message, items });
        return Promise.resolve(undefined);
    },

    showErrorMessage: (message: string, ...items: string[]) => {
        stub.messages.push({ kind: 'error', message, items });
        return Promise.resolve(undefined);
    },
};

export const commands = {
    executeCommand: (command: string, ...args: unknown[]) => {
        stub.commands.push({ command, args });
        return Promise.resolve(undefined);
    },
};

export const workspace = {
    getConfiguration: (section?: string, resource?: { fsPath?: string }) => {
        stub.configurationRequests.push({ section, resource: resource?.fsPath });
        return {
            get: (key: string) => stub.configInspect.get(key)?.defaultValue,
            inspect: (key: string) => stub.configInspect.get(key),
            has: (key: string) => stub.configInspect.has(key),
            update: () => Promise.resolve(undefined),
        };
    },

    workspaceFolders: undefined as unknown[] | undefined,

    onDidChangeConfiguration: () => new StubDisposable(),
};

/**
 * Build something shaped like an ExtensionContext, backed by the stub's
 * globalState map so a test can seed values and read them back afterwards.
 */
export function createStubExtensionContext(extensionPath = '/tmp/hydrust'): {
    extensionPath: string;
    subscriptions: { dispose(): void }[];
    globalState: {
        get<T>(key: string, defaultValue?: T): T | undefined;
        update(key: string, value: unknown): Promise<void>;
        keys(): readonly string[];
        setKeysForSync(): void;
    };
} {
    return {
        extensionPath,
        subscriptions: [],
        globalState: {
            get<T>(key: string, defaultValue?: T): T | undefined {
                return stub.globalState.has(key) ? (stub.globalState.get(key) as T) : defaultValue;
            },
            async update(key: string, value: unknown): Promise<void> {
                stub.globalState.set(key, value);
            },
            keys(): readonly string[] {
                return [...stub.globalState.keys()];
            },
            setKeysForSync(): void {
                // Nothing to do; the extension never calls this.
            },
        },
    };
}

export const Disposable = StubDisposable;

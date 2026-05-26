// Hand-rolled mock of the `vscode` namespace.
// Grows per phase. T-P2-001 surface: showInformationMessage, registerCommand,
// executeCommand, workspaceFolders.

import { vi } from "vitest";

export interface Disposable {
  dispose: () => unknown;
}

export interface SecretsApi {
  get: (key: string) => PromiseLike<string | undefined>;
  store: (key: string, value: string) => PromiseLike<void>;
  delete: (key: string) => PromiseLike<void>;
}

export interface ExtensionContext {
  subscriptions: Disposable[];
  secrets: SecretsApi;
}

export const window = {
  showInformationMessage: vi.fn<(message: string) => Promise<undefined>>(
    () => Promise.resolve(undefined),
  ),
  showErrorMessage: vi.fn<(message: string) => Promise<undefined>>(
    () => Promise.resolve(undefined),
  ),
  // Trust prompt uses showWarningMessage with modal:true. Tests override
  // the return value to simulate "Trust" / "Don't trust" / dismissal.
  showWarningMessage: vi.fn<
    (
      message: string,
      ...items: (string | { modal?: boolean })[]
    ) => Promise<string | undefined>
  >(() => Promise.resolve(undefined)),
  // API-key prompt uses showInputBox with {password: true}. Tests override
  // return value to simulate submit / empty / dismiss.
  showInputBox: vi.fn<
    (opts?: {
      password?: boolean;
      ignoreFocusOut?: boolean;
      prompt?: string;
    }) => Promise<string | undefined>
  >(() => Promise.resolve(undefined)),
};

export const commands = {
  registerCommand: vi.fn<
    (id: string, handler: (...args: unknown[]) => unknown) => Disposable
  >(() => ({ dispose: vi.fn() })),
  executeCommand: vi.fn<(command: string) => Promise<undefined>>(
    () => Promise.resolve(undefined),
  ),
};

export interface WorkspaceFolder {
  uri: { fsPath: string };
  name: string;
}

export const workspace: {
  workspaceFolders: WorkspaceFolder[] | undefined;
} = {
  workspaceFolders: undefined,
};

// Test helper for constructing WorkspaceFolder fixtures.
// parse() returns a minimal Uri-shaped object for vscode.open argument
// passing in status-bar-menu; tests don't introspect the parsed shape.
export const Uri = {
  file(fsPath: string): { fsPath: string } {
    return { fsPath };
  },
  parse(s: string): { toString(): string } {
    return { toString: () => s };
  },
};

export interface WorkspaceConfiguration {
  get: <T>(key: string, defaultValue?: T) => T;
}

// Test helper for the getConfiguration() return value. Default impl
// returns the supplied default; tests override per case.
export function makeWorkspaceConfig(
  values: Record<string, unknown> = {},
): WorkspaceConfiguration {
  return {
    get: <T>(key: string, defaultValue?: T): T => {
      const v = values[key];
      if (v === undefined) {
        // The cast narrows T | undefined to T at the return boundary;
        // recommendedTypeChecked flags it as unnecessary because under
        // its analysis `defaultValue: T | undefined` may already satisfy
        // the return type when T = unknown. Inline-disable matches the
        // sdk-runner.ts precedent for type-aware-rules-vs-generics edges.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        return defaultValue as T;
      }
      return v as T;
    },
  };
}

// Default getConfiguration mock returns an empty config (all keys return
// their defaults). Tests override via vi.mocked(workspace.getConfiguration)
// .mockReturnValue(makeWorkspaceConfig({...})).
const defaultConfig = makeWorkspaceConfig();
(workspace as unknown as {
  getConfiguration: ReturnType<typeof vi.fn>;
}).getConfiguration = vi.fn(() => defaultConfig);

// T-P2-006: status bar + markdown + quickpick + clipboard mocks.

export const StatusBarAlignment = {
  Left: 1,
  Right: 2,
} as const;

export class MarkdownString {
  public value = "";
  public isTrusted = false;
  constructor(value?: string) {
    if (value !== undefined) this.value = value;
  }
  appendMarkdown(text: string): this {
    this.value += text;
    return this;
  }
}

export interface StatusBarItem {
  text: string;
  tooltip: string | MarkdownString | undefined;
  command: string | undefined;
  alignment: number;
  priority: number;
  show: () => void;
  hide: () => void;
  dispose: () => void;
}

export function makeStatusBarItemMock(): StatusBarItem {
  return {
    text: "",
    tooltip: undefined,
    command: undefined,
    alignment: StatusBarAlignment.Left,
    priority: 0,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
}

// Attach createStatusBarItem onto the existing window object.
(window as unknown as {
  createStatusBarItem: ReturnType<typeof vi.fn>;
}).createStatusBarItem = vi.fn(
  (alignment?: number, priority?: number): StatusBarItem => {
    const item = makeStatusBarItemMock();
    if (alignment !== undefined) item.alignment = alignment;
    if (priority !== undefined) item.priority = priority;
    return item;
  },
);

// showQuickPick. Tests override return value to simulate selection.
// Items may be plain strings or QuickPickItem-like objects.
(window as unknown as {
  showQuickPick: ReturnType<typeof vi.fn>;
}).showQuickPick = vi.fn<
  (items: unknown[]) => Promise<unknown | undefined>
>(() => Promise.resolve(undefined));

// env.clipboard.writeText. Tests assert on calls.
export const env = {
  clipboard: {
    writeText: vi.fn<(s: string) => Promise<void>>(() => Promise.resolve()),
  },
};

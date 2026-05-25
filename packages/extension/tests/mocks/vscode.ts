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
export const Uri = {
  file(fsPath: string): { fsPath: string } {
    return { fsPath };
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
      return v === undefined ? (defaultValue as T) : (v as T);
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

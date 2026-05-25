// Hand-rolled mock of the `vscode` namespace.
// Grows per phase. T-P2-001 surface: showInformationMessage, registerCommand,
// executeCommand, workspaceFolders.

import { vi } from "vitest";

export interface Disposable {
  dispose: () => unknown;
}

export interface ExtensionContext {
  subscriptions: Disposable[];
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

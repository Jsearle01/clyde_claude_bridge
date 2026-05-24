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
};

export const commands = {
  registerCommand: vi.fn<
    (id: string, handler: (...args: unknown[]) => unknown) => Disposable
  >(() => ({ dispose: vi.fn() })),
  executeCommand: vi.fn<(command: string) => Promise<undefined>>(
    () => Promise.resolve(undefined),
  ),
};

export const workspace: {
  workspaceFolders: { uri: { fsPath: string } }[] | undefined;
} = {
  workspaceFolders: undefined,
};

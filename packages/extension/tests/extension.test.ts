import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import { activate } from "../src/extension.js";

describe("extension activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    // Reset workspaceFolders so the multi-root test doesn't bleed into others.
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  it("activates without throwing", () => {
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    expect(() => activate(context)).not.toThrow();
    expect(context.subscriptions.length).toBeGreaterThan(0);
  });

  it("registers the Show Status command", () => {
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    activate(context);
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      "claudeBridge.showStatus",
      expect.any(Function),
    );
  });

  it("AC-2b-6: multi-root workspace → pairs on [0] with a clear notice", () => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: { fsPath: "C:\\Projects\\a" }, name: "a" },
      { uri: { fsPath: "C:\\Projects\\b" }, name: "b" },
    ];
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    activate(context);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("multi-root"),
    );
    // dispose to stop the discovery poll timer (pushed onto subscriptions)
    for (const s of context.subscriptions) s.dispose();
  });
});

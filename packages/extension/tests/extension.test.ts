import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { activate } from "../src/extension.js";

describe("extension activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});

// Workspace trust prompt. Modal warning-message wrapper. Dismissal
// (user closes the modal without clicking) returns undefined from VS Code,
// which we map to "deny" per T-P2-003 Decision 7.

import * as vscode from "vscode";

export async function showTrustPrompt(
  abs_path: string,
): Promise<"trust" | "deny"> {
  const message =
    `Permit this workspace to receive delegations from claude-bridge clients?\n\n` +
    `Path: ${abs_path}\n\n` +
    `This authorizes any MCP client connected to your daemon (such as project-Claude chats in claude.ai) ` +
    `to delegate work against this workspace, subject to per-delegation approval.`;
  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    "Trust",
    "Don't trust",
  );
  return choice === "Trust" ? "trust" : "deny";
}

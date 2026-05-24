import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
  const showStatus = vscode.commands.registerCommand(
    "claudeBridge.showStatus",
    () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const workspacePath = folder ? folder.uri.fsPath : "(no workspace open)";
      const message =
        `Claude Bridge extension active. Workspace: ${workspacePath}. ` +
        `Daemon: not yet connected (Phase 2).`;
      void vscode.window.showInformationMessage(message);
    },
  );
  context.subscriptions.push(showStatus);
}

export function deactivate(): void {
  // Subscriptions registered on context are auto-disposed by VS Code.
}

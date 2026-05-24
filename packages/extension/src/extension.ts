import * as vscode from "vscode";
import { IpcClient, discoverDaemonEndpoint } from "./ipc/client.js";

const STATE_LABELS: Record<ReturnType<IpcClient["getConnectionState"]>, string> = {
  disconnected: "disconnected",
  connecting: "connecting",
  connected: "connected",
  version_mismatch: "version mismatch",
};

let ipcClient: IpcClient | null = null;

export function activate(context: vscode.ExtensionContext): void {
  ipcClient = new IpcClient(discoverDaemonEndpoint());
  // Don't block activation on connect — if the daemon isn't running,
  // IpcClient surfaces via its reconnect loop and the status command's
  // state read. Daemon-not-running UX with an actionable notification is
  // T-P2-005's territory.
  ipcClient.connect().catch(() => undefined);

  const showStatus = vscode.commands.registerCommand(
    "claudeBridge.showStatus",
    () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const workspacePath = folder ? folder.uri.fsPath : "(no workspace open)";
      const state = ipcClient?.getConnectionState() ?? "disconnected";
      const label = STATE_LABELS[state];
      const message =
        `Claude Bridge extension active. Workspace: ${workspacePath}. ` +
        `Daemon: ${label}.`;
      void vscode.window.showInformationMessage(message);
    },
  );
  context.subscriptions.push(showStatus);
  context.subscriptions.push({
    dispose: () => {
      ipcClient?.disconnect();
      ipcClient = null;
    },
  });
}

export function deactivate(): void {
  // Subscriptions registered on context are auto-disposed by VS Code.
}

import * as vscode from "vscode";
import { IpcClient, discoverDaemonEndpoint } from "./ipc/client.js";
import { WorkspaceRegistration } from "./registration.js";
import { startDaemon } from "./daemon-lifecycle.js";

const STATE_LABELS: Record<ReturnType<IpcClient["getConnectionState"]>, string> = {
  disconnected: "disconnected",
  connecting: "connecting",
  connected: "connected",
  version_mismatch: "version mismatch",
};

let ipcClient: IpcClient | null = null;
let registration: WorkspaceRegistration | null = null;

async function runStartDaemonCommand(
  context: vscode.ExtensionContext,
): Promise<void> {
  const config = vscode.workspace.getConfiguration("claudeBridge");
  const cliPath = config.get<string>("cliPath", "");
  const result = await startDaemon(
    { secrets: context.secrets },
    { cliPath: cliPath === "" ? undefined : cliPath },
  );
  if (result.ok) {
    void vscode.window.showInformationMessage(
      `Claude Bridge: daemon starting (pid ${result.pid})...`,
    );
    return;
  }
  if (result.kind === "already_running") {
    void vscode.window.showWarningMessage(
      `Claude Bridge: daemon is already running. Use \`claude-bridge stop\` to stop it first.`,
    );
    return;
  }
  void vscode.window.showErrorMessage(`Claude Bridge: ${result.error}`);
}

export function activate(context: vscode.ExtensionContext): void {
  ipcClient = new IpcClient(discoverDaemonEndpoint());
  // Don't block activation on connect — if the daemon isn't running,
  // IpcClient surfaces via its reconnect loop and the status command's
  // state read. Daemon-not-running UX with an actionable notification is
  // T-P2-005's territory.
  ipcClient.connect().catch(() => {
    // autoStartDaemon: when enabled and initial connect fails, fire
    // startDaemon once. The CLI handles "already running" gracefully so
    // races with manually-started daemons surface as a warning, not error.
    const autoStart = vscode.workspace
      .getConfiguration("claudeBridge")
      .get<boolean>("autoStartDaemon", false);
    if (autoStart) {
      void runStartDaemonCommand(context);
    }
  });

  registration = new WorkspaceRegistration(
    ipcClient,
    vscode.workspace.workspaceFolders?.[0],
  );
  // Fire-and-forget. The registration flow's internal wait-for-connect
  // covers the typical activation-vs-connection race; failure modes
  // surface via the status command's getState() / getIdentifier().
  void registration.register();

  const startDaemonCmd = vscode.commands.registerCommand(
    "claudeBridge.startDaemon",
    () => runStartDaemonCommand(context),
  );
  context.subscriptions.push(startDaemonCmd);

  const showStatus = vscode.commands.registerCommand(
    "claudeBridge.showStatus",
    () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const workspacePath = folder ? folder.uri.fsPath : "(no workspace open)";
      const daemonState = ipcClient?.getConnectionState() ?? "disconnected";
      const daemonLabel = STATE_LABELS[daemonState];
      const regState = registration?.getState() ?? "unregistered";
      const regId = registration?.getIdentifier() ?? "no identifier";
      let workspaceLabel: string;
      if (regState === "duplicate") {
        const pid = registration?.getExistingPid() ?? 0;
        workspaceLabel = `duplicate (another VS Code window has this folder; pid ${pid})`;
      } else if (regState === "trust_denied") {
        workspaceLabel =
          "trust denied (re-run command to retry, or close and reopen window)";
      } else {
        workspaceLabel = `${regState} (${regId})`;
      }
      const message =
        `Claude Bridge extension active. Workspace ${workspacePath} — ${workspaceLabel}. ` +
        `Daemon: ${daemonLabel}.`;
      void vscode.window.showInformationMessage(message);
    },
  );
  context.subscriptions.push(showStatus);
  context.subscriptions.push({
    dispose: () => {
      // Best-effort deregister; don't block dispose on the response.
      void registration?.deregister();
      registration = null;
      ipcClient?.disconnect();
      ipcClient = null;
    },
  });
}

export function deactivate(): void {
  // Subscriptions registered on context are auto-disposed by VS Code.
}

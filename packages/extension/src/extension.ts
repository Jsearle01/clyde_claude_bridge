import * as vscode from "vscode";
import { IpcClient, discoverDaemonEndpoint } from "./ipc/client.js";
import { WorkspaceRegistration } from "./registration.js";
import {
  runStartDaemonCommand,
  makeDaemonNotRunningHandler,
} from "./daemon-lifecycle.js";
import { makeStatusBar, type StatusBarSources } from "./status-bar.js";
import { makeStatusBarMenu } from "./status-bar-menu.js";

const STATE_LABELS: Record<ReturnType<IpcClient["getConnectionState"]>, string> = {
  disconnected: "disconnected",
  connecting: "connecting",
  connected: "connected",
  version_mismatch: "version mismatch",
};

let ipcClient: IpcClient | null = null;
let registration: WorkspaceRegistration | null = null;

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

  // T-P2-005: after NOTIFICATION_THRESHOLD (3) reconnect attempts,
  // surface an actionable [Start Daemon] notification. Factory builds a
  // fresh handler per activate so the once-per-session guard naturally
  // resets on reactivation. Setting is read at notification-time so
  // user changes between activation and trigger are honored. Logic +
  // tests live in daemon-lifecycle.ts.
  ipcClient.onReconnectAttempt = makeDaemonNotRunningHandler(context);

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

  // T-P2-006: status bar item + menu command. The status bar reads
  // aggregate state via two getters; refresh fires on each
  // ipcClient/registration state transition. Disposed via
  // context.subscriptions.
  const statusBarSources: StatusBarSources = {
    getConnectionState: () => ipcClient?.getConnectionState() ?? "disconnected",
    getRegistrationState: () => registration?.getState() ?? "unregistered",
    getRegistrationIdentifier: () => registration?.getIdentifier() ?? null,
    getRegistrationExistingPid: () => registration?.getExistingPid() ?? null,
    getWorkspaceFolder: () => vscode.workspace.workspaceFolders?.[0],
    // T-P2-006 stub: daemon info is not yet wired through IPC.
    // T-P2-007+ may surface daemon pid/url/uptime once the registry
    // replacement lands; tooltip degrades gracefully when undefined.
    getDaemonInfo: () => undefined,
  };
  const statusBar = makeStatusBar(statusBarSources);
  statusBar.refresh();
  context.subscriptions.push({ dispose: () => statusBar.dispose() });

  ipcClient.onStateChange = () => statusBar.refresh();
  registration.onStateChange = () => statusBar.refresh();

  const statusBarMenuHandler = makeStatusBarMenu(statusBarSources, context);
  const statusBarMenuCmd = vscode.commands.registerCommand(
    "claudeBridge.openStatusBarMenu",
    statusBarMenuHandler,
  );
  context.subscriptions.push(statusBarMenuCmd);

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

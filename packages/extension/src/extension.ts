import * as vscode from "vscode";
import { IpcClient, discoverDaemonEndpoint } from "./ipc/client.js";
import { WorkspaceRegistration } from "./registration.js";
import {
  runStartDaemonCommand,
  makeDaemonNotRunningHandler,
} from "./daemon-lifecycle.js";
import {
  makeStatusBar,
  type StatusBarSources,
  type BindingInfo,
} from "./status-bar.js";
import { makeStatusBarMenu } from "./status-bar-menu.js";
import { makeApprovalHandler } from "./approval-modal.js";
import { makeConsentHandlers } from "./oauth-consent.js";
import {
  makeGetOpenEditorsHandler,
  makeGetDiagnosticsHandler,
} from "./inspection-tools.js";
import { makeWorkspacePathProbe } from "./workspace-path-probe.js";
import {
  getDaemonsDir,
  computeWorkspaceIdentity,
  startPairing,
} from "./discovery.js";
import { diag } from "./diag.js";

const STATE_LABELS: Record<ReturnType<IpcClient["getConnectionState"]>, string> = {
  disconnected: "disconnected",
  connecting: "connecting",
  connected: "connected",
  version_mismatch: "version mismatch",
};

let ipcClient: IpcClient | null = null;
let registration: WorkspaceRegistration | null = null;

export function activate(context: vscode.ExtensionContext): void {
  diag("activate: entry", {
    extensionPath: context.extensionPath,
    env_debug: process.env.CLAUDE_BRIDGE_DEBUG,
  });
  // P3′-2b: the endpoint is no longer a fixed pipe — discovery (below) resolves
  // the per-daemon pipe by matching this workspace against the adverts and
  // re-targets the client via setEndpoint() before connecting. discoverDaemon-
  // Endpoint() is kept only as a harmless initial placeholder (superseded on
  // the first match). No eager connect — connect fires on a discovery match.
  ipcClient = new IpcClient(discoverDaemonEndpoint());

  // T-P2-005: after NOTIFICATION_THRESHOLD (3) reconnect attempts,
  // surface an actionable [Start Daemon] notification. Factory builds a
  // fresh handler per activate so the once-per-session guard naturally
  // resets on reactivation. Setting is read at notification-time so
  // user changes between activation and trigger are honored. Logic +
  // tests live in daemon-lifecycle.ts.
  // T-P2-008.8: also tee the attempt count into registration for retry-count
  // UX surfacing on the status bar (closes C-29).
  const daemonNotRunningHandler = makeDaemonNotRunningHandler(context);
  ipcClient.onReconnectAttempt = (attempt: number): void => {
    daemonNotRunningHandler(attempt);
    registration?.onReconnectAttempt(attempt);
  };

  registration = new WorkspaceRegistration(
    ipcClient,
    vscode.workspace.workspaceFolders?.[0],
  );
  // Fire-and-forget. The registration flow's internal wait-for-connect
  // covers the typical activation-vs-connection race; failure modes
  // surface via the status command's getState() / getIdentifier().
  void registration.register();

  // P3′-2b: discover this workspace's daemon and auto-pair. Compute the
  // case-folded identity from workspaceFolders[0].uri.fsPath (the same key the
  // daemon wrote into the advert's canonical_workspace), scan/poll the shared
  // daemons/ dir, and on a match re-target + connect (handshake = liveness;
  // works daemon-first OR window-first). Multi-root → pair on [0] with a clear
  // notice (scope b). Full status/no-pairing/spawn UI is Phase 3 (scope a).
  const folders = vscode.workspace.workspaceFolders;
  const pairFolder = folders?.[0];
  if (pairFolder !== undefined) {
    if (folders !== undefined && folders.length > 1) {
      void vscode.window.showInformationMessage(
        `Claude Bridge: multi-root workspace detected; pairing on the first folder: ${pairFolder.name}`,
      );
    }
    const identity = computeWorkspaceIdentity(pairFolder.uri.fsPath);
    diag("discovery: starting pairing", {
      identity,
      daemonsDir: getDaemonsDir(),
    });
    const pairing = startPairing({
      daemonsDir: getDaemonsDir(),
      identity,
      onMatch: (advert) => {
        // Re-target to the discovered per-daemon pipe and connect. The hello/
        // register handshake proves liveness; a stale advert fails it and the
        // reconnect loop retries the (stable) pipe until the daemon returns.
        ipcClient?.setEndpoint(advert.pipe);
        ipcClient?.connect().catch((err: unknown) => {
          diag("discovery: connect failed (stale advert / daemon down)", {
            error: String(err),
          });
          // autoStartDaemon (opt-in): fire once on a failed handshake.
          const autoStart = vscode.workspace
            .getConfiguration("claudeBridge")
            .get<boolean>("autoStartDaemon", false);
          if (autoStart) void runStartDaemonCommand(context);
        });
      },
    });
    context.subscriptions.push({ dispose: () => pairing.dispose() });
  }

  const startDaemonCmd = vscode.commands.registerCommand(
    "claudeBridge.startDaemon",
    () => runStartDaemonCommand(context),
  );
  context.subscriptions.push(startDaemonCmd);

  // T-P3-003: per-window OAuth binding state, set when the daemon sends
  // binding_established to this (the bound) window. Read by the status bar.
  let currentBinding: BindingInfo | null = null;

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
    // CB-DAEMON-LIFECYCLE-FIX: the connected daemon's pid (from hello_ok),
    // so the tooltip shows which daemon this window is bound to.
    getDaemonPid: () => ipcClient?.getDaemonPid() ?? null,
    // T-P2-008: current approval mode for the registered workspace.
    getCurrentMode: () => registration?.getCurrentMode() ?? "per_call",
    // T-P2-008.8: retry count surfaced during the registering window.
    getRetryCount: () => registration?.getRetryCount() ?? 0,
    // T-P3-003: the OAuth client this workspace is bound to (set by the
    // binding_established handler below). null until bound.
    getBinding: () => currentBinding,
  };
  const statusBar = makeStatusBar(statusBarSources);
  statusBar.refresh();
  context.subscriptions.push({ dispose: () => statusBar.dispose() });

  // T-P2-008.8: tee IpcClient state into both the status bar (refresh) and
  // registration (event-driven re-attempt on connect). Closes C-29.
  ipcClient.onStateChange = (s): void => {
    statusBar.refresh();
    registration?.onConnectionStateChanged(s);
  };
  registration.onStateChange = () => statusBar.refresh();
  registration.onRetryCountChange = () => statusBar.refresh();

  // T-P2-008: wire the approval-modal handler so daemon-initiated
  // approval_request messages surface as a modal in VS Code.
  ipcClient.onApprovalRequest = makeApprovalHandler(ipcClient);

  // T-P3-003: wire the OAuth consent handlers. The named modal binds THIS
  // window's workspace; the resolved handler dismisses stale sibling modals.
  const consentHandlers = makeConsentHandlers(ipcClient, {
    getCodebaseName: () =>
      vscode.workspace.workspaceFolders?.[0]?.name ?? "(unknown workspace)",
  });
  ipcClient.onAuthConsentRequest = consentHandlers.onAuthConsentRequest;
  ipcClient.onAuthConsentResolved = consentHandlers.onAuthConsentResolved;
  ipcClient.onAuthConsentTimeout = consentHandlers.onAuthConsentTimeout;
  // T-P3-003: when the daemon confirms this window won the binding, record
  // it and refresh the status bar so the bound client is inspectable.
  ipcClient.onBindingEstablished = (msg): void => {
    currentBinding = {
      client_id: msg.client_id,
      client_name: msg.client_name,
    };
    statusBar.refresh();
  };
  // T-P3-004b: on unbind/revoke, the daemon clears this window's binding.
  ipcClient.onBindingCleared = (): void => {
    currentBinding = null;
    statusBar.refresh();
  };

  // T-P2-009 / T-P2-010: wire the inspection-tool handlers. Both are
  // read-only and bypass the approval gate — daemon never invokes the
  // gate on these tools' call paths.
  ipcClient.onGetOpenEditorsRequest = makeGetOpenEditorsHandler(ipcClient);
  ipcClient.onGetDiagnosticsRequest = makeGetDiagnosticsHandler(ipcClient);

  const statusBarMenuHandler = makeStatusBarMenu(statusBarSources, context, {
    // T-P2-008: applyMode sends set_workspace_mode via IPC; on success
    // updates the registration's local currentMode and refreshes the
    // status bar so the menu's next open reflects the new value.
    applyMode: async (identifier, mode) => {
      const client = ipcClient;
      const reg = registration;
      if (client === null || reg === null) {
        throw new Error("ipc client or registration not initialized");
      }
      const response = await client.request<{
        kind?: string;
        message?: string;
      }>({
        kind: "set_workspace_mode",
        identifier,
        mode,
      });
      if (response.kind !== "set_workspace_mode_ok") {
        throw new Error(response.message ?? "set_workspace_mode failed");
      }
      reg.setCurrentMode(mode);
      statusBar.refresh();
    },
    // T-P3-004b: unbind sends unbind_workspace via IPC; the daemon's
    // binding_cleared signal clears currentBinding (handler above), and the
    // ok reply returns the revoked-token count for the confirmation toast.
    unbind: async (identifier) => {
      const client = ipcClient;
      if (client === null) {
        throw new Error("ipc client not initialized");
      }
      const response = await client.request<{
        kind?: string;
        revoked_count?: number;
        message?: string;
      }>({
        kind: "unbind_workspace",
        identifier,
      });
      if (response.kind !== "unbind_workspace_ok") {
        throw new Error(response.message ?? "unbind failed");
      }
      return response.revoked_count ?? 0;
    },
  });
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

  // T-P3'-0 (SPIKE): ground-truth path probe. Logs workspaceFolders[0].uri
  // fsPath/path/toString verbatim so the daemon's canonicalizeWorkspacePath
  // can be calibrated against VS Code's real output. No production wiring.
  const probeCmd = vscode.commands.registerCommand(
    "claudeBridge.probeWorkspacePath",
    makeWorkspacePathProbe(context),
  );
  context.subscriptions.push(probeCmd);

  context.subscriptions.push({
    dispose: () => {
      // Best-effort deregister; don't block dispose on the response.
      void registration?.deregister();
      registration = null;
      ipcClient?.disconnect();
      ipcClient = null;
    },
  });
  diag("activate: complete");
}

export function deactivate(): void {
  // Subscriptions registered on context are auto-disposed by VS Code.
}

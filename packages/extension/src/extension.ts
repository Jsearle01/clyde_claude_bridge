import * as vscode from "vscode";
import { IpcClient, discoverDaemonEndpoint } from "./ipc/client.js";
import { WorkspaceRegistration } from "./registration.js";
import { runStartDaemonCommand } from "./daemon-lifecycle.js";
import {
  makeStatusBar,
  type StatusBarSources,
  type BindingInfo,
} from "./status-bar.js";
import { makeStatusBarMenu, type MenuSources } from "./status-bar-menu.js";
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
  // re-targets the client via setEndpoint() before connecting. No eager connect.
  ipcClient = new IpcClient(discoverDaemonEndpoint());

  // P3′-3 status state: the paired daemon's advert name (set on a discovery
  // match), the latest discovery-scan total (adverts present — drives the
  // "no daemon" vs "workspace mismatch" bar states), and the claude.ai binding.
  let pairedDaemonName: string | null = null;
  let discoveryTotal = 0;
  let currentBinding: BindingInfo | null = null;

  registration = new WorkspaceRegistration(
    ipcClient,
    vscode.workspace.workspaceFolders?.[0],
  );
  void registration.register();

  // P3′-3: two-segment status bar. Sources also satisfy MenuSources (the menu
  // reads the identifier + binding for Unbind). The obsolete manual-wiring
  // surfaces (daemon-select / trust-register / retry / mode) are gone.
  const statusBarSources: StatusBarSources & MenuSources = {
    getConnectionState: () => ipcClient?.getConnectionState() ?? "disconnected",
    getWorkspaceFolder: () => vscode.workspace.workspaceFolders?.[0],
    getPairedDaemonName: () => pairedDaemonName,
    getDaemonPid: () => ipcClient?.getDaemonPid() ?? null,
    getDiscoveryTotal: () => discoveryTotal,
    getBinding: () => currentBinding,
    getRegistrationIdentifier: () => registration?.getIdentifier() ?? null,
  };
  const statusBar = makeStatusBar(statusBarSources);
  statusBar.refresh();
  context.subscriptions.push({ dispose: () => statusBar.dispose() });

  ipcClient.onStateChange = (s): void => {
    statusBar.refresh();
    registration?.onConnectionStateChanged(s);
  };
  registration.onStateChange = () => statusBar.refresh();

  // P3′-2b/3: discover this workspace's daemon + auto-pair, and feed the status
  // bar. Compute the case-folded identity from workspaceFolders[0].uri.fsPath
  // (same key the daemon wrote into the advert's canonical_workspace); the
  // poller scans daemons/ continuously — onScan keeps discoveryTotal truthful
  // (so a dead daemon flips the bar to "not running"), onMatch connects ONCE.
  // Works daemon-first OR window-first. Multi-root → pair on [0] + a notice.
  const folders = vscode.workspace.workspaceFolders;
  const pairFolder = folders?.[0];
  if (pairFolder !== undefined) {
    if (folders !== undefined && folders.length > 1) {
      void vscode.window.showInformationMessage(
        `Claude Bridge: multi-root workspace detected; pairing on the first folder: ${pairFolder.name}`,
      );
    }
    const identity = computeWorkspaceIdentity(pairFolder.uri.fsPath);
    diag("discovery: starting pairing", { identity, daemonsDir: getDaemonsDir() });
    const pairing = startPairing({
      daemonsDir: getDaemonsDir(),
      identity,
      onScan: (result) => {
        discoveryTotal = result.total;
        statusBar.refresh();
      },
      onMatch: (advert) => {
        pairedDaemonName = advert.name;
        ipcClient?.setEndpoint(advert.pipe);
        ipcClient?.connect().catch((err: unknown) => {
          diag("discovery: connect failed (stale advert / daemon down)", {
            error: String(err),
          });
        });
      },
    });
    context.subscriptions.push({ dispose: () => pairing.dispose() });
  }

  // P3′-3: the spawn affordance command (rebuilt from the obsolete start) —
  // derives --workspace/--name from the open folder; daemon then advertises and
  // discovery pairs. Invoked from the status-bar menu's "Start daemon".
  const startDaemonCmd = vscode.commands.registerCommand(
    "claudeBridge.startDaemon",
    () => runStartDaemonCommand(context),
  );
  context.subscriptions.push(startDaemonCmd);

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
      // P3′-5: the bind-time default (per_call); updated locally on set.
      granularity: msg.granularity,
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
    // P3′-5: Stop daemon — fire-and-forget {kind:"stop"} over the existing
    // socket → the daemon runs graceful shutdown() (it tears the connection
    // down as it stops, so no reply is awaited). The discovery/reconnect loop
    // reflects the daemon's absence in the status bar.
    stop: async () => {
      const client = ipcClient;
      if (client === null) {
        throw new Error("ipc client not initialized");
      }
      client.send({ kind: "stop" });
      return Promise.resolve();
    },
    // P3′-5: Set approval mode — sends set_granularity; on ok, tracks the new
    // ceiling locally so the menu reflects it next open.
    setGranularity: async (identifier, value) => {
      const client = ipcClient;
      if (client === null) {
        throw new Error("ipc client not initialized");
      }
      const response = await client.request<{
        kind?: string;
        granularity?: string;
        message?: string;
      }>({
        kind: "set_granularity",
        identifier,
        value,
      });
      if (response.kind !== "set_granularity_ok") {
        throw new Error(response.message ?? "set approval mode failed");
      }
      if (currentBinding !== null) {
        currentBinding = { ...currentBinding, granularity: value };
        statusBar.refresh();
      }
      return 1;
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

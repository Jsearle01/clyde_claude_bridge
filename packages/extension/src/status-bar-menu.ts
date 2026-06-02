// QuickPick menu invoked when the user clicks the status bar item.
// Items are state-dependent: Start Daemon when disconnected; Open Daemon URL
// + Copy Identifier when connected-and-registered; descriptive Stop-Daemon
// hint always shown when connected (Q3c locked: extension never spawns stop).
//
// Pure `composeMenuItems(sources)` builds the list; `makeStatusBarMenu`
// returns a command handler that opens the QuickPick and routes the
// selected action.

import * as vscode from "vscode";
import type { WorkspaceMode } from "@claude-bridge/shared";
import type { StatusBarSources, DaemonInfo } from "./status-bar.js";
import { runStartDaemonCommand } from "./daemon-lifecycle.js";
import { formatClientLabel } from "./oauth-consent.js";

export type MenuAction =
  | { kind: "show_status" }
  | { kind: "start_daemon" }
  | { kind: "stop_daemon_hint" }
  | { kind: "open_daemon_url"; url: string }
  | { kind: "copy_identifier"; identifier: string }
  | { kind: "info_only"; message: string }
  // T-P2-008: opens a secondary QuickPick to pick a new approval mode.
  | { kind: "change_approval_mode"; identifier: string; current_mode: WorkspaceMode }
  // T-P3-004b: unbind this workspace from its bound Claude.ai client.
  | { kind: "unbind_workspace"; identifier: string; client_label: string };

// T-P2-008: apply-mode adapter. The dispatch router calls this after
// the user selects a new mode in the secondary QuickPick. Implementation
// in extension.ts wires ipcClient.request + registration.setCurrentMode.
export type ApplyMode = (
  identifier: string,
  mode: WorkspaceMode,
) => Promise<void>;

// T-P3-004b: unbind adapter — sends unbind_workspace via IPC and returns
// the count of tokens revoked. Wired in extension.ts.
export type Unbind = (identifier: string) => Promise<number>;

export interface MenuItem {
  label: string;
  description?: string;
  action: MenuAction;
}

export interface StatusBarMenuDeps {
  showQuickPick?: typeof vscode.window.showQuickPick;
  showInformationMessage?: typeof vscode.window.showInformationMessage;
  showErrorMessage?: typeof vscode.window.showErrorMessage;
  executeCommand?: typeof vscode.commands.executeCommand;
  clipboardWriteText?: (s: string) => PromiseLike<void>;
  runStartDaemon?: (
    context: vscode.ExtensionContext,
  ) => Promise<void>;
  // T-P2-008: callback used by the change_approval_mode action to send
  // set_workspace_mode via IPC and apply the new mode locally on success.
  applyMode?: ApplyMode;
  // T-P3-004b: callback used by the unbind_workspace action.
  unbind?: Unbind;
  // T-P3-004b: modal confirm for the (destructive) unbind action.
  showWarningMessage?: typeof vscode.window.showWarningMessage;
}

const STOP_HINT_TEXT =
  "Run `claude-bridge stop` in a terminal to stop the daemon.";
const TRUST_DENIED_HINT =
  "Trust was denied. Restart VS Code to re-prompt for trust.";
const DUPLICATE_HINT_PREFIX =
  "Another VS Code window holds this workspace registration";

export function composeMenuItems(sources: StatusBarSources): MenuItem[] {
  const items: MenuItem[] = [];
  const conn = sources.getConnectionState();
  const reg = sources.getRegistrationState();
  const identifier = sources.getRegistrationIdentifier();
  const existingPid = sources.getRegistrationExistingPid();
  const daemonInfo = sources.getDaemonInfo();

  // "Show Status" is always available.
  items.push({
    label: "$(info) Show Status",
    description: "Open the full status notification",
    action: { kind: "show_status" },
  });

  if (conn === "connected") {
    if (daemonInfo !== undefined) {
      items.push({
        label: "$(link-external) Open Daemon URL",
        description: daemonInfo.url,
        action: { kind: "open_daemon_url", url: daemonInfo.url },
      });
    }
    if (reg === "registered" && identifier !== null) {
      items.push({
        label: "$(clippy) Copy Identifier",
        description: identifier,
        action: { kind: "copy_identifier", identifier },
      });
      // T-P2-008: Change approval mode (only when registered, so the
      // daemon can ack set_workspace_mode against the active identifier).
      const currentMode = sources.getCurrentMode();
      items.push({
        label: "$(gear) Change approval mode",
        description: `Current: ${currentMode}`,
        action: {
          kind: "change_approval_mode",
          identifier,
          current_mode: currentMode,
        },
      });
      // T-P3-004b: Unbind — only when this workspace is bound to a client.
      const binding = sources.getBinding?.() ?? null;
      if (binding !== null) {
        const clientLabel = formatClientLabel(
          binding.client_id,
          binding.client_name,
        );
        items.push({
          label: "$(debug-disconnect) Unbind workspace",
          description: `Bound to ${clientLabel}`,
          action: {
            kind: "unbind_workspace",
            identifier,
            client_label: clientLabel,
          },
        });
      }
    }
    // Stop hint (descriptive — no spawn).
    items.push({
      label: "$(debug-stop) Stop Daemon...",
      description: STOP_HINT_TEXT,
      action: { kind: "stop_daemon_hint" },
    });
  } else if (conn === "disconnected") {
    items.push({
      label: "$(play) Start Daemon",
      description: "Spawn the daemon (and prompt for API key if needed)",
      action: { kind: "start_daemon" },
    });
  }
  // No actions for "connecting" or "version_mismatch" beyond Show Status.

  if (reg === "trust_denied") {
    items.push({
      label: "$(warning) Trust denied",
      description: TRUST_DENIED_HINT,
      action: { kind: "info_only", message: TRUST_DENIED_HINT },
    });
  }
  if (reg === "duplicate") {
    const msg = `${DUPLICATE_HINT_PREFIX}${existingPid !== null ? ` (pid ${existingPid})` : ""}. Only one window can drive a workspace at a time.`;
    items.push({
      label: "$(warning) Path conflict",
      description: msg,
      action: { kind: "info_only", message: msg },
    });
  }
  return items;
}

export function makeStatusBarMenu(
  sources: StatusBarSources,
  context: vscode.ExtensionContext,
  deps: StatusBarMenuDeps = {},
): () => Promise<void> {
  const showQuickPick = deps.showQuickPick ?? vscode.window.showQuickPick;
  const showInfo =
    deps.showInformationMessage ?? vscode.window.showInformationMessage;
  const showError =
    deps.showErrorMessage ?? vscode.window.showErrorMessage;
  const executeCommand = deps.executeCommand ?? vscode.commands.executeCommand;
  const clipboardWriteText =
    deps.clipboardWriteText ??
    ((s: string): PromiseLike<void> => vscode.env.clipboard.writeText(s));
  const runStart = deps.runStartDaemon ?? runStartDaemonCommand;
  const applyMode = deps.applyMode;
  const unbind = deps.unbind;
  const showWarning =
    deps.showWarningMessage ?? vscode.window.showWarningMessage;
  return async (): Promise<void> => {
    const items = composeMenuItems(sources);
    const selected = await showQuickPick(items);
    if (selected === undefined) return;
    await dispatchAction(selected.action, {
      context,
      runStart,
      executeCommand,
      clipboardWriteText,
      showInfo,
      showError,
      showQuickPick,
      showWarning,
      applyMode,
      unbind,
    });
  };
}

interface DispatchDeps {
  context: vscode.ExtensionContext;
  runStart: (context: vscode.ExtensionContext) => Promise<void>;
  executeCommand: typeof vscode.commands.executeCommand;
  clipboardWriteText: (s: string) => PromiseLike<void>;
  showInfo: typeof vscode.window.showInformationMessage;
  showError: typeof vscode.window.showErrorMessage;
  showQuickPick: typeof vscode.window.showQuickPick;
  showWarning: typeof vscode.window.showWarningMessage;
  applyMode: ApplyMode | undefined;
  unbind: Unbind | undefined;
}

interface ModeMenuItem extends vscode.QuickPickItem {
  mode: WorkspaceMode;
}

const MODE_PICK_ITEMS: ModeMenuItem[] = [
  { label: "Auto (no prompts)", mode: "auto" },
  { label: "Per call (default)", mode: "per_call" },
  { label: "Session bypass", mode: "session_bypass" },
];

async function dispatchAction(
  action: MenuAction,
  deps: DispatchDeps,
): Promise<void> {
  switch (action.kind) {
    case "show_status":
      await deps.executeCommand("claudeBridge.showStatus");
      return;
    case "start_daemon":
      await deps.runStart(deps.context);
      return;
    case "stop_daemon_hint":
      await deps.showInfo(STOP_HINT_TEXT);
      return;
    case "open_daemon_url":
      await deps.executeCommand("vscode.open", vscode.Uri.parse(action.url));
      return;
    case "copy_identifier":
      await deps.clipboardWriteText(action.identifier);
      await deps.showInfo(`Copied identifier: ${action.identifier}`);
      return;
    case "info_only":
      await deps.showInfo(action.message);
      return;
    case "change_approval_mode": {
      const selected = await deps.showQuickPick(MODE_PICK_ITEMS);
      if (selected === undefined) return;
      if (selected.mode === action.current_mode) {
        await deps.showInfo(`Mode already ${selected.mode}.`);
        return;
      }
      if (deps.applyMode === undefined) {
        await deps.showError("applyMode dep not wired (test harness?)");
        return;
      }
      try {
        await deps.applyMode(action.identifier, selected.mode);
        await deps.showInfo(`Approval mode set to ${selected.mode}.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await deps.showError(`Failed to change mode: ${msg}`);
      }
      return;
    }
    case "unbind_workspace": {
      const confirm = await deps.showWarning(
        `Unbind this workspace from ${action.client_label}? ` +
          `That client will no longer be able to act on this workspace until it re-binds.`,
        { modal: true },
        "Unbind",
      );
      if (confirm !== "Unbind") return; // dismissed / cancelled
      if (deps.unbind === undefined) {
        await deps.showError("unbind dep not wired (test harness?)");
        return;
      }
      try {
        const revoked = await deps.unbind(action.identifier);
        await deps.showInfo(
          `Workspace unbound from ${action.client_label} (${revoked} token${revoked === 1 ? "" : "s"} revoked).`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await deps.showError(`Failed to unbind: ${msg}`);
      }
      return;
    }
  }
}

// Re-export for tests that need to verify the hint text values verbatim.
export { STOP_HINT_TEXT, TRUST_DENIED_HINT, DUPLICATE_HINT_PREFIX };

// Touch DaemonInfo so the import is load-bearing in compiled output.
export type _DaemonInfoReExport = DaemonInfo;

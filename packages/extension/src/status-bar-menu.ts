// QuickPick menu invoked when the user clicks the status bar item.
// Items are state-dependent: Start Daemon when disconnected; Open Daemon URL
// + Copy Identifier when connected-and-registered; descriptive Stop-Daemon
// hint always shown when connected (Q3c locked: extension never spawns stop).
//
// Pure `composeMenuItems(sources)` builds the list; `makeStatusBarMenu`
// returns a command handler that opens the QuickPick and routes the
// selected action.

import * as vscode from "vscode";
import type { StatusBarSources, DaemonInfo } from "./status-bar.js";
import { runStartDaemonCommand } from "./daemon-lifecycle.js";

export type MenuAction =
  | { kind: "show_status" }
  | { kind: "start_daemon" }
  | { kind: "stop_daemon_hint" }
  | { kind: "open_daemon_url"; url: string }
  | { kind: "copy_identifier"; identifier: string }
  | { kind: "info_only"; message: string };

export interface MenuItem {
  label: string;
  description?: string;
  action: MenuAction;
}

export interface StatusBarMenuDeps {
  showQuickPick?: typeof vscode.window.showQuickPick;
  showInformationMessage?: typeof vscode.window.showInformationMessage;
  executeCommand?: typeof vscode.commands.executeCommand;
  clipboardWriteText?: (s: string) => PromiseLike<void>;
  runStartDaemon?: (
    context: vscode.ExtensionContext,
  ) => Promise<void>;
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
  const executeCommand = deps.executeCommand ?? vscode.commands.executeCommand;
  const clipboardWriteText =
    deps.clipboardWriteText ??
    ((s: string): PromiseLike<void> => vscode.env.clipboard.writeText(s));
  const runStart = deps.runStartDaemon ?? runStartDaemonCommand;
  return async (): Promise<void> => {
    const items = composeMenuItems(sources);
    const selected = (await showQuickPick(items)) as MenuItem | undefined;
    if (selected === undefined) return;
    await dispatchAction(selected.action, {
      context,
      runStart,
      executeCommand,
      clipboardWriteText,
      showInfo,
    });
  };
}

interface DispatchDeps {
  context: vscode.ExtensionContext;
  runStart: (context: vscode.ExtensionContext) => Promise<void>;
  executeCommand: typeof vscode.commands.executeCommand;
  clipboardWriteText: (s: string) => PromiseLike<void>;
  showInfo: typeof vscode.window.showInformationMessage;
}

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
  }
}

// Re-export for tests that need to verify the hint text values verbatim.
export { STOP_HINT_TEXT, TRUST_DENIED_HINT, DUPLICATE_HINT_PREFIX };

// Touch DaemonInfo so the import is load-bearing in compiled output.
export type _DaemonInfoReExport = DaemonInfo;

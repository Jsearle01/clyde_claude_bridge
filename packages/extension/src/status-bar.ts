// Status bar item composing IpcClient connection state + WorkspaceRegistration
// state into a single right-aligned indicator. Subscribes to onStateChange
// callbacks from both sources via the extension wiring (callers do
// `ipcClient.onStateChange = () => statusBar.refresh()` etc.); this module
// provides the StatusBarItem factory + pure render helpers.
//
// Decision 6 (T-P2-006): icon mapping is state-driven; see composeStatusBarText
// for the connection × registration cross-product table.

import * as vscode from "vscode";
import type { WorkspaceMode } from "@claude-bridge/shared";
import type { ConnectionStateKind } from "./ipc/client.js";
import type { RegistrationState } from "./registration.js";

export interface DaemonInfo {
  pid: number;
  url: string;
  uptime_s: number;
}

export interface StatusBarSources {
  getConnectionState(): ConnectionStateKind;
  getRegistrationState(): RegistrationState;
  getRegistrationIdentifier(): string | null;
  getRegistrationExistingPid(): number | null;
  getWorkspaceFolder(): vscode.WorkspaceFolder | undefined;
  // For tooltip: optional getters that may not always have data.
  // T-P2-006 stubs return undefined; T-P2-007+ may wire actual daemon
  // info via IPC.
  getDaemonInfo(): DaemonInfo | undefined;
  // T-P2-008: current approval mode for the registered workspace.
  // Status-bar menu reads this to display "Change approval mode (current:
  // X)". Returns "per_call" default when no workspace registered.
  getCurrentMode(): WorkspaceMode;
}

export interface StatusBarDeps {
  createStatusBarItem?: typeof vscode.window.createStatusBarItem;
  alignment?: vscode.StatusBarAlignment;
  priority?: number;
}

export interface StatusBarHandle {
  item: vscode.StatusBarItem;
  refresh(): void;
  dispose(): void;
}

const MENU_COMMAND_ID = "claudeBridge.openStatusBarMenu";

export function makeStatusBar(
  sources: StatusBarSources,
  deps: StatusBarDeps = {},
): StatusBarHandle {
  const createItem = deps.createStatusBarItem ?? vscode.window.createStatusBarItem;
  const alignment = deps.alignment ?? vscode.StatusBarAlignment.Right;
  const priority = deps.priority ?? 100;
  const item = createItem(alignment, priority);
  item.command = MENU_COMMAND_ID;
  const refresh = (): void => {
    const folder = sources.getWorkspaceFolder();
    if (folder === undefined) {
      // Hide entirely when no workspace folder is open (Decision 6 final row).
      item.hide();
      return;
    }
    item.text = composeStatusBarText(
      sources.getConnectionState(),
      sources.getRegistrationState(),
      sources.getRegistrationIdentifier(),
      sources.getRegistrationExistingPid(),
    );
    item.tooltip = composeStatusBarTooltip(sources);
    item.show();
  };
  return {
    item,
    refresh,
    dispose: () => {
      item.dispose();
    },
  };
}

// Pure helper, exported for unit testing. Cross-product table per Decision 6.
export function composeStatusBarText(
  conn: ConnectionStateKind,
  reg: RegistrationState,
  identifier: string | null,
  existingPid: number | null,
): string {
  if (conn === "version_mismatch") return "$(alert) version mismatch";
  if (conn === "disconnected") return "$(circle-slash) daemon down";
  if (conn === "connecting") return "$(sync~spin) connecting";
  // conn === "connected"
  // (no-workspace case is handled upstream in makeStatusBar.refresh by
  // hiding the item entirely, so it cannot reach this point.)
  if (reg === "registered") {
    return `$(plug) ${identifier ?? "(no identifier)"}`;
  }
  if (reg === "trust_denied") return "$(warning) (trust denied)";
  if (reg === "duplicate") {
    return `$(warning) (path conflict${existingPid !== null ? `, pid ${existingPid}` : ""})`;
  }
  if (reg === "needs_trust") return "$(question) (trust pending)";
  if (reg === "registering") return "$(question) (registering)";
  // reg === "unregistered" (transient initial state)
  return "$(question) (registering)";
}

// Pure helper, exported for unit testing. Builds a MarkdownString with
// structured content. Sections shown depend on state availability.
export function composeStatusBarTooltip(
  sources: StatusBarSources,
): vscode.MarkdownString {
  const folder = sources.getWorkspaceFolder();
  const conn = sources.getConnectionState();
  const reg = sources.getRegistrationState();
  const identifier = sources.getRegistrationIdentifier();
  const existingPid = sources.getRegistrationExistingPid();
  const daemonInfo = sources.getDaemonInfo();

  const md = new vscode.MarkdownString();
  if (folder !== undefined) {
    md.appendMarkdown(`**Workspace:** ${folder.uri.fsPath}\n\n`);
  }
  if (identifier !== null) {
    md.appendMarkdown(`**Identifier:** ${identifier}\n\n`);
  }
  md.appendMarkdown(`**Trust:** ${trustLabel(reg)}\n\n`);
  md.appendMarkdown(`**Daemon:** ${daemonLabel(conn, daemonInfo)}\n\n`);
  if (daemonInfo !== undefined && conn === "connected") {
    md.appendMarkdown(`**URL:** ${daemonInfo.url}\n\n`);
  }
  if (reg === "duplicate" && existingPid !== null) {
    md.appendMarkdown(`**Conflicting window pid:** ${existingPid}\n\n`);
  }
  md.appendMarkdown("Click for actions.");
  return md;
}

function trustLabel(reg: RegistrationState): string {
  switch (reg) {
    case "registered":
      return "trusted";
    case "trust_denied":
      return "denied";
    case "needs_trust":
      return "pending";
    case "duplicate":
      return "path conflict (other window holds registration)";
    case "registering":
    case "unregistered":
      return "not yet registered";
  }
}

function daemonLabel(
  conn: ConnectionStateKind,
  info: DaemonInfo | undefined,
): string {
  switch (conn) {
    case "connected":
      return info !== undefined ? `connected (pid ${info.pid})` : "connected";
    case "connecting":
      return "connecting...";
    case "disconnected":
      return "not running";
    case "version_mismatch":
      return "version mismatch";
  }
}

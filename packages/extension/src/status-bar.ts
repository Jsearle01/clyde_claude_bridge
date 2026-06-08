// Two-segment status bar (P3′-3). One right-aligned item, two parts:
//   [daemon: <state>]  <-->  [claude.ai: <state>]
// The two parts are INDEPENDENT connections — extension↔daemon (local pipe) and
// daemon↔claude.ai (OAuth/tunnel) — so a user debugging "why can't claude.ai
// reach my workspace" can see which link is down. The tooltip carries NO status
// (state is inline); it only hints the item is clickable → opens the command
// menu (re-scan / unbind / spawn).
//
// Daemon-segment states reflect HANDSHAKE REALITY — there is no "stale" or
// "waiting/appears-later" UI state (P3′-3 scope b). A paired daemon is always
// live; polling transitions silently to `live`.

import * as vscode from "vscode";
import type { ConnectionStateKind } from "./ipc/client.js";
import { formatClientLabel } from "./oauth-consent.js";

// T-P3-003: the OAuth client this window's workspace is bound to (set when the
// daemon sends binding_established). null = no binding yet.
export interface BindingInfo {
  client_id: string;
  client_name: string;
}

export interface StatusBarSources {
  getConnectionState(): ConnectionStateKind;
  getWorkspaceFolder(): vscode.WorkspaceFolder | undefined;
  // P3′-3: the paired daemon's advert name (set on a discovery match), or null.
  getPairedDaemonName(): string | null;
  // The live daemon pid from the hello_ok handshake (always current), or null.
  getDaemonPid(): number | null;
  // P3′-3: total parseable adverts seen in the last discovery scan — drives the
  // "daemon not running" (0) vs "no matching daemon found" (>0) distinction.
  getDiscoveryTotal(): number;
  // The claude.ai OAuth binding for this workspace, or null if not bound.
  getBinding(): BindingInfo | null;
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
const TOOLTIP_TEXT = "Claude Bridge — click for commands";

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
      item.hide(); // no workspace folder open → nothing to pair
      return;
    }
    item.text = composeStatusBarText(sources);
    item.tooltip = TOOLTIP_TEXT;
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

// Pure render, exported for unit testing. Produces the two-segment text.
export function composeStatusBarText(sources: StatusBarSources): string {
  return `${daemonSegment(sources)} $(arrow-both) ${claudeSegment(sources)}`;
}

// Daemon segment (P3′-3 scope b — handshake reality, no stale/waiting state).
export function daemonSegment(sources: StatusBarSources): string {
  const conn = sources.getConnectionState();
  if (conn === "connected") {
    const name = sources.getPairedDaemonName() ?? "daemon";
    const pid = sources.getDaemonPid();
    const pidPart = pid !== null ? ` (pid ${pid})` : "";
    return `$(plug) ${name}${pidPart} · live`;
  }
  if (conn === "connecting") {
    return "$(sync~spin) daemon: connecting…";
  }
  if (conn === "version_mismatch") {
    return "$(alert) daemon: version mismatch";
  }
  // disconnected. P3′-3 addendum: fold the re-scan's diagnostic into the bar.
  // - adverts present but none byte-match this workspace → NEAR-MISS: the
  //   case-fold canary. A daemon IS running but its canonical_workspace doesn't
  //   match — exactly the failure the Phase-0 contract guards. Distinct string.
  // - no advert at all → actionable "start from command palette" (the spawn).
  if (sources.getDiscoveryTotal() > 0) {
    return "$(alert) daemon: found but workspace mismatch";
  }
  return "$(circle-slash) daemon: not running — start from command palette";
}

// claude.ai segment (P3′-3 scope c) — the daemon↔claude.ai OAuth binding,
// independent of the daemon segment above.
export function claudeSegment(sources: StatusBarSources): string {
  const binding = sources.getBinding();
  if (binding !== null) {
    return `claude.ai: bound (${formatClientLabel(binding.client_id, binding.client_name)})`;
  }
  return "claude.ai: not bound";
}

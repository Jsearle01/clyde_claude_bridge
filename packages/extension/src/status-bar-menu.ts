// Command menu opened by clicking the status-bar item (P3′-3, post-addendum).
// The menu is exactly two actions: **Start daemon** (the derived-args spawn
// affordance) and **Unbind** (when this workspace is bound to a claude.ai
// client). The manual-wiring options (daemon-select / trust-register / retry /
// mode) and the now-redundant re-scan are stripped — the 2b poller already
// pairs the moment a matching advert appears, and the near-miss diagnostic
// lives inline in the status bar.

import * as vscode from "vscode";
import type { OperationGranularity } from "@claude-bridge/shared";
import type { BindingInfo } from "./status-bar.js";
import { runStartDaemonCommand } from "./daemon-lifecycle.js";
import { formatClientLabel } from "./oauth-consent.js";

export type MenuAction =
  | { kind: "start_daemon" }
  | { kind: "stop_daemon" }
  | { kind: "set_granularity"; identifier: string; current: OperationGranularity }
  | { kind: "unbind_workspace"; identifier: string; client_label: string };

// T-P3-004b: unbind adapter — sends unbind_workspace via IPC and returns the
// count of tokens revoked. Wired in extension.ts.
export type Unbind = (identifier: string) => Promise<number>;

// P3′-5: stop adapter (sends {kind:"stop"} over the existing socket) + the
// approval-mode setter (sends set_granularity). Wired in extension.ts.
export type StopDaemon = () => Promise<void>;
export type SetGranularity = (
  identifier: string,
  value: OperationGranularity,
) => Promise<number>;

// P3′-5: human descriptions for the approval-mode pick. per_call is the most
// cautious ceiling, auto the most autonomous. The operator switch is a ceiling
// claude.ai can tighten under but never loosen past (the daemon clamps).
const GRANULARITY_DESC: Record<OperationGranularity, string> = {
  per_call: "Gate every tool call (most cautious)",
  task: "Gate once per task, then run to completion",
  auto: "No per-operation gate (most autonomous)",
};

export interface MenuItem {
  label: string;
  description?: string;
  action: MenuAction;
}

// The menu reads just the binding + identifier (the registration still runs;
// the status bar no longer displays the identifier, but unbind needs it).
export interface MenuSources {
  getRegistrationIdentifier(): string | null;
  getBinding(): BindingInfo | null;
}

export interface StatusBarMenuDeps {
  showQuickPick?: typeof vscode.window.showQuickPick;
  showInformationMessage?: typeof vscode.window.showInformationMessage;
  showErrorMessage?: typeof vscode.window.showErrorMessage;
  showWarningMessage?: typeof vscode.window.showWarningMessage;
  runStartDaemon?: (context: { secrets: vscode.SecretStorage }) => Promise<void>;
  unbind?: Unbind;
  stop?: StopDaemon;
  setGranularity?: SetGranularity;
}

export function composeMenuItems(sources: MenuSources): MenuItem[] {
  const items: MenuItem[] = [];
  // Start daemon — always available. When a daemon is already running for this
  // workspace, the 1c lock refuses the duplicate and discovery just pairs with
  // the incumbent (AC-3-9), so offering it unconditionally is safe + keeps the
  // escape hatch one click away.
  items.push({
    label: "$(play) Start daemon",
    description: "Spawn a daemon for this workspace (auto-pairs once advertising)",
    action: { kind: "start_daemon" },
  });

  // Stop daemon — always (P3′-5). Daemon-per-workspace makes the target
  // unambiguous (the paired daemon for THIS workspace); the one-daemon ambiguity
  // that excluded Stop is gone. Confirmed before sending (live-disruption).
  items.push({
    label: "$(stop-circle) Stop daemon",
    description: "Stop this workspace's daemon (disconnects claude.ai)",
    action: { kind: "stop_daemon" },
  });

  // When-bound items: Set approval mode + Unbind. Granularity lives on the
  // binding — with no binding there is no automation to govern.
  const identifier = sources.getRegistrationIdentifier();
  const binding = sources.getBinding();
  if (binding !== null && identifier !== null) {
    const clientLabel = formatClientLabel(binding.client_id, binding.client_name);
    // Set approval mode (P3′-5) — the per-workspace granularity ceiling.
    items.push({
      label: "$(shield) Set approval mode",
      description: `Current: ${binding.granularity}`,
      action: { kind: "set_granularity", identifier, current: binding.granularity },
    });
    items.push({
      label: "$(debug-disconnect) Unbind workspace",
      description: `Bound to ${clientLabel}`,
      action: { kind: "unbind_workspace", identifier, client_label: clientLabel },
    });
  }
  return items;
}

export function makeStatusBarMenu(
  sources: MenuSources,
  context: { secrets: vscode.SecretStorage },
  deps: StatusBarMenuDeps = {},
): () => Promise<void> {
  const showQuickPick = deps.showQuickPick ?? vscode.window.showQuickPick;
  const showInfo = deps.showInformationMessage ?? vscode.window.showInformationMessage;
  const showError = deps.showErrorMessage ?? vscode.window.showErrorMessage;
  const showWarning = deps.showWarningMessage ?? vscode.window.showWarningMessage;
  const runStart = deps.runStartDaemon ?? runStartDaemonCommand;
  const unbind = deps.unbind;
  const stop = deps.stop;
  const setGranularity = deps.setGranularity;
  return async (): Promise<void> => {
    const items = composeMenuItems(sources);
    const selected = await showQuickPick(items);
    if (selected === undefined) return;
    const action = selected.action;
    if (action.kind === "start_daemon") {
      await runStart(context);
      return;
    }
    if (action.kind === "stop_daemon") {
      const ws = sources.getRegistrationIdentifier() ?? "this workspace";
      const confirm = await showWarning(
        `Stop the daemon for ${ws}? This disconnects claude.ai from this workspace.`,
        { modal: true },
        "Stop",
      );
      if (confirm !== "Stop") return; // dismissed / cancelled
      if (stop === undefined) {
        await showError("stop dep not wired (test harness?)");
        return;
      }
      try {
        await stop();
        await showInfo("Stopping the daemon for this workspace.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await showError(`Failed to stop daemon: ${msg}`);
      }
      return;
    }
    if (action.kind === "set_granularity") {
      const picks: (vscode.QuickPickItem & { value: OperationGranularity })[] = (
        ["per_call", "task", "auto"] as OperationGranularity[]
      ).map((g) => ({
        label: g === action.current ? `$(check) ${g}` : g,
        description:
          GRANULARITY_DESC[g] + (g === action.current ? " — current" : ""),
        value: g,
      }));
      const picked = await showQuickPick(picks, {
        placeHolder: `Approval mode for this workspace (current: ${action.current})`,
      });
      if (picked === undefined) return; // dismissed
      const value = picked.value;
      if (setGranularity === undefined) {
        await showError("set-granularity dep not wired (test harness?)");
        return;
      }
      try {
        await setGranularity(action.identifier, value);
        await showInfo(`Approval mode set to ${value}.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await showError(`Failed to set approval mode: ${msg}`);
      }
      return;
    }
    // unbind_workspace
    const confirm = await showWarning(
      `Unbind this workspace from ${action.client_label}? ` +
        `That client will no longer be able to act on this workspace until it re-binds.`,
      { modal: true },
      "Unbind",
    );
    if (confirm !== "Unbind") return; // dismissed / cancelled
    if (unbind === undefined) {
      await showError("unbind dep not wired (test harness?)");
      return;
    }
    try {
      const revoked = await unbind(action.identifier);
      await showInfo(
        `Workspace unbound from ${action.client_label} ` +
          `(${revoked} token${revoked === 1 ? "" : "s"} revoked).`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await showError(`Failed to unbind: ${msg}`);
    }
  };
}

// Command menu opened by clicking the status-bar item (P3′-3, post-addendum).
// The menu is exactly two actions: **Start daemon** (the derived-args spawn
// affordance) and **Unbind** (when this workspace is bound to a claude.ai
// client). The manual-wiring options (daemon-select / trust-register / retry /
// mode) and the now-redundant re-scan are stripped — the 2b poller already
// pairs the moment a matching advert appears, and the near-miss diagnostic
// lives inline in the status bar.

import * as vscode from "vscode";
import type { BindingInfo } from "./status-bar.js";
import { runStartDaemonCommand } from "./daemon-lifecycle.js";
import { formatClientLabel } from "./oauth-consent.js";

export type MenuAction =
  | { kind: "start_daemon" }
  | { kind: "unbind_workspace"; identifier: string; client_label: string };

// T-P3-004b: unbind adapter — sends unbind_workspace via IPC and returns the
// count of tokens revoked. Wired in extension.ts.
export type Unbind = (identifier: string) => Promise<number>;

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

  // Unbind — only when this workspace is bound to a claude.ai client.
  const identifier = sources.getRegistrationIdentifier();
  const binding = sources.getBinding();
  if (binding !== null && identifier !== null) {
    const clientLabel = formatClientLabel(binding.client_id, binding.client_name);
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
  return async (): Promise<void> => {
    const items = composeMenuItems(sources);
    const selected = await showQuickPick(items);
    if (selected === undefined) return;
    const action = selected.action;
    if (action.kind === "start_daemon") {
      await runStart(context);
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

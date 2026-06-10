// T-TUNNEL-1 (B): the tunnel-drop recovery modal (extension side). Parallels
// oauth-consent.ts but simpler (no ack; one request → modal → confirm/deny).
// The daemon sends tunnel_drop_request when a quick-tunnel dropped and respawned
// to a NEW url that must NOT be silently adopted — the operator decides whether
// to adopt it (and re-point their claude.ai connector) or disconnect.
//
// Dismiss (Esc / focus loss) is NOT a decision — the daemon keeps the drop
// pending (visible in CLI `status`, re-fired on next connect), so a stray
// dismiss never adopts or tears down. Only an explicit Adopt/Disconnect responds.

import * as vscode from "vscode";
import type { TunnelDropRequest } from "@claude-bridge/shared";
import type { IpcClient } from "./ipc/client.js";

const BTN_ADOPT = "Adopt new URL";
const BTN_DENY = "Disconnect";

/** The drop-modal copy. Exported for unit testing. */
export function composeTunnelDropModalText(req: TunnelDropRequest): string {
  return [
    "Claude Bridge: the tunnel dropped and a new URL was created.",
    "",
    `New URL: ${req.new_url}`,
    "",
    `Adopt the new URL? You'll need to re-point your claude.ai connector to it. ` +
      `Choosing Disconnect tears the tunnel down until you restart it.`,
  ].join("\n");
}

export interface TunnelDropDeps {
  showWarningMessage?: typeof vscode.window.showWarningMessage;
}

export function makeTunnelDropHandler(
  ipcClient: IpcClient,
  deps: TunnelDropDeps = {},
): (req: TunnelDropRequest) => Promise<void> {
  const showWarning =
    deps.showWarningMessage ?? vscode.window.showWarningMessage;
  return async (req: TunnelDropRequest): Promise<void> => {
    const choice = await showWarning(
      composeTunnelDropModalText(req),
      { modal: true },
      BTN_ADOPT,
      BTN_DENY,
    );
    // Dismiss → no decision; the daemon keeps it pending (CLI status + next
    // connect). Only an explicit choice responds.
    if (choice !== BTN_ADOPT && choice !== BTN_DENY) return;
    const decision: "confirm" | "deny" =
      choice === BTN_ADOPT ? "confirm" : "deny";
    try {
      ipcClient.send({
        kind: "tunnel_drop_response",
        request_id: req.request_id,
        decision,
      });
    } catch {
      // Socket closed before we could respond — the daemon keeps the drop
      // pending and re-fires on the next connect.
    }
  };
}

export { BTN_ADOPT, BTN_DENY };

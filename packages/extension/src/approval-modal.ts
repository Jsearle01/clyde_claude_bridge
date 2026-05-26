// T-P2-008: approval modal UX. Receives daemon-initiated approval_request
// via IpcClient.onApprovalRequest, surfaces a modal warningMessage with
// three buttons (Approve / Approve for this session / Deny), maps button
// to decision, sends approval_response back over IPC.
//
// Modal dismissal (undefined return) defaults to "deny" per Q6 design.

import * as vscode from "vscode";
import type { ApprovalRequest } from "@claude-bridge/shared";
import type { IpcClient } from "./ipc/client.js";

export interface ApprovalModalDeps {
  showWarningMessage?: typeof vscode.window.showWarningMessage;
}

const BTN_APPROVE = "Approve";
const BTN_APPROVE_SESSION = "Approve for this session";
const BTN_DENY = "Deny";

export function composeModalText(request: ApprovalRequest): string {
  const lines: string[] = [];
  lines.push(`Claude wants to delegate to ${request.identifier}`);
  lines.push(`Mode: ${request.mode_requested}`);
  if (request.estimated_size !== undefined) {
    const { exhibits_count, total_inline_bytes } = request.estimated_size;
    if (exhibits_count > 0 || total_inline_bytes > 0) {
      const kb = (total_inline_bytes / 1024).toFixed(1);
      lines.push(`${exhibits_count} exhibits, ${kb} KB inline`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("Prompt:");
  lines.push(request.prompt);
  // The truncation indicator: the daemon caller already replaces the tail
  // with "…" if it truncated. Distinguish here by trailing ellipsis.
  if (request.prompt.endsWith("…")) {
    lines.push("(prompt truncated; full text in daemon audit log)");
  }
  lines.push("---");
  return lines.join("\n");
}

export function makeApprovalHandler(
  ipcClient: IpcClient,
  deps: ApprovalModalDeps = {},
): (request: ApprovalRequest) => Promise<void> {
  const showWarning = deps.showWarningMessage ?? vscode.window.showWarningMessage;
  return async (request: ApprovalRequest): Promise<void> => {
    const text = composeModalText(request);
    const choice = await showWarning(
      text,
      { modal: true },
      BTN_APPROVE,
      BTN_APPROVE_SESSION,
      BTN_DENY,
    );
    let decision: "approve" | "deny" | "approve_session";
    if (choice === BTN_APPROVE) {
      decision = "approve";
    } else if (choice === BTN_APPROVE_SESSION) {
      decision = "approve_session";
    } else {
      // Includes BTN_DENY explicitly and any dismissal (undefined).
      decision = "deny";
    }
    try {
      ipcClient.send({
        kind: "approval_response",
        delegation_id: request.delegation_id,
        decision,
      });
    } catch {
      // Socket closed between modal-open and response. Daemon's
      // disconnect handler will cancel the pending approval; nothing
      // more for us to do.
    }
  };
}

// Re-export the button labels for tests that need to assert verbatim.
export { BTN_APPROVE, BTN_APPROVE_SESSION, BTN_DENY };

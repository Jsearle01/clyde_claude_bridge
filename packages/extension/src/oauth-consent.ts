// T-P3-003: OAuth consent modal handler (extension side). Parallels
// approval-modal.ts. Receives daemon-initiated auth_consent_request via
// IpcClient.onAuthConsentRequest, ACKs immediately (before the modal
// resolves — the daemon's 3s ack window distinguishes "extension offline"
// from "user deciding"), surfaces a NAMED modal (the misclick guard:
// names the requesting claude.ai client AND this window's own codebase),
// and sends auth_consent_response { approve | deny | dismiss }.
//
// Dismiss-siblings: the daemon broadcasts auth_consent_resolved when a
// consent resolves elsewhere (T-P3-002R). VS Code modal:true dialogs
// CANNOT be force-closed programmatically, so handling is best-effort: we
// mark the open modal resolved-elsewhere (so its eventual click is a local
// no-op rather than a pointless daemon-discarded response) and surface a
// notification. The daemon's first-write-wins state machine is the real
// guarantee; this is UX cleanup.

import * as vscode from "vscode";
import type {
  AuthConsentRequest,
  AuthConsentResolved,
  AuthConsentTimeout,
} from "@claude-bridge/shared";
import type { IpcClient } from "./ipc/client.js";

const BTN_APPROVE = "Approve";
const BTN_DENY = "Deny";

// Daemon's DCR default when claude.ai sends no client_name (register.ts).
// Treated as "not meaningful" → fall back to the client_id prefix.
const DEFAULT_CLIENT_NAME = "unnamed-client";
// "cb_client_" (10) + 8 hex chars = a stable, unambiguous distinguisher
// shown ALWAYS, regardless of whether client_name is meaningful.
const CLIENT_ID_DISPLAY_LEN = 18;

/**
 * Human label for a claude.ai OAuth client: the client_name WHEN
 * meaningful, plus the client_id prefix shown ALWAYS as the guaranteed
 * distinguisher. `client_name` is whatever claude.ai sends at DCR and may
 * be the generic default (external-to-confirm at live smoke) — the prefix
 * keeps the label unambiguous either way. Shared by the modal (this file)
 * and the status-bar binding display (status-bar.ts).
 */
export function formatClientLabel(
  client_id: string,
  client_name: string,
): string {
  const idPrefix = client_id.slice(0, CLIENT_ID_DISPLAY_LEN);
  const meaningful =
    client_name.length > 0 && client_name !== DEFAULT_CLIENT_NAME;
  return meaningful ? `${client_name} (${idPrefix}…)` : `${idPrefix}…`;
}

/**
 * The named-modal copy. Names BOTH parties so approving in the WRONG window
 * shows the WRONG codebase name — a visible, catchable misclick.
 * Exported for unit testing.
 */
export function composeConsentModalText(
  request: AuthConsentRequest,
  codebaseName: string,
): string {
  const clientLabel = formatClientLabel(request.client_id, request.client_name);
  return [
    "Authorize a Claude.ai connector to bind to this workspace?",
    "",
    `Client: ${clientLabel}`,
    `Workspace (this window): ${codebaseName}`,
    "",
    `Approving binds this client to "${codebaseName}" only. ` +
      `If that is not the workspace you intended, click Deny and approve ` +
      `in the correct window.`,
  ].join("\n");
}

export interface ConsentHandlerDeps {
  // Test seams.
  showWarningMessage?: typeof vscode.window.showWarningMessage;
  showInformationMessage?: typeof vscode.window.showInformationMessage;
  // This window's friendly workspace folder name (the codebase being bound).
  // Sourced locally — the extension knows its own folder from
  // register_workspace; the daemon never sends it.
  getCodebaseName: () => string;
}

export interface ConsentHandlers {
  onAuthConsentRequest: (request: AuthConsentRequest) => Promise<void>;
  onAuthConsentResolved: (msg: AuthConsentResolved) => void;
  onAuthConsentTimeout: (msg: AuthConsentTimeout) => void;
}

export function makeConsentHandlers(
  ipcClient: IpcClient,
  deps: ConsentHandlerDeps,
): ConsentHandlers {
  const showWarning =
    deps.showWarningMessage ?? vscode.window.showWarningMessage;
  const showInfo =
    deps.showInformationMessage ?? vscode.window.showInformationMessage;

  // request_id → open-modal state. Lets onAuthConsentResolved mark a still-
  // open modal as resolved-elsewhere so its click becomes a no-op.
  const open = new Map<string, { resolvedElsewhere: boolean }>();

  const onAuthConsentRequest = async (
    request: AuthConsentRequest,
  ): Promise<void> => {
    // ACK-BEFORE-RESOLVE (correctness): acknowledge receipt immediately,
    // before the (blocking) modal. The daemon's ack-timeout pathway uses
    // this to tell "extension offline" from "user is deciding".
    try {
      ipcClient.send({
        kind: "auth_consent_ack",
        request_id: request.request_id,
      });
    } catch {
      // Socket closed between request and ack — the daemon's ack-timeout
      // handles it; nothing more we can do.
    }

    const entry = { resolvedElsewhere: false };
    open.set(request.request_id, entry);
    const text = composeConsentModalText(request, deps.getCodebaseName());
    let choice: string | undefined;
    try {
      choice = await showWarning(text, { modal: true }, BTN_APPROVE, BTN_DENY);
    } finally {
      open.delete(request.request_id);
    }

    // Resolved in another window while this modal was open: the daemon
    // already recorded a decision (first-write-wins). Sending now would be
    // discarded — skip it. The notification was shown by the resolved
    // handler.
    if (entry.resolvedElsewhere) return;

    // CB-SMOKE-READINESS-BATCH (the two-window fix): only an EXPLICIT
    // approve/deny resolves the consent request. `undefined` means the modal
    // closed WITHOUT a decision — Esc, focus loss, the OS auto-dismissing an
    // UNFOCUSED window's modal (the two-window auto-cancel: a second window's
    // modal returns undefined near-instantly when it isn't focused), or our
    // own dismiss-siblings cleanup. That is BENIGN — NOT a user decision — so
    // we send NOTHING. The request stays pending until a real decision in some
    // window or the 30s daemon timeout. (Previously this sent
    // decision:'dismiss', which the unfocused window emitted immediately and
    // which won the race as a denial, auto-cancelling the bind before the user
    // could approve in the window they intended. The daemon also now ignores a
    // stray dismiss — defense in depth.)
    if (choice !== BTN_APPROVE && choice !== BTN_DENY) {
      return;
    }
    const decision: "approve" | "deny" =
      choice === BTN_APPROVE ? "approve" : "deny";
    try {
      ipcClient.send({
        kind: "auth_consent_response",
        request_id: request.request_id,
        decision,
      });
    } catch {
      // Socket closed before we could respond — the daemon's decision
      // timeout handles it.
    }
  };

  // Shared best-effort close for both daemon→ext close signals
  // (auth_consent_resolved = a decision was recorded elsewhere;
  // auth_consent_timeout = the 30s decision timer fired). VS Code modal:true
  // dialogs cannot be force-closed programmatically, so: mark the still-open
  // modal stale (its eventual click becomes a local no-op — no pointless
  // daemon-discarded response) and surface a notification. Idempotent + keyed
  // by request_id; a no-op when this window has no open modal for it (e.g.
  // the responder, whose modal already resolved and was deleted).
  const closeStaleModal = (request_id: string, notice: string): void => {
    const entry = open.get(request_id);
    if (entry === undefined) return;
    entry.resolvedElsewhere = true;
    void showInfo(notice);
  };

  const onAuthConsentResolved = (msg: AuthConsentResolved): void => {
    closeStaleModal(
      msg.request_id,
      "Claude Bridge: this authorization was resolved in another window.",
    );
  };

  const onAuthConsentTimeout = (msg: AuthConsentTimeout): void => {
    // The daemon's 30s decision timer fired (the state machine already
    // transitioned to "timeout"). Close this window's stale modal.
    closeStaleModal(
      msg.request_id,
      "Claude Bridge: this authorization request timed out.",
    );
  };

  return { onAuthConsentRequest, onAuthConsentResolved, onAuthConsentTimeout };
}

export { BTN_APPROVE, BTN_DENY };

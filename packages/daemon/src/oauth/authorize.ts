// T-P3-002: OAuth /authorize endpoint per RFC 6749 §4.1 + OAuth 2.1 PKCE.
//
// Gating order (Decision a — fail before any IPC fires):
//   1. response_type=code
//   2. registered client_id
//   3. exact redirect_uri match against the client's registered set
//   4. code_challenge present
//   5. code_challenge_method=S256 (reject "plain" per Decision d)
// Then:
//   6. beginConsent() — creates record + sends IPC. If no extension is
//      online, returns extension_offline and we render the offline page
//      before any state exists.
//   7. awaitAck (3s window). On timeout: ack-timeout page.
//   8. Render the pending page (browser will meta-refresh /authorize/status).
//
// All URLs in returned HTML go through `deriveBaseUrl` (verdict §1
// invariant) — the status-poll URL is the only self-referential link
// here. The 302 lives in status.ts.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "../log/logger.js";
import type { ClientsStore } from "./clients-store.js";
import type { ConsentManager } from "./consent.js";
import { deriveBaseUrl } from "./metadata.js";
import {
  ackTimeoutPage,
  extensionOfflinePage,
  noUnboundWorkspacePage,
  pendingPage,
} from "./templates.js";

export interface AuthorizeHandlerDeps {
  logger: Logger;
  clientsStore: ClientsStore;
  consentManager: ConsentManager;
  // CB-DAEMON-LIFECYCLE-FIX (c2): count of extension connections hello'd with
  // this daemon. Lets the offline page distinguish "connected but no trusted
  // workspace" from "no extension here at all". Optional — defaults to 0
  // (the conservative "no extension connected" page) when not wired.
  countConnectedExtensions?: () => number;
}

function parseQuery(req: IncomingMessage): URLSearchParams {
  const url = req.url ?? "";
  const qIndex = url.indexOf("?");
  if (qIndex === -1) return new URLSearchParams();
  return new URLSearchParams(url.slice(qIndex + 1));
}

function sendErrorJson(
  res: ServerResponse,
  status: number,
  error: string,
  description: string,
): void {
  const body = JSON.stringify({ error, error_description: description });
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body, "utf8"),
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8"),
  });
  res.end(body);
}

export async function handleAuthorize(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AuthorizeHandlerDeps,
): Promise<void> {
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  const q = parseQuery(req);
  const client_id = q.get("client_id");
  const redirect_uri = q.get("redirect_uri");
  const response_type = q.get("response_type");
  const code_challenge = q.get("code_challenge");
  const code_challenge_method = q.get("code_challenge_method");
  const state_param = q.get("state") ?? "";

  // 1. response_type=code (we only support authorization_code per
  //    Decision d).
  if (response_type !== "code") {
    sendErrorJson(
      res,
      400,
      "unsupported_response_type",
      "only response_type=code is supported",
    );
    return;
  }

  // 2. client_id present and registered.
  if (client_id === null || client_id.length === 0) {
    sendErrorJson(res, 400, "invalid_request", "client_id is required");
    return;
  }
  const client = deps.clientsStore.findByClientId(client_id);
  if (client === null) {
    sendErrorJson(res, 400, "invalid_client", "client_id is not registered");
    return;
  }

  // 3. redirect_uri exact-match against the client's registered set.
  //    Open-redirect / code-interception guard (RFC 6749 §4.1.1 + OAuth
  //    2.1). NEVER fall back to "the first registered URI" — exact match
  //    only.
  if (redirect_uri === null || redirect_uri.length === 0) {
    sendErrorJson(res, 400, "invalid_request", "redirect_uri is required");
    return;
  }
  if (!client.redirect_uris.includes(redirect_uri)) {
    sendErrorJson(
      res,
      400,
      "invalid_redirect_uri",
      "redirect_uri does not exactly match a registered URI for this client",
    );
    return;
  }

  // 4. code_challenge present (PKCE required per Decision a + OAuth 2.1).
  if (code_challenge === null || code_challenge.length === 0) {
    sendErrorJson(
      res,
      400,
      "invalid_request",
      "code_challenge is required (PKCE)",
    );
    return;
  }

  // 5. code_challenge_method=S256 only. We do NOT support "plain" per
  //    Decision d (metadata advertises S256-only; reject anything else
  //    consistently).
  if (code_challenge_method !== "S256") {
    sendErrorJson(
      res,
      400,
      "invalid_request",
      "code_challenge_method must be S256",
    );
    return;
  }

  // 6. Begin consent. Synchronously emits the IPC; returns offline
  //    BEFORE any record exists if no extension is connected.
  const consent = deps.consentManager.beginConsent({
    client_id,
    client_name: client.client_name,
    redirect_uri,
    state_param,
    code_challenge,
  });
  if (!consent.ok) {
    deps.logger.info("oauth /authorize: consent could not begin", {
      client_id,
      reason: consent.reason,
    });
    // T-P3-004b: distinguish "all windows already bound" (a legible refusal
    // telling the operator to unbind or open the intended workspace) from a
    // genuinely-offline daemon (no extension connected at all).
    if (consent.reason === "no_unbound_workspace") {
      sendHtml(res, 409, noUnboundWorkspacePage());
      return;
    }
    // CB-DAEMON-LIFECYCLE-FIX (c2): if an extension is connected to THIS daemon
    // but unregistered, say so (no-folder / untrusted) rather than the generic
    // "no extension connected".
    const extensionConnected = (deps.countConnectedExtensions?.() ?? 0) > 0;
    sendHtml(res, 503, extensionOfflinePage(extensionConnected));
    return;
  }

  // 7. Wait for the 3s ack window. We DO NOT start the decision timer
  //    here — that starts once status.ts begins polling (or, more
  //    precisely, once awaitDecision is first called). This keeps the
  //    ack-timeout and decision-timeout windows cleanly separable.
  const ackOutcome = await deps.consentManager.awaitAck(consent.request_id);
  if (ackOutcome === "ack_timeout") {
    deps.logger.info("oauth /authorize: ack_timeout", {
      request_id: consent.request_id,
      client_id,
    });
    sendHtml(res, 504, ackTimeoutPage());
    return;
  }

  // 8. Render the pending page. Browser meta-refreshes status; status
  //    handler runs the decision-timer + 302.
  const base = deriveBaseUrl(req);
  const statusUrl = `${base}/authorize/status?request_id=${encodeURIComponent(
    consent.request_id,
  )}`;
  sendHtml(
    res,
    200,
    pendingPage({
      status_url: statusUrl,
      client_name: client.client_name,
    }),
  );
}

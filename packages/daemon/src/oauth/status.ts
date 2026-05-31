// T-P3-002: /authorize/status endpoint. Browser meta-refreshes here after
// the initial /authorize render. This handler is where the 30s decision
// timer runs — it begins on the first call to awaitDecision per
// request_id (idempotent inside ConsentManager).
//
// Outcomes (Decision d):
//   - unknown request_id → 404 not-found page
//   - pending            → 200 + pending page (browser meta-refreshes again)
//   - approved           → 302 to redirect_uri?code=…&state=… (deriveBaseUrl
//                          applies to nothing here — the redirect target is
//                          the CLIENT's registered URI, not our own)
//   - denied             → 200 + deny page (carries denial_kind for copy)
//   - timeout            → 200 + decision-timeout page
//
// The 302 target's `state` is the round-tripped value the client passed
// to /authorize; the daemon never inspects it.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "../log/logger.js";
import type { ConsentManager } from "./consent.js";
import { deriveBaseUrl } from "./metadata.js";
import {
  decisionTimeoutPage,
  denyPage,
  notFoundPage,
  pendingPage,
} from "./templates.js";

export interface StatusHandlerDeps {
  logger: Logger;
  consentManager: ConsentManager;
}

function parseQuery(req: IncomingMessage): URLSearchParams {
  const url = req.url ?? "";
  const qIndex = url.indexOf("?");
  if (qIndex === -1) return new URLSearchParams();
  return new URLSearchParams(url.slice(qIndex + 1));
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8"),
  });
  res.end(body);
}

function buildRedirectTarget(
  redirect_uri: string,
  code: string,
  state_param: string,
): string {
  // The redirect_uri may already contain a query string (RFC 6749
  // §4.1.2 — "If the redirection URI included an 'application/x-www-
  // form-urlencoded' formatted query component, it MUST be retained
  // when adding additional query parameters").
  const separator = redirect_uri.includes("?") ? "&" : "?";
  const params = new URLSearchParams();
  params.set("code", code);
  if (state_param !== "") {
    params.set("state", state_param);
  }
  return `${redirect_uri}${separator}${params.toString()}`;
}

export async function handleStatus(
  req: IncomingMessage,
  res: ServerResponse,
  deps: StatusHandlerDeps,
): Promise<void> {
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  const q = parseQuery(req);
  const request_id = q.get("request_id");
  if (request_id === null || request_id.length === 0) {
    sendHtml(res, 404, notFoundPage());
    return;
  }

  const consent = deps.consentManager.getConsent(request_id);
  if (consent === null) {
    sendHtml(res, 404, notFoundPage());
    return;
  }

  // Wait for the decision. Internally idempotent — the 30s timer starts
  // on the first call and survives subsequent meta-refresh polls. If the
  // state is already resolved, the awaiter returns immediately.
  const outcome = await deps.consentManager.awaitDecision(request_id);

  if (outcome.kind === "approved") {
    const target = buildRedirectTarget(
      consent.redirect_uri,
      outcome.code,
      consent.state_param,
    );
    res.writeHead(302, { Location: target });
    res.end();
    deps.logger.info("oauth /authorize/status: 302 to client redirect_uri", {
      request_id,
      client_id: consent.client_id,
      // Do NOT log the auth code (it's a short-lived bearer secret).
      // The redirect target's query string contains it; we log the
      // target's origin only.
      redirect_origin: new URL(consent.redirect_uri).origin,
    });
    return;
  }

  if (outcome.kind === "denied") {
    sendHtml(res, 200, denyPage({ denial_kind: outcome.denial_kind }));
    return;
  }

  if (outcome.kind === "timeout") {
    sendHtml(res, 200, decisionTimeoutPage());
    return;
  }

  // Unreachable — awaitDecision returns one of the three kinds above.
  // Defensive: render the pending page so the browser keeps polling
  // rather than 500-ing.
  const base = deriveBaseUrl(req);
  const statusUrl = `${base}/authorize/status?request_id=${encodeURIComponent(
    request_id,
  )}`;
  sendHtml(
    res,
    200,
    pendingPage({
      status_url: statusUrl,
      client_name: consent.client_name,
    }),
  );
}

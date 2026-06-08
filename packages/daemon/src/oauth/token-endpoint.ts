// T-P3-004a: OAuth 2.1 token endpoint (`/token`). Redeems an
// authorization_code (single-use, 60s TTL, minted by the consent flow) for
// a durable access token that CARRIES THE WORKSPACE BINDING. This is the
// hinge where the binding moves from the transient auth code onto the
// persistent token the auth layer enforces.
//
// Flow (RFC 6749 §4.1.3 + OAuth 2.1 PKCE, RFC 7636):
//   1. grant_type=authorization_code
//   2. redeem the code (exists, not expired, not already redeemed) — the
//      ConsentManager's single-use redemption guarantees one-shot.
//   3. client auth: client_id matches the code's; client_secret verified
//      (client_secret_post — the only method we advertise).
//   4. redirect_uri matches the one bound at /authorize.
//   5. PKCE: BASE64URL(SHA256(code_verifier)) === stored code_challenge.
//   6. mint the access token carrying bound_workspace (copied from the
//      redeemed auth code).
//
// Body is application/x-www-form-urlencoded (the OAuth token-endpoint wire
// format; claude.ai's connector posts form-encoded).

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { Logger } from "../log/logger.js";
import type { ClientsStore } from "./clients-store.js";
import type { ConsentManager } from "./consent.js";
import type { TokenStore } from "./token-store.js";

const MAX_BODY_BYTES = 16 * 1024;

export interface TokenHandlerDeps {
  logger: Logger;
  clientsStore: ClientsStore;
  consentManager: ConsentManager;
  tokenStore: TokenStore;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    // OAuth 2.1 §: token responses must not be cached.
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text, "utf8"),
  });
  res.end(text);
}

function sendError(
  res: ServerResponse,
  status: number,
  error: string,
  description: string,
): void {
  sendJson(res, status, { error, error_description: description });
}

/** PKCE S256: BASE64URL(SHA256(ASCII(code_verifier))). */
function pkceChallengeFromVerifier(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export async function handleToken(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TokenHandlerDeps,
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_request" }));
    return;
  }

  let bodyText: string;
  try {
    bodyText = await readBody(req);
  } catch {
    sendError(res, 400, "invalid_request", "failed to read request body");
    return;
  }

  const params = new URLSearchParams(bodyText);
  const grant_type = params.get("grant_type");
  const code = params.get("code");
  const redirect_uri = params.get("redirect_uri");
  const client_id = params.get("client_id");
  const client_secret = params.get("client_secret");
  const code_verifier = params.get("code_verifier");

  // 1. grant_type
  if (grant_type !== "authorization_code") {
    sendError(
      res,
      400,
      "unsupported_grant_type",
      "only authorization_code is supported",
    );
    return;
  }
  if (code === null || code.length === 0) {
    sendError(res, 400, "invalid_request", "code is required");
    return;
  }
  if (client_id === null || client_id.length === 0) {
    sendError(res, 400, "invalid_request", "client_id is required");
    return;
  }
  if (code_verifier === null || code_verifier.length === 0) {
    sendError(res, 400, "invalid_request", "code_verifier is required (PKCE)");
    return;
  }

  // 2. Client authentication (client_secret_post). Done BEFORE redeeming the
  //    code so a bad-secret attempt doesn't burn the user's single-use code.
  if (client_secret === null || client_secret.length === 0) {
    sendError(res, 401, "invalid_client", "client_secret is required");
    return;
  }
  const secretOk = await deps.clientsStore.verifyClientSecret(
    client_id,
    client_secret,
  );
  if (!secretOk) {
    sendError(res, 401, "invalid_client", "client authentication failed");
    return;
  }

  // 3. Redeem the auth code (single-use; returns null if unknown, already
  //    redeemed, or expired).
  const authCode = deps.consentManager.redeemAuthCode(code);
  if (authCode === null) {
    sendError(
      res,
      400,
      "invalid_grant",
      "authorization code is invalid, expired, or already redeemed",
    );
    return;
  }

  // 4. The code must belong to this client and redirect_uri (RFC 6749
  //    §4.1.3). Mismatch ⇒ invalid_grant (the code was issued for a
  //    different client/redirect).
  if (authCode.client_id !== client_id) {
    deps.logger.warn("oauth /token: client_id mismatch on code redemption", {
      code_client_id: authCode.client_id,
      presented_client_id: client_id,
    });
    sendError(res, 400, "invalid_grant", "code was not issued to this client");
    return;
  }
  if (redirect_uri !== authCode.redirect_uri) {
    sendError(
      res,
      400,
      "invalid_grant",
      "redirect_uri does not match the authorization request",
    );
    return;
  }

  // 5. PKCE verification (S256 only — we never issued a "plain" challenge).
  const expectedChallenge = pkceChallengeFromVerifier(code_verifier);
  if (expectedChallenge !== authCode.code_challenge) {
    sendError(res, 400, "invalid_grant", "PKCE verification failed");
    return;
  }

  // 6. Install-then-revoke (P3′-4 takeover): capture the workspace's existing
  //    bound token(s) BEFORE minting, mint the new bound token, then revoke
  //    exactly the captured old set. For a FRESH bind the captured set is empty
  //    → the revoke is a no-op (behavior unchanged). For a TAKEOVER (re-bind of
  //    an already-bound workspace, now permitted) the old binding is replaced.
  //    Ordering is the safety: a mint failure throws here and leaves the old
  //    binding intact (nothing revoked — never the unbound state); the new
  //    token is never in the captured set by construction, so it is never
  //    revoked. granularity is null (T-P3-005 owns its behavior).
  const supersededHashes =
    authCode.bound_workspace === null
      ? []
      : deps.tokenStore.tokenHashesForWorkspace(authCode.bound_workspace);
  const minted = await deps.tokenStore.mint({
    client_id,
    bound_workspace: authCode.bound_workspace,
    granularity: null,
  });
  // Revoke the OLD binding AFTER the new token is installed. A failure here
  // leaves the new binding live and the old token(s) a revocable leftover —
  // surfaced (logged), never the silent unbound state.
  if (supersededHashes.length > 0) {
    try {
      const tokens_revoked =
        await deps.tokenStore.revokeByTokenHashes(supersededHashes);
      deps.logger.info("oauth takeover: old binding revoked after install", {
        bound_workspace: authCode.bound_workspace,
        tokens_revoked,
      });
    } catch (err) {
      deps.logger.warn("oauth takeover: revoke-after-install failed", {
        bound_workspace: authCode.bound_workspace,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  deps.logger.info("oauth access token issued", {
    client_id,
    bound_workspace: authCode.bound_workspace,
  });

  sendJson(res, 200, {
    access_token: minted.access_token,
    token_type: "Bearer",
    expires_in: minted.expires_in_s,
  });
}

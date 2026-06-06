// CB-OAUTH-DISCOVERY-FIX: OAuth 2.0 Protected Resource Metadata (RFC 9728).
// Mounts at `/.well-known/oauth-protected-resource`. Unauthenticated by
// design — an MCP client (claude.ai) fetches this as the FIRST step of the
// discovery chain (RFC 9728 → RFC 8414 → DCR → authorize), BEFORE it holds
// any credential. Guarding it deadlocks discovery: the live smoke showed
// claude.ai abort the whole connector registration with a generic "couldn't
// register" when this returned 401 — never reaching /register (which works).
//
// Symmetric with metadata.ts (RFC 8414): URLs are derived from the inbound
// `Host` at request time (tunnel URL rotates on restart; never bake an
// origin). `resource` is this daemon; `authorization_servers` points at our
// own issuer — the same base the RFC 8414 metadata advertises as `issuer`.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { OAuthProtectedResourceMetadata } from "@claude-bridge/shared";
import type { Logger } from "../log/logger.js";
import { deriveBaseUrl } from "./metadata.js";

// We accept the access token in the Authorization header (Bearer) on the MCP
// tool surface — advertise that per RFC 9728 §2.
const BEARER_METHODS_SUPPORTED = ["header"] as const;

export function buildProtectedResourceMetadata(
  req: IncomingMessage,
): OAuthProtectedResourceMetadata {
  const base = deriveBaseUrl(req);
  return {
    resource: base,
    authorization_servers: [base],
    bearer_methods_supported: [...BEARER_METHODS_SUPPORTED],
  };
}

export interface ProtectedResourceHandlerDeps {
  logger: Logger;
}

export function handleProtectedResourceMetadata(
  req: IncomingMessage,
  res: ServerResponse,
  // Symmetry with handleMetadata: deps reserved for future logging/metrics,
  // intentionally unused today so router wiring stays uniform.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _deps: ProtectedResourceHandlerDeps,
): void {
  const body = JSON.stringify(buildProtectedResourceMetadata(req));
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body, "utf8"),
  });
  res.end(body);
}

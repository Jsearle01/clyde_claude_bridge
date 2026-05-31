// T-P3-001: OAuth Authorization Server Metadata endpoint (RFC 8414).
// Mounts at `/.well-known/oauth-authorization-server`. Unauthenticated by
// design — bootstrap discovery happens before any client credential exists.
//
// All URLs are constructed at request time from the inbound `Host` header
// (Decision d + design §5 invariant). Tunnel URL rotates on daemon
// restart; never bake in a fixed origin.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { OAuthMetadata } from "@claude-bridge/shared";
import type { Logger } from "../log/logger.js";

// Per Decision d — advertise only what we ship:
// - S256-only PKCE (no `plain`)
// - authorization_code grant only
// - client_secret_post auth method
// - no revocation_endpoint, no introspection_endpoint
const RESPONSE_TYPES_SUPPORTED = ["code"] as const;
const GRANT_TYPES_SUPPORTED = ["authorization_code"] as const;
const CODE_CHALLENGE_METHODS_SUPPORTED = ["S256"] as const;
const TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED = ["client_secret_post"] as const;

/**
 * Derive the public-facing base URL for this request. The tunnel
 * terminates HTTPS, so we use `https://` when the request's `Host` looks
 * like a tunnel hostname; localhost requests stay on `http://`.
 *
 * Falls back to `http://localhost:<port>` if `Host` is absent (shouldn't
 * happen for HTTP/1.1 but defended for shape).
 */
export function deriveBaseUrl(req: IncomingMessage): string {
  const host =
    typeof req.headers.host === "string" && req.headers.host.length > 0
      ? req.headers.host
      : "localhost";
  // Heuristic: localhost / 127.0.0.1 / 0.0.0.0 are HTTP; everything else
  // (i.e., a public tunnel host) is HTTPS-terminated by the tunnel.
  const isLocal =
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("0.0.0.0");
  const scheme = isLocal ? "http" : "https";
  return `${scheme}://${host}`;
}

export function buildMetadata(req: IncomingMessage): OAuthMetadata {
  const base = deriveBaseUrl(req);
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: [...RESPONSE_TYPES_SUPPORTED],
    grant_types_supported: [...GRANT_TYPES_SUPPORTED],
    code_challenge_methods_supported: [...CODE_CHALLENGE_METHODS_SUPPORTED],
    token_endpoint_auth_methods_supported: [
      ...TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED,
    ],
  };
}

export interface MetadataHandlerDeps {
  logger: Logger;
}

export function handleMetadata(
  req: IncomingMessage,
  res: ServerResponse,
  // T-P3-001: deps reserved for future logging/metrics; intentionally
  // unused today. Keeps the handler's signature uniform with
  // handleRegister for symmetric router wiring.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _deps: MetadataHandlerDeps,
): void {
  const body = JSON.stringify(buildMetadata(req));
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body, "utf8"),
  });
  res.end(body);
}

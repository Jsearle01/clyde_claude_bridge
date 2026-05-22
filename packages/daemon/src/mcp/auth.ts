// MCP bearer-token authentication (RFC 6750). Pure function: takes a request
// and the expected token, returns a result discriminant. No I/O, no logging,
// no audit-side effects — the caller decides what to do with the result.
//
// CC-4 (secret handling): the only token-derived value that ever leaves this
// function is `token_suffix` (last 4 chars on success). Never the full token.
// On mismatch, `constantTimeEqual` from T-0006 enforces timing-safety.

import type { IncomingMessage } from "node:http";
import { constantTimeEqual } from "../config/token.js";

export type AuthFailureReason =
  | "missing_header"
  | "malformed_header"
  | "invalid_token";

export type AuthResult =
  | { ok: true; token_suffix: string }
  | { ok: false; reason: AuthFailureReason };

// Resolve the Authorization header to a single string. Handles the array form
// that Node's HTTP module can deliver in principle (cf. NodeJS.Dict index
// signature). Uses `unknown` + typeof narrowing because `Array.isArray`'s
// type predicate is `arg is any[]`, which would collapse a structured-narrow
// approach to `any` under recommendedTypeChecked.
function readAuthHeader(req: IncomingMessage): string | undefined {
  const raw: unknown = req.headers.authorization;
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    const first: unknown = raw[0];
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

export function authenticate(
  req: IncomingMessage,
  expectedToken: string,
): AuthResult {
  const header = readAuthHeader(req);
  if (header === undefined || header === "") {
    return { ok: false, reason: "missing_header" };
  }

  const spaceIdx = header.indexOf(" ");
  if (spaceIdx === -1) {
    return { ok: false, reason: "malformed_header" };
  }
  const scheme = header.slice(0, spaceIdx);
  const presented = header.slice(spaceIdx + 1);
  // RFC 6750 specifies "Bearer" case-sensitively. Empty token after the
  // scheme (e.g. "Bearer " with trailing space) is also malformed.
  if (scheme !== "Bearer" || presented === "") {
    return { ok: false, reason: "malformed_header" };
  }

  if (!constantTimeEqual(presented, expectedToken)) {
    return { ok: false, reason: "invalid_token" };
  }

  return { ok: true, token_suffix: presented.slice(-4) };
}

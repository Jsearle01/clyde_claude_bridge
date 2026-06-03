// MCP bearer-token authentication (RFC 6750). Pure function: takes a request
// and the expected token, returns a result discriminant. No I/O, no logging,
// no audit-side effects — the caller decides what to do with the result.
//
// CC-4 (secret handling): the only token-derived value that ever leaves this
// function is `token_suffix` (last 4 chars on success). Never the full token.
// On mismatch, `constantTimeEqual` from T-0006 enforces timing-safety.

import type { IncomingMessage } from "node:http";
import type { OperationGranularity } from "@claude-bridge/shared";
import { constantTimeEqual } from "../config/token.js";

export type AuthFailureReason =
  | "missing_header"
  | "malformed_header"
  | "invalid_token";

// T-P3-004a: the workspace constraint an authenticated request carries.
// - "unconstrained": the legacy global static Bearer — no binding, retains
//   pre-P3 global behavior (any registered workspace, per the tool's own
//   resolution).
// - "bound": an OAuth access token — may act ONLY on `workspace`. A null
//   workspace (a non-binding approve, T-P3-002R) acts on NOTHING; the
//   enforcement layer rejects every workspace-targeting tool.
export type WorkspaceBinding =
  | { kind: "unconstrained" }
  | {
      kind: "bound";
      workspace: string | null;
      // T-P3-005: the binding's default operation granularity (null =
      // unspecified → the gate resolves to its per_call fail-safe).
      granularity: OperationGranularity | null;
    };

export type AuthResult =
  | { ok: true; token_suffix: string; binding: WorkspaceBinding }
  | { ok: false; reason: AuthFailureReason };

// T-P3-004a: resolve a presented OAuth access token to its binding, or null
// if unknown/expired. Injected by the caller (wraps TokenStore.lookup) so
// auth.ts stays free of the token-store/persistence layer. T-P3-005: carries
// the token's default granularity through to the binding.
export type OAuthTokenLookup = (
  token: string,
) => {
  bound_workspace: string | null;
  granularity: OperationGranularity | null;
} | null;

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
  // T-P3-004a: optional OAuth-token resolver. When a presented token isn't
  // the static Bearer, it is looked up here; a hit yields a bound result.
  lookupOAuthToken?: OAuthTokenLookup,
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

  // 1. Legacy global static Bearer (constant-time compare). Unconstrained.
  if (constantTimeEqual(presented, expectedToken)) {
    return {
      ok: true,
      token_suffix: presented.slice(-4),
      binding: { kind: "unconstrained" },
    };
  }

  // 2. OAuth access token (T-P3-004a). A hit is workspace-bound.
  const oauth = lookupOAuthToken?.(presented) ?? null;
  if (oauth !== null) {
    return {
      ok: true,
      token_suffix: presented.slice(-4),
      binding: {
        kind: "bound",
        workspace: oauth.bound_workspace,
        granularity: oauth.granularity,
      },
    };
  }

  return { ok: false, reason: "invalid_token" };
}

import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";
import { authenticate, type OAuthTokenLookup } from "../../src/mcp/auth.js";

// T-BEARER-1: the static Bearer auth path was removed. OAuth-bound tokens are
// the ONLY credential — authenticate() takes the lookup, not an expected token.
const lookup: OAuthTokenLookup = (tok) =>
  tok === "cb_tok_deadbeef"
    ? { bound_workspace: "workspace-A", granularity: null }
    : tok === "cb_tok_nullbind"
      ? { bound_workspace: null, granularity: null }
      : null;
const noLookup: OAuthTokenLookup = () => null;

function makeReq(headers: Record<string, string | string[]>): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("authenticate (T-BEARER-1: OAuth-bound is the only credential)", () => {
  it("missing Authorization header → missing_header (12.a)", () => {
    expect(authenticate(makeReq({}), noLookup)).toEqual({
      ok: false,
      reason: "missing_header",
    });
  });

  it("empty Authorization header → missing_header (12.b)", () => {
    expect(authenticate(makeReq({ authorization: "" }), noLookup)).toEqual({
      ok: false,
      reason: "missing_header",
    });
  });

  it("non-Bearer scheme → malformed_header (12.c)", () => {
    expect(
      authenticate(makeReq({ authorization: "Token cb_tok_deadbeef" }), lookup),
    ).toEqual({ ok: false, reason: "malformed_header" });
  });

  it("case-mismatched scheme → malformed_header (12.d)", () => {
    // RFC 6750 specifies "Bearer" case-sensitively.
    expect(
      authenticate(makeReq({ authorization: "bearer cb_tok_deadbeef" }), lookup),
    ).toEqual({ ok: false, reason: "malformed_header" });
  });

  it("Bearer with no token → malformed_header (12.e)", () => {
    expect(
      authenticate(makeReq({ authorization: "Bearer " }), lookup),
    ).toEqual({ ok: false, reason: "malformed_header" });
    expect(
      authenticate(makeReq({ authorization: "Bearer" }), lookup),
    ).toEqual({ ok: false, reason: "malformed_header" });
  });

  // AC-B1-1: the removal proven.
  it("a non-bound credential is rejected — no unconstrained path", () => {
    // The old static Bearer (and any token that doesn't resolve to a binding)
    // is now rejected; there is NO {kind:"unconstrained"} grant / fallthrough.
    const oldBearer = "cb_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(
      authenticate(makeReq({ authorization: `Bearer ${oldBearer}` }), noLookup),
    ).toEqual({ ok: false, reason: "invalid_token" });
    // Even with a live OAuth lookup present, a non-resolving token is invalid —
    // no fall-through to a global/unconstrained grant.
    expect(
      authenticate(makeReq({ authorization: `Bearer ${oldBearer}` }), lookup),
    ).toEqual({ ok: false, reason: "invalid_token" });
  });

  // AC-B1-2: the OAuth bound path intact (claude.ai's path, unaffected).
  it("an OAuth token authenticates as BOUND to its workspace (12.g)", () => {
    const result = authenticate(
      makeReq({ authorization: "Bearer cb_tok_deadbeef" }),
      lookup,
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.binding).toEqual({
      kind: "bound",
      workspace: "workspace-A",
      granularity: null,
    });
    expect(result.token_suffix).toBe("beef");
  });

  it("an OAuth token bound to null authenticates as bound-to-null (acts on nothing)", () => {
    const result = authenticate(
      makeReq({ authorization: "Bearer cb_tok_nullbind" }),
      lookup,
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.binding).toEqual({
      kind: "bound",
      workspace: null,
      granularity: null,
    });
  });

  it("token_suffix on success is the last 4 chars only — CC-4 (12.i)", () => {
    const result = authenticate(
      makeReq({ authorization: "Bearer cb_tok_deadbeef" }),
      lookup,
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.token_suffix).toHaveLength(4);
    expect(result.token_suffix).toBe("beef");
  });

  it("array-form Authorization header — first element used (12.h)", () => {
    const result = authenticate(
      makeReq({
        authorization: ["Bearer cb_tok_deadbeef", "Bearer cb_tok_other"],
      }),
      lookup,
    );
    expect(result.ok).toBe(true);
  });

  it("an unknown token (not in the OAuth store) → invalid_token", () => {
    expect(
      authenticate(makeReq({ authorization: "Bearer cb_tok_unknown" }), lookup),
    ).toEqual({ ok: false, reason: "invalid_token" });
  });
});

import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";
import { authenticate } from "../../src/mcp/auth.js";

const INERT_TOKEN = "cb_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const INERT_TOKEN_OTHER = "cb_live_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function makeReq(headers: Record<string, string | string[]>): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("authenticate", () => {
  it("missing Authorization header → missing_header (12.a)", () => {
    const result = authenticate(makeReq({}), INERT_TOKEN);
    expect(result).toEqual({ ok: false, reason: "missing_header" });
  });

  it("empty Authorization header → missing_header (12.b)", () => {
    const result = authenticate(
      makeReq({ authorization: "" }),
      INERT_TOKEN,
    );
    expect(result).toEqual({ ok: false, reason: "missing_header" });
  });

  it("non-Bearer scheme → malformed_header (12.c)", () => {
    const result = authenticate(
      makeReq({ authorization: `Token ${INERT_TOKEN}` }),
      INERT_TOKEN,
    );
    expect(result).toEqual({ ok: false, reason: "malformed_header" });
  });

  it("case-mismatched scheme → malformed_header (12.d)", () => {
    // RFC 6750 specifies "Bearer" case-sensitively.
    const result = authenticate(
      makeReq({ authorization: `bearer ${INERT_TOKEN}` }),
      INERT_TOKEN,
    );
    expect(result).toEqual({ ok: false, reason: "malformed_header" });
  });

  it("Bearer with no token → malformed_header (12.e)", () => {
    expect(
      authenticate(makeReq({ authorization: "Bearer " }), INERT_TOKEN),
    ).toEqual({ ok: false, reason: "malformed_header" });
    expect(
      authenticate(makeReq({ authorization: "Bearer" }), INERT_TOKEN),
    ).toEqual({ ok: false, reason: "malformed_header" });
  });

  it("Bearer with wrong token → invalid_token (12.f)", () => {
    const result = authenticate(
      makeReq({ authorization: `Bearer ${INERT_TOKEN_OTHER}` }),
      INERT_TOKEN,
    );
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("Bearer with correct token → ok + token_suffix (12.g)", () => {
    const result = authenticate(
      makeReq({ authorization: `Bearer ${INERT_TOKEN}` }),
      INERT_TOKEN,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token_suffix).toBe(INERT_TOKEN.slice(-4));
    }
  });

  it("array-form Authorization header — first element used (12.h)", () => {
    const result = authenticate(
      makeReq({
        authorization: [`Bearer ${INERT_TOKEN}`, `Bearer ${INERT_TOKEN_OTHER}`],
      }),
      INERT_TOKEN,
    );
    expect(result.ok).toBe(true);
  });

  it("token_suffix on success is the last 4 chars only — CC-4 (12.i)", () => {
    const result = authenticate(
      makeReq({ authorization: `Bearer ${INERT_TOKEN}` }),
      INERT_TOKEN,
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.token_suffix).toHaveLength(4);
    expect(result.token_suffix).toBe("AAAA");
    expect(INERT_TOKEN).toContain(result.token_suffix);
  });

  // T-P3-004a: binding + OAuth-token coexistence.
  it("the static Bearer authenticates as UNCONSTRAINED (legacy global)", () => {
    const result = authenticate(
      makeReq({ authorization: `Bearer ${INERT_TOKEN}` }),
      INERT_TOKEN,
      () => null, // OAuth lookup present but the Bearer wins first
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.binding).toEqual({ kind: "unconstrained" });
  });

  it("an OAuth token (not the Bearer) authenticates as BOUND to its workspace", () => {
    const result = authenticate(
      makeReq({ authorization: "Bearer cb_tok_deadbeef" }),
      INERT_TOKEN,
      (tok) =>
        tok === "cb_tok_deadbeef" ? { bound_workspace: "workspace-A" } : null,
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.binding).toEqual({ kind: "bound", workspace: "workspace-A" });
    expect(result.token_suffix).toBe("beef");
  });

  it("an OAuth token bound to null authenticates as bound-to-null (acts on nothing)", () => {
    const result = authenticate(
      makeReq({ authorization: "Bearer cb_tok_nullbind" }),
      INERT_TOKEN,
      () => ({ bound_workspace: null }),
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.binding).toEqual({ kind: "bound", workspace: null });
  });

  it("an unknown token (neither Bearer nor in the OAuth store) → invalid_token", () => {
    const result = authenticate(
      makeReq({ authorization: "Bearer cb_tok_unknown" }),
      INERT_TOKEN,
      () => null,
    );
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("with no OAuth lookup provided, a non-Bearer token → invalid_token (legacy behavior)", () => {
    const result = authenticate(
      makeReq({ authorization: "Bearer cb_tok_whatever" }),
      INERT_TOKEN,
    );
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });
});

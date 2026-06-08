// T-P3-004a: unit tests for the /token endpoint. Drives the full
// auth-code → access-token redemption (PKCE verify, client auth, single-use
// code, binding carriage onto the minted token).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ClientsStore } from "../../src/oauth/clients-store.js";
import { ConsentManager } from "../../src/oauth/consent.js";
import { TokenStore } from "../../src/oauth/token-store.js";
import { handleToken } from "../../src/oauth/token-endpoint.js";
import type { Logger } from "../../src/log/logger.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};

function makeReq(body: string, method = "POST"): IncomingMessage {
  const listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  const req = {
    method,
    headers: { host: "test.local" },
    _fired: false,
    on(event: string, cb: (...a: unknown[]) => void): unknown {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
      queueMicrotask(() => {
        if (listeners.has("data") && listeners.has("end") && !req._fired) {
          req._fired = true;
          for (const l of listeners.get("data") ?? []) l(Buffer.from(body, "utf8"));
          for (const l of listeners.get("end") ?? []) l();
        }
      });
      return req;
    },
    destroy(): void {},
  };
  return req as unknown as IncomingMessage;
}

interface Rec {
  status?: number;
  body?: string;
}
function makeRes(rec: Rec): ServerResponse {
  const res = {
    headersSent: false,
    writeHead(status: number): unknown {
      rec.status = status;
      return res;
    },
    end(body?: string): void {
      rec.body = body;
    },
  };
  return res as unknown as ServerResponse;
}

// PKCE S256 helper (mirrors the endpoint's verification).
function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

let tempDir: string;
let clientsStore: ClientsStore;
let consent: ConsentManager;
let tokenStore: TokenStore;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cb-token-ep-"));
  clientsStore = new ClientsStore(join(tempDir, "clients.json"));
  await clientsStore.load();
  consent = new ConsentManager({ logger: silentLogger }, () => 1, () => undefined);
  tokenStore = new TokenStore(join(tempDir, "tokens.json"));
  await tokenStore.load();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const REDIRECT = "https://claude.ai/cb";
const VERIFIER = "verifier-0123456789-abcdefghij-klmnopqrst";

// Register a client + drive a consent to "approve" bound to a workspace,
// returning the issued auth code + the client's plaintext secret.
async function setupGrant(
  bound_workspace: string | null,
): Promise<{ code: string; client_id: string; client_secret: string }> {
  const { record, client_secret_plaintext } = await clientsStore.addClient({
    client_name: "Test",
    redirect_uris: [REDIRECT],
  });
  const r = consent.beginConsent({
    client_id: record.client_id,
    client_name: "Test",
    redirect_uri: REDIRECT,
    state_param: "st",
    code_challenge: challengeOf(VERIFIER),
  });
  if (!r.ok) throw new Error("beginConsent failed");
  consent.recordAck(r.request_id);
  consent.recordDecision(r.request_id, "approve", bound_workspace);
  const code = consent.getConsent(r.request_id)?.issued_code;
  if (code === undefined || code === null) throw new Error("no code issued");
  return { code, client_id: record.client_id, client_secret: client_secret_plaintext };
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function callToken(body: string): Promise<{ status?: number; json: Record<string, unknown> }> {
  const rec: Rec = {};
  await handleToken(makeReq(body), makeRes(rec), {
    logger: silentLogger,
    clientsStore,
    consentManager: consent,
    tokenStore,
  });
  return {
    status: rec.status,
    json: rec.body !== undefined ? (JSON.parse(rec.body) as Record<string, unknown>) : {},
  };
}

describe("handleToken — happy path (AC-8: token carries the binding)", () => {
  it("valid code + PKCE + client auth → 200 with a bound access token", async () => {
    const g = await setupGrant("workspace-A");
    const res = await callToken(
      form({
        grant_type: "authorization_code",
        code: g.code,
        redirect_uri: REDIRECT,
        client_id: g.client_id,
        client_secret: g.client_secret,
        code_verifier: VERIFIER,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.json.token_type).toBe("Bearer");
    const access = res.json.access_token as string;
    expect(access.startsWith("cb_tok_")).toBe(true);
    // The minted token resolves to the bound workspace (the binding moved
    // from the auth code onto the durable token).
    expect(tokenStore.lookup(access)?.bound_workspace).toBe("workspace-A");
  });
});

describe("handleToken — rejections", () => {
  it("PKCE mismatch → invalid_grant", async () => {
    const g = await setupGrant("workspace-A");
    const res = await callToken(
      form({
        grant_type: "authorization_code",
        code: g.code,
        redirect_uri: REDIRECT,
        client_id: g.client_id,
        client_secret: g.client_secret,
        code_verifier: "the-WRONG-verifier",
      }),
    );
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("invalid_grant");
  });

  it("bad client_secret → invalid_client (and the code is NOT burned)", async () => {
    const g = await setupGrant("workspace-A");
    const bad = await callToken(
      form({
        grant_type: "authorization_code",
        code: g.code,
        redirect_uri: REDIRECT,
        client_id: g.client_id,
        client_secret: "wrong-secret",
        code_verifier: VERIFIER,
      }),
    );
    expect(bad.status).toBe(401);
    expect(bad.json.error).toBe("invalid_client");
    // The code survived (client auth runs before redemption) — a correct
    // retry still works.
    const ok = await callToken(
      form({
        grant_type: "authorization_code",
        code: g.code,
        redirect_uri: REDIRECT,
        client_id: g.client_id,
        client_secret: g.client_secret,
        code_verifier: VERIFIER,
      }),
    );
    expect(ok.status).toBe(200);
  });

  it("already-redeemed code → invalid_grant (single-use)", async () => {
    const g = await setupGrant("workspace-A");
    const ok = await callToken(
      form({
        grant_type: "authorization_code",
        code: g.code,
        redirect_uri: REDIRECT,
        client_id: g.client_id,
        client_secret: g.client_secret,
        code_verifier: VERIFIER,
      }),
    );
    expect(ok.status).toBe(200);
    const again = await callToken(
      form({
        grant_type: "authorization_code",
        code: g.code,
        redirect_uri: REDIRECT,
        client_id: g.client_id,
        client_secret: g.client_secret,
        code_verifier: VERIFIER,
      }),
    );
    expect(again.status).toBe(400);
    expect(again.json.error).toBe("invalid_grant");
  });

  it("unsupported grant_type → unsupported_grant_type", async () => {
    const res = await callToken(form({ grant_type: "client_credentials" }));
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("unsupported_grant_type");
  });

  it("redirect_uri mismatch → invalid_grant", async () => {
    const g = await setupGrant("workspace-A");
    const res = await callToken(
      form({
        grant_type: "authorization_code",
        code: g.code,
        redirect_uri: "https://evil.example/cb",
        client_id: g.client_id,
        client_secret: g.client_secret,
        code_verifier: VERIFIER,
      }),
    );
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("invalid_grant");
  });
});

// P3′-4: orphaned-binding reclaim. The takeover happens at REDEMPTION via
// install-then-revoke (capture old token hashes → mint new → revoke captured
// old). A fresh bind has an empty captured set (no-op revoke), so this block
// also pins fresh-bind behavior as unchanged.
describe("handleToken — P3′-4 takeover (install-then-revoke, captured set)", () => {
  async function redeem(g: {
    code: string;
    client_id: string;
    client_secret: string;
  }): Promise<{ status?: number; json: Record<string, unknown> }> {
    return callToken(
      form({
        grant_type: "authorization_code",
        code: g.code,
        redirect_uri: REDIRECT,
        client_id: g.client_id,
        client_secret: g.client_secret,
        code_verifier: VERIFIER,
      }),
    );
  }

  it("AC-4-3: a takeover installs the new bound token and revokes the OLD; the new survives", async () => {
    const oldToken = ((await redeem(await setupGrant("workspace-A"))).json
      .access_token ?? "") as string;
    expect(tokenStore.lookup(oldToken)?.bound_workspace).toBe("workspace-A");

    // A fresh consent for the SAME (already-bound) workspace = the takeover.
    const newToken = ((await redeem(await setupGrant("workspace-A"))).json
      .access_token ?? "") as string;

    expect(tokenStore.lookup(oldToken)).toBeNull(); // old revoked
    expect(tokenStore.lookup(newToken)?.bound_workspace).toBe("workspace-A"); // new live
    expect(
      tokenStore
        .listBindings()
        .filter((b) => b.bound_workspace === "workspace-A"),
    ).toHaveLength(1); // exactly one binding remains
  });

  it("AC-4-3: a FRESH bind (unbound workspace) is unchanged — empty captured set, no revoke", async () => {
    const res = await redeem(await setupGrant("workspace-Fresh"));
    expect(res.status).toBe(200);
    expect(
      tokenStore.lookup(res.json.access_token as string)?.bound_workspace,
    ).toBe("workspace-Fresh");
  });

  it("AC-4-7-flavor: a takeover of A does NOT touch B's binding (captured set is per-workspace)", async () => {
    const tA = ((await redeem(await setupGrant("workspace-A"))).json
      .access_token ?? "") as string;
    const tB = ((await redeem(await setupGrant("workspace-B"))).json
      .access_token ?? "") as string;
    await redeem(await setupGrant("workspace-A")); // takeover of A only
    expect(tokenStore.lookup(tA)).toBeNull(); // old A revoked
    expect(tokenStore.lookup(tB)?.bound_workspace).toBe("workspace-B"); // B intact
  });

  it("AC-4-4: install (mint) failure leaves the OLD binding intact — never unbound", async () => {
    const oldToken = ((await redeem(await setupGrant("workspace-A"))).json
      .access_token ?? "") as string;
    const spy = vi
      .spyOn(tokenStore, "mint")
      .mockRejectedValueOnce(new Error("disk full"));
    await redeem(await setupGrant("workspace-A")).catch(() => undefined);
    spy.mockRestore();
    // The failed takeover never revoked the old — the user is still bound.
    expect(tokenStore.lookup(oldToken)?.bound_workspace).toBe("workspace-A");
  });

  it("AC-4-4: revoke-after-install failure leaves the NEW binding live (old a surfaced leftover, not unbound)", async () => {
    const oldToken = ((await redeem(await setupGrant("workspace-A"))).json
      .access_token ?? "") as string;
    const spy = vi
      .spyOn(tokenStore, "revokeByTokenHashes")
      .mockRejectedValueOnce(new Error("write failed"));
    const res = await redeem(await setupGrant("workspace-A"));
    spy.mockRestore();
    // Install succeeded (new live); the revoke failure was surfaced, not rolled
    // back — never the unbound state.
    expect(res.status).toBe(200);
    expect(
      tokenStore.lookup(res.json.access_token as string)?.bound_workspace,
    ).toBe("workspace-A");
    expect(tokenStore.lookup(oldToken)?.bound_workspace).toBe("workspace-A"); // old leftover
  });
});

// P3′-5: the binding-default granularity mints `per_call` (the cautious
// ceiling), never null — the operator loosens it via the "Set approval mode"
// switch. A non-binding approve carries no granularity floor to govern.
describe("handleToken — P3′-5 binding-default granularity", () => {
  async function redeem(g: {
    code: string;
    client_id: string;
    client_secret: string;
  }): Promise<{ status?: number; json: Record<string, unknown> }> {
    return callToken(
      form({
        grant_type: "authorization_code",
        code: g.code,
        redirect_uri: REDIRECT,
        client_id: g.client_id,
        client_secret: g.client_secret,
        code_verifier: VERIFIER,
      }),
    );
  }

  it("AC-5-4: a fresh bind mints granularity per_call (not null)", async () => {
    const token = ((await redeem(await setupGrant("workspace-A"))).json
      .access_token ?? "") as string;
    expect(tokenStore.lookup(token)?.granularity).toBe("per_call");
  });

  it("a non-binding approve (null workspace) keeps granularity null", async () => {
    const token = ((await redeem(await setupGrant(null))).json.access_token ??
      "") as string;
    expect(tokenStore.lookup(token)?.granularity).toBeNull();
  });
});

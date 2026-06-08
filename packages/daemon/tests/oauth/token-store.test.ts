// T-P3-004a: unit tests for the durable OAuth access-token store. Covers
// mint/lookup round-trip, no-plaintext-at-rest (SHA-256 hash only), binding
// carriage, expiry (TTL + injected clock), daemon-restart persistence, and
// file permissions on Unix.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TokenStore,
  TokensStoreVersionUnsupportedError,
  generateAccessToken,
  hashToken,
  ACCESS_TOKEN_TTL_MS,
} from "../../src/oauth/token-store.js";
import { authenticate } from "../../src/mcp/auth.js";
import type { IncomingMessage } from "node:http";

let tempDir: string;
let storePath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cb-token-store-"));
  storePath = join(tempDir, "tokens.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("generateAccessToken / hashToken", () => {
  it("token starts with cb_tok_ and has 64 hex chars", () => {
    const t = generateAccessToken();
    expect(t.startsWith("cb_tok_")).toBe(true);
    expect(t.slice("cb_tok_".length)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hashToken is a stable 64-char sha256 hex; differs per token", () => {
    const a = generateAccessToken();
    expect(hashToken(a)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).not.toBe(hashToken(generateAccessToken()));
  });
});

describe("TokenStore.mint / lookup (AC-8 binding carriage)", () => {
  it("mints a token whose lookup returns the bound workspace", async () => {
    const store = new TokenStore(storePath);
    await store.load();
    const { access_token, expires_in_s } = await store.mint({
      client_id: "cb_client_x",
      bound_workspace: "workspace-A",
    });
    expect(access_token.startsWith("cb_tok_")).toBe(true);
    expect(expires_in_s).toBe(Math.floor(ACCESS_TOKEN_TTL_MS / 1000));
    const binding = store.lookup(access_token);
    expect(binding).not.toBeNull();
    expect(binding?.client_id).toBe("cb_client_x");
    expect(binding?.bound_workspace).toBe("workspace-A");
    expect(binding?.granularity).toBeNull();
  });

  it("a non-binding approve mints a null-bound token", async () => {
    const store = new TokenStore(storePath);
    await store.load();
    const { access_token } = await store.mint({
      client_id: "cb_client_x",
      bound_workspace: null,
    });
    expect(store.lookup(access_token)?.bound_workspace).toBeNull();
  });

  it("lookup of an unknown token returns null", async () => {
    const store = new TokenStore(storePath);
    await store.load();
    expect(store.lookup(generateAccessToken())).toBeNull();
  });

  it("NO plaintext at rest — only the sha256 hash is persisted", async () => {
    const store = new TokenStore(storePath);
    await store.load();
    const { access_token } = await store.mint({
      client_id: "cb_client_x",
      bound_workspace: "workspace-A",
    });
    const onDisk = await readFile(storePath, "utf8");
    expect(onDisk).not.toContain(access_token);
    expect(onDisk).toContain(hashToken(access_token));
  });
});

describe("TokenStore expiry (injected clock)", () => {
  it("a token past its expiry is not returned by lookup", async () => {
    let now = 1_000_000;
    const store = new TokenStore(storePath, () => now);
    await store.load();
    const { access_token } = await store.mint({
      client_id: "cb_client_x",
      bound_workspace: "workspace-A",
    });
    expect(store.lookup(access_token)).not.toBeNull();
    now += ACCESS_TOKEN_TTL_MS + 1;
    expect(store.lookup(access_token)).toBeNull();
  });
});

describe("TokenStore persistence (daemon restart)", () => {
  it("a minted token survives a reload from disk", async () => {
    const store = new TokenStore(storePath);
    await store.load();
    const { access_token } = await store.mint({
      client_id: "cb_client_x",
      bound_workspace: "workspace-A",
    });

    const fresh = new TokenStore(storePath);
    await fresh.load();
    expect(fresh.lookup(access_token)?.bound_workspace).toBe("workspace-A");
  });

  it("expired tokens are swept on load (against an injected clock)", async () => {
    let now = 1_000_000;
    const store = new TokenStore(storePath, () => now);
    await store.load();
    await store.mint({ client_id: "c", bound_workspace: "w" });
    expect(store.size()).toBe(1);

    now += ACCESS_TOKEN_TTL_MS + 1;
    const fresh = new TokenStore(storePath, () => now);
    await fresh.load();
    expect(fresh.size()).toBe(0);
  });

  it("an unsupported version throws rather than corrupting", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(storePath, JSON.stringify({ version: "2", tokens: [] }));
    const store = new TokenStore(storePath);
    await expect(store.load()).rejects.toBeInstanceOf(
      TokensStoreVersionUnsupportedError,
    );
  });
});

describe("T-P3-004b — revokeByWorkspace + hasActiveBindingFor", () => {
  it("revokeByWorkspace deletes only matching tokens; leaves others; returns count", async () => {
    const store = new TokenStore(storePath);
    await store.load();
    const a = await store.mint({ client_id: "c1", bound_workspace: "ws-A" });
    const b = await store.mint({ client_id: "c2", bound_workspace: "ws-B" });
    expect(store.size()).toBe(2);

    const removed = await store.revokeByWorkspace("ws-A");
    expect(removed).toBe(1);
    expect(store.lookup(a.access_token)).toBeNull(); // A's token gone
    expect(store.lookup(b.access_token)?.bound_workspace).toBe("ws-B"); // B intact
  });

  it("revokeByWorkspace persists (a reload still shows the token gone)", async () => {
    const store = new TokenStore(storePath);
    await store.load();
    const a = await store.mint({ client_id: "c1", bound_workspace: "ws-A" });
    await store.revokeByWorkspace("ws-A");
    const fresh = new TokenStore(storePath);
    await fresh.load();
    expect(fresh.lookup(a.access_token)).toBeNull();
  });

  it("hasActiveBindingFor: true for a live bound token, false after revoke", async () => {
    const store = new TokenStore(storePath);
    await store.load();
    await store.mint({ client_id: "c1", bound_workspace: "ws-A" });
    expect(store.hasActiveBindingFor("ws-A")).toBe(true);
    expect(store.hasActiveBindingFor("ws-B")).toBe(false);
    await store.revokeByWorkspace("ws-A");
    expect(store.hasActiveBindingFor("ws-A")).toBe(false);
  });

  it("hasActiveBindingFor is false for an expired token", async () => {
    let now = 1_000_000;
    const store = new TokenStore(storePath, () => now);
    await store.load();
    await store.mint({ client_id: "c1", bound_workspace: "ws-A" });
    expect(store.hasActiveBindingFor("ws-A")).toBe(true);
    now += ACCESS_TOKEN_TTL_MS + 1;
    expect(store.hasActiveBindingFor("ws-A")).toBe(false);
  });
});

// CB-SMOKE-READINESS-BATCH: listBindings (status + unbind resolution) +
// revokeAll (unbind --all).
describe("CB-SMOKE-READINESS-BATCH — listBindings + revokeAll", () => {
  it("listBindings returns one summary per ACTIVE token (client, workspace, issued, expires)", async () => {
    const store = new TokenStore(storePath);
    await store.load();
    await store.mint({ client_id: "c1", bound_workspace: "ws-A" });
    await store.mint({ client_id: "c2", bound_workspace: "ws-B" });
    const bindings = store.listBindings();
    expect(bindings).toHaveLength(2);
    const a = bindings.find((b) => b.bound_workspace === "ws-A");
    expect(a?.client_id).toBe("c1");
    expect(typeof a?.issued_at).toBe("string");
    expect(typeof a?.expires_at).toBe("number");
  });

  it("listBindings omits expired tokens", async () => {
    let now = 1_000_000;
    const store = new TokenStore(storePath, () => now);
    await store.load();
    await store.mint({ client_id: "c1", bound_workspace: "ws-A" });
    expect(store.listBindings()).toHaveLength(1);
    now += ACCESS_TOKEN_TTL_MS + 1;
    expect(store.listBindings()).toHaveLength(0);
  });

  it("listBindings includes null-bound (non-binding) tokens", async () => {
    const store = new TokenStore(storePath);
    await store.load();
    await store.mint({ client_id: "c1", bound_workspace: null });
    expect(store.listBindings()[0]?.bound_workspace).toBeNull();
  });

  it("revokeAll empties the store (the --all invariant: tokens.json ends empty) + persists", async () => {
    const store = new TokenStore(storePath);
    await store.load();
    await store.mint({ client_id: "c1", bound_workspace: "ws-A" });
    await store.mint({ client_id: "c2", bound_workspace: null });
    expect(store.size()).toBe(2);
    const removed = await store.revokeAll();
    expect(removed).toBe(2);
    expect(store.size()).toBe(0);
    const fresh = new TokenStore(storePath);
    await fresh.load();
    expect(fresh.size()).toBe(0);
  });

  it("revokeAll on an empty store removes nothing", async () => {
    const store = new TokenStore(storePath);
    await store.load();
    expect(await store.revokeAll()).toBe(0);
  });
});

describe("T-P3-004b — AC-12d: a REVOKED token authenticates as INVALID, never unconstrained", () => {
  const STATIC_BEARER = "cb_live_STATICSTATICSTATICSTATICSTAT";
  function reqWith(token: string): IncomingMessage {
    return { headers: { authorization: `Bearer ${token}` } } as IncomingMessage;
  }

  it("the inverse-isolation guard: deleting the token → invalid_token (NOT a fall-through to global)", async () => {
    const store = new TokenStore(storePath);
    await store.load();
    const { access_token } = await store.mint({
      client_id: "c1",
      bound_workspace: "ws-A",
    });
    const lookup = (
      t: string,
    ): { bound_workspace: string | null; granularity: null } | null => {
      const b = store.lookup(t);
      return b === null
        ? null
        : { bound_workspace: b.bound_workspace, granularity: null };
    };

    // Before revoke: the token authenticates, bound to ws-A (T-P3-005: the
    // binding now carries a default granularity, null here).
    const before = authenticate(reqWith(access_token), STATIC_BEARER, lookup);
    expect(before.ok).toBe(true);
    if (before.ok) {
      expect(before.binding).toEqual({
        kind: "bound",
        workspace: "ws-A",
        granularity: null,
      });
    }

    // Revoke (unbind), then present the SAME token again.
    await store.revokeByWorkspace("ws-A");
    const after = authenticate(reqWith(access_token), STATIC_BEARER, lookup);

    // CRITICAL: rejected — must NOT be {kind:"unconstrained"} (that would be
    // an UPGRADE to global access on revocation — the inverse-isolation trap).
    expect(after).toEqual({ ok: false, reason: "invalid_token" });
  });
});

describe("TokenStore file permissions (Unix)", () => {
  it("tokens.json is written 0o600 on Unix", async () => {
    if (process.platform === "win32") return; // CC-3: no-op on Windows
    const store = new TokenStore(storePath);
    await store.load();
    await store.mint({ client_id: "c", bound_workspace: "w" });
    const s = await stat(storePath);
    expect(s.mode & 0o777).toBe(0o600);
  });
});

// P3′-4: the captured-set mechanism that makes a takeover install-then-revoke
// safe (revoke EXACTLY the old set, never the freshly-minted token).
describe("TokenStore.tokenHashesForWorkspace / revokeByTokenHashes (P3′-4 captured set)", () => {
  it("captures the active hashes for a workspace and revokes exactly that set", async () => {
    const store = new TokenStore(storePath);
    await store.load();
    const a = await store.mint({ client_id: "c1", bound_workspace: "ws-A" });
    const b = await store.mint({ client_id: "c2", bound_workspace: "ws-B" });

    const captured = store.tokenHashesForWorkspace("ws-A");
    expect(captured).toHaveLength(1);

    // Simulate the takeover: a NEW token for ws-A is minted AFTER capture …
    const a2 = await store.mint({ client_id: "c1", bound_workspace: "ws-A" });
    // … then revoke exactly the captured (old) set.
    const removed = await store.revokeByTokenHashes(captured);
    expect(removed).toBe(1);

    expect(store.lookup(a.access_token)).toBeNull(); // old A revoked
    expect(store.lookup(a2.access_token)?.bound_workspace).toBe("ws-A"); // new A survives (never in captured set)
    expect(store.lookup(b.access_token)?.bound_workspace).toBe("ws-B"); // B untouched
  });

  it("revokeByTokenHashes([]) is a no-op (the fresh-bind case)", async () => {
    const store = new TokenStore(storePath);
    await store.load();
    const a = await store.mint({ client_id: "c", bound_workspace: "ws" });
    expect(await store.revokeByTokenHashes([])).toBe(0);
    expect(store.lookup(a.access_token)?.bound_workspace).toBe("ws");
  });

  it("takeoverDisclosureFor returns the old binding's record, or null when unbound", async () => {
    const store = new TokenStore(storePath);
    await store.load();
    await store.mint({ client_id: "cb_client_old", bound_workspace: "ws-A" });
    const d = store.takeoverDisclosureFor("ws-A");
    expect(d?.client_id).toBe("cb_client_old");
    expect(typeof d?.issued_at).toBe("string");
    expect(typeof d?.expires_at).toBe("number");
    expect(store.takeoverDisclosureFor("ws-unbound")).toBeNull();
  });
});

// P3′-5: the "Set approval mode" switch persists the binding-default granularity.
describe("TokenStore.setGranularityForWorkspace / granularityForWorkspace (P3′-5)", () => {
  it("sets the granularity for a workspace's active tokens and survives reload", async () => {
    const store = new TokenStore(storePath);
    await store.load();
    await store.mint({ client_id: "c", bound_workspace: "ws-A", granularity: "per_call" });
    await store.mint({ client_id: "c", bound_workspace: "ws-B", granularity: "per_call" });

    const updated = await store.setGranularityForWorkspace("ws-A", "task");
    expect(updated).toBe(1);
    expect(store.granularityForWorkspace("ws-A")).toBe("task"); // changed
    expect(store.granularityForWorkspace("ws-B")).toBe("per_call"); // other ws untouched

    // Persisted to disk: a fresh store sees the change.
    const reload = new TokenStore(storePath);
    await reload.load();
    expect(reload.granularityForWorkspace("ws-A")).toBe("task");
  });

  it("granularityForWorkspace is null for an unbound workspace; set is a 0 no-op", async () => {
    const store = new TokenStore(storePath);
    await store.load();
    expect(store.granularityForWorkspace("ws-none")).toBeNull();
    expect(await store.setGranularityForWorkspace("ws-none", "auto")).toBe(0);
  });
});

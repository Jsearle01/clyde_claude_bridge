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

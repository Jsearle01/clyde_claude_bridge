// T-P3-001: unit tests for the OAuth DCR clients store. Covers Decision a
// (bcryptjs round-trip + no-plaintext-at-rest), Decision b (prefix + size),
// load/save shape parity with workspaces.json, daemon-restart persistence,
// CC-3 file permissions on Unix.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClientsStore,
  ClientsStoreVersionUnsupportedError,
  generateClientId,
  generateClientSecret,
} from "../../src/oauth/clients-store.js";

let tempDir: string;
let storePath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cb-clients-store-"));
  storePath = join(tempDir, "clients.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("generateClientId / generateClientSecret (T-P3-001 Decision b)", () => {
  it("client_id starts with cb_client_ prefix", () => {
    expect(generateClientId().startsWith("cb_client_")).toBe(true);
  });

  it("client_id has hex suffix of expected length (16 bytes = 32 hex chars)", () => {
    const id = generateClientId();
    const suffix = id.slice("cb_client_".length);
    expect(suffix).toMatch(/^[a-f0-9]{32}$/);
  });

  it("client_secret is 32 random bytes = 64 hex chars", () => {
    expect(generateClientSecret()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("client_id values are distinct across calls", () => {
    expect(generateClientId()).not.toBe(generateClientId());
  });

  it("client_secret values are distinct across calls", () => {
    expect(generateClientSecret()).not.toBe(generateClientSecret());
  });
});

describe("ClientsStore — load + persistence", () => {
  it("load() against nonexistent file initializes empty store; no file written", async () => {
    const store = new ClientsStore(storePath);
    await store.load();
    expect(store.list()).toEqual([]);
    await expect(stat(storePath)).rejects.toThrow();
  });

  it("addClient persists a record with bcryptjs-hashed secret; returns plaintext once", async () => {
    const store = new ClientsStore(storePath);
    await store.load();
    const { record, client_secret_plaintext } = await store.addClient({
      client_name: "Test Client",
      redirect_uris: ["https://example.com/callback"],
    });

    expect(record.client_id.startsWith("cb_client_")).toBe(true);
    expect(record.client_name).toBe("Test Client");
    expect(record.redirect_uris).toEqual(["https://example.com/callback"]);
    expect(typeof record.created_at).toBe("string");
    // bcryptjs hash shape: $2a$ or $2b$ prefix
    expect(record.client_secret_hash).toMatch(/^\$2[ab]\$/);
    // Returned plaintext is 64 hex chars per Decision b
    expect(client_secret_plaintext).toMatch(/^[a-f0-9]{64}$/);
  });

  it("plaintext secret is NEVER persisted at rest (file content has only the hash)", async () => {
    const store = new ClientsStore(storePath);
    await store.load();
    const { client_secret_plaintext } = await store.addClient({
      client_name: "X",
      redirect_uris: ["https://x.test/cb"],
    });
    const raw = await readFile(storePath, "utf8");
    expect(raw).not.toContain(client_secret_plaintext);
    // And the hash is present
    expect(raw).toContain("$2");
  });

  it("addClient writes parent dir if absent (parity with workspaces store)", async () => {
    const nested = join(tempDir, "deep", "nested", "clients.json");
    const store = new ClientsStore(nested);
    await store.load();
    await store.addClient({
      client_name: "X",
      redirect_uris: ["https://x.test/cb"],
    });
    const raw = await readFile(nested, "utf8");
    const parsed = JSON.parse(raw) as { version: string; clients: unknown[] };
    expect(parsed.version).toBe("1");
    expect(parsed.clients).toHaveLength(1);
  });

  it("file mode is 0o600 on Unix (CC-3 file permissions discipline)", async () => {
    if (process.platform === "win32") return; // mode bits not enforced on Windows (CC-3)
    const store = new ClientsStore(storePath);
    await store.load();
    await store.addClient({
      client_name: "X",
      redirect_uris: ["https://x.test/cb"],
    });
    const s = await stat(storePath);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("findByClientId returns the stored record; null when missing", async () => {
    const store = new ClientsStore(storePath);
    await store.load();
    const { record } = await store.addClient({
      client_name: "X",
      redirect_uris: ["https://x.test/cb"],
    });
    expect(store.findByClientId(record.client_id)).toEqual(record);
    expect(store.findByClientId("cb_client_unknown")).toBeNull();
  });

  it("verifyClientSecret round-trips: bcrypt.compare matches plaintext against stored hash", async () => {
    const store = new ClientsStore(storePath);
    await store.load();
    const { record, client_secret_plaintext } = await store.addClient({
      client_name: "X",
      redirect_uris: ["https://x.test/cb"],
    });

    expect(
      await store.verifyClientSecret(record.client_id, client_secret_plaintext),
    ).toBe(true);
    expect(
      await store.verifyClientSecret(record.client_id, "not the secret"),
    ).toBe(false);
    expect(
      await store.verifyClientSecret("cb_client_unknown", client_secret_plaintext),
    ).toBe(false);
  });

  it("daemon-restart persistence: a fresh store loads existing entries", async () => {
    // Round 1: register two clients, then "shut down" (drop the instance).
    const round1 = new ClientsStore(storePath);
    await round1.load();
    const { client_secret_plaintext: secret1 } = await round1.addClient({
      client_name: "Alice",
      redirect_uris: ["https://alice.test/cb"],
    });
    await round1.addClient({
      client_name: "Bob",
      redirect_uris: ["https://bob.test/cb"],
    });

    // Round 2: fresh instance, load() reads from disk.
    const round2 = new ClientsStore(storePath);
    await round2.load();
    expect(round2.list()).toHaveLength(2);
    const alice = round2
      .list()
      .find((c) => c.client_name === "Alice");
    expect(alice).toBeDefined();
    // The hash survived the restart — verify against the original plaintext
    // via the store's verifyClientSecret accessor (round-trips through
    // bcrypt.compare under the hood; same proof, no untyped bcrypt import).
    if (alice !== undefined) {
      expect(
        await round2.verifyClientSecret(alice.client_id, secret1),
      ).toBe(true);
    }
  });

  it("rejects an unsupported version on load (forces explicit migration)", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      storePath,
      JSON.stringify({ version: "2", clients: [] }),
    );
    const store = new ClientsStore(storePath);
    await expect(store.load()).rejects.toThrow(
      ClientsStoreVersionUnsupportedError,
    );
  });

  it("rejects a malformed entry on load (zod surface)", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      storePath,
      JSON.stringify({
        version: "1",
        clients: [{ bogus: "shape" }],
      }),
    );
    const store = new ClientsStore(storePath);
    await expect(store.load()).rejects.toThrow();
  });
});

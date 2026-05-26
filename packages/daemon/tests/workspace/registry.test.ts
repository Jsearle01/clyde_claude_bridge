// T-P2-007: WorkspaceRegistryImpl tests. Replaces T-P1-002's stub-registry
// tests; semantics shifted (resolve(undefined) → null; default() → null
// always; list() reads from persistent store). Includes the daemon-restart-
// against-pre-populated-store integration test that closes C-23 (the
// latent gap from T-P2-003).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceRegistryImpl } from "../../src/workspace/registry.js";
import { WorkspacesStore } from "../../src/workspace/store.js";
import type { ActiveRegistration } from "../../src/ipc/server.js";

let tempDir: string;
let storePath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-registry-"));
  storePath = join(tempDir, "workspaces.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// Empty getter for tests that don't exercise the active-registry path.
const emptyActiveRegistry = (): ReadonlyMap<string, ActiveRegistration> =>
  new Map();

describe("WorkspaceRegistryImpl — empty store (T-P2-007)", () => {
  it("resolve(undefined) returns null", async () => {
    const store = new WorkspacesStore(storePath);
    await store.load();
    const r = new WorkspaceRegistryImpl(store, emptyActiveRegistry);
    expect(r.resolve()).toBeNull();
  });

  it("resolve('any-id') returns null when store is empty", async () => {
    const store = new WorkspacesStore(storePath);
    await store.load();
    const r = new WorkspaceRegistryImpl(store, emptyActiveRegistry);
    expect(r.resolve("anything")).toBeNull();
  });

  it("list() returns empty array", async () => {
    const store = new WorkspacesStore(storePath);
    await store.load();
    const r = new WorkspaceRegistryImpl(store, emptyActiveRegistry);
    expect(r.list()).toEqual([]);
  });

  it("default() returns null in P2 (no default workspace concept)", async () => {
    const store = new WorkspacesStore(storePath);
    await store.load();
    const r = new WorkspaceRegistryImpl(store, emptyActiveRegistry);
    expect(r.default()).toBeNull();
  });
});

describe("WorkspaceRegistryImpl — populated store (T-P2-007)", () => {
  it("resolve('known-identifier') returns Workspace with default_mode 'agentic'", async () => {
    const store = new WorkspacesStore(storePath);
    await store.load();
    await store.addTrustedEntry({
      abs_path: "/projects/my-repo",
      identifier: "my-repo-aaaaaa",
      name: "My Repo",
    });
    const r = new WorkspaceRegistryImpl(store, emptyActiveRegistry);
    const result = r.resolve("my-repo-aaaaaa");
    expect(result).toEqual({
      id: "my-repo-aaaaaa",
      abs_path: "/projects/my-repo",
      default_mode: "agentic",
    });
  });

  it("resolve('unknown-id') returns null even when other entries exist", async () => {
    const store = new WorkspacesStore(storePath);
    await store.load();
    await store.addTrustedEntry({
      abs_path: "/projects/my-repo",
      identifier: "my-repo-aaaaaa",
      name: "My Repo",
    });
    const r = new WorkspaceRegistryImpl(store, emptyActiveRegistry);
    expect(r.resolve("not-present-xxxxxx")).toBeNull();
  });

  it("list() returns all trusted workspaces", async () => {
    const store = new WorkspacesStore(storePath);
    await store.load();
    await store.addTrustedEntry({
      abs_path: "/projects/a",
      identifier: "a-aaaaaa",
      name: "A",
    });
    await store.addTrustedEntry({
      abs_path: "/projects/b",
      identifier: "b-bbbbbb",
      name: "B",
    });
    const r = new WorkspaceRegistryImpl(store, emptyActiveRegistry);
    const all = r.list();
    expect(all).toHaveLength(2);
    expect(all.map((w) => w.id).sort()).toEqual(["a-aaaaaa", "b-bbbbbb"]);
    expect(all.every((w) => w.default_mode === "agentic")).toBe(true);
  });

  it("default() returns null even with populated entries (no default in P2)", async () => {
    const store = new WorkspacesStore(storePath);
    await store.load();
    await store.addTrustedEntry({
      abs_path: "/projects/my-repo",
      identifier: "my-repo-aaaaaa",
      name: "My Repo",
    });
    const r = new WorkspaceRegistryImpl(store, emptyActiveRegistry);
    expect(r.default()).toBeNull();
  });

  it("resolve() ignores active-registry connection state (trust persists across daemon restart)", async () => {
    const store = new WorkspacesStore(storePath);
    await store.load();
    await store.addTrustedEntry({
      abs_path: "/projects/my-repo",
      identifier: "my-repo-aaaaaa",
      name: "My Repo",
    });
    // Active registry is empty (workspace is "offline"). resolve() must
    // still return the entry — trust persists, activeness is ephemeral.
    const r = new WorkspaceRegistryImpl(store, emptyActiveRegistry);
    expect(r.resolve("my-repo-aaaaaa")).not.toBeNull();
  });
});

// AC-12: integration test for daemon-restart-against-pre-populated-store.
// Closes C-23 (the latent T-P2-003 gap surfaced at T-P2-006 manual
// verification: daemon's registry showed workspace_count: 0 on every
// startup despite the on-disk store).
describe("WorkspaceRegistryImpl — daemon restart against pre-populated store (T-P2-007 / C-23)", () => {
  it("a fresh registry built against a pre-populated store resolves entries immediately without registration", async () => {
    // First "session": populate the store.
    {
      const store = new WorkspacesStore(storePath);
      await store.load();
      await store.addTrustedEntry({
        abs_path: "/projects/persistent-repo",
        identifier: "persistent-repo-cccccc",
        name: "Persistent Repo",
      });
    }
    // Second "session" (simulates daemon restart): a fresh store + fresh
    // registry constructed against the same on-disk file. No registration
    // step. The previously-trusted entry must be immediately resolvable.
    const freshStore = new WorkspacesStore(storePath);
    await freshStore.load();
    const r = new WorkspaceRegistryImpl(freshStore, emptyActiveRegistry);
    const result = r.resolve("persistent-repo-cccccc");
    expect(result).not.toBeNull();
    expect(result?.id).toBe("persistent-repo-cccccc");
    expect(result?.abs_path).toBe("/projects/persistent-repo");
    expect(r.list()).toHaveLength(1);
  });
});

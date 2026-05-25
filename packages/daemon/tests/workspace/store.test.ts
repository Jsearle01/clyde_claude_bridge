import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspacesStore,
  WorkspacesStoreVersionUnsupportedError,
} from "../../src/workspace/store.js";

let tempDir: string;
let storePath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-store-"));
  storePath = join(tempDir, "workspaces.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("WorkspacesStore (T-P2-003)", () => {
  it("load() against nonexistent file initializes empty store; no file written", async () => {
    const store = new WorkspacesStore(storePath);
    await store.load();
    expect(store.list()).toEqual([]);
    await expect(stat(storePath)).rejects.toThrow();
  });

  it("addTrustedEntry writes file with correct schema and parent dir created", async () => {
    const nested = join(tempDir, "deep", "nested", "workspaces.json");
    const store = new WorkspacesStore(nested);
    await store.load();
    const entry = await store.addTrustedEntry({
      abs_path: "/some/path",
      identifier: "test-abc123",
      name: "Some Path",
    });
    expect(entry.trust_state).toBe("trusted");
    expect(typeof entry.trusted_at).toBe("string");
    const raw = await readFile(nested, "utf8");
    const parsed = JSON.parse(raw) as { version: string; entries: unknown[] };
    expect(parsed.version).toBe("1");
    expect(parsed.entries).toHaveLength(1);
  });

  it("file mode is 0o600 on Unix", async () => {
    if (process.platform === "win32") return; // mode bits not enforced on Windows (CC-3)
    const store = new WorkspacesStore(storePath);
    await store.load();
    await store.addTrustedEntry({
      abs_path: "/some/path",
      identifier: "test-abc123",
      name: "Some Path",
    });
    const s = await stat(storePath);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("findByPath and findByIdentifier return correct entries", async () => {
    const store = new WorkspacesStore(storePath);
    await store.load();
    const entry = await store.addTrustedEntry({
      abs_path: "/some/path",
      identifier: "test-abc123",
      name: "Some Path",
    });
    expect(store.findByPath("/some/path")).toEqual(entry);
    expect(store.findByIdentifier("test-abc123")).toEqual(entry);
    expect(store.findByPath("/other")).toBeNull();
    expect(store.findByIdentifier("missing-xxxxxx")).toBeNull();
  });

  it("loading existing valid file populates entries", async () => {
    await writeFile(
      storePath,
      JSON.stringify(
        {
          version: "1",
          entries: [
            {
              abs_path: "/p1",
              identifier: "p1-aaaaaa",
              name: "P1",
              trust_state: "trusted",
              trusted_at: "2026-05-24T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
    );
    const store = new WorkspacesStore(storePath);
    await store.load();
    expect(store.list()).toHaveLength(1);
    expect(store.findByIdentifier("p1-aaaaaa")?.name).toBe("P1");
  });

  it("loading file with version='2' throws WorkspacesStoreVersionUnsupportedError", async () => {
    await writeFile(
      storePath,
      JSON.stringify({ version: "2", entries: [] }),
    );
    const store = new WorkspacesStore(storePath);
    await expect(store.load()).rejects.toThrow(
      WorkspacesStoreVersionUnsupportedError,
    );
  });

  it("loading file with invalid schema propagates Zod error", async () => {
    await writeFile(
      storePath,
      JSON.stringify({ version: "1", entries: [{ bogus: "shape" }] }),
    );
    const store = new WorkspacesStore(storePath);
    await expect(store.load()).rejects.toThrow();
  });
});

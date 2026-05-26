import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspacesStore,
  WorkspacesStoreVersionUnsupportedError,
} from "../../src/workspace/store.js";
import type { Logger } from "../../src/log/logger.js";

let tempDir: string;
let storePath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-store-"));
  storePath = join(tempDir, "workspaces.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const ORIGINAL_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}
function restorePlatform(): void {
  Object.defineProperty(process, "platform", {
    value: ORIGINAL_PLATFORM,
    configurable: true,
  });
}

interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  extra?: Record<string, unknown>;
}
function makeRecordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger: Logger = {
    debug: (msg, extra) => entries.push({ level: "debug", msg, extra }),
    info: (msg, extra) => entries.push({ level: "info", msg, extra }),
    warn: (msg, extra) => entries.push({ level: "warn", msg, extra }),
    error: (msg, extra) => entries.push({ level: "error", msg, extra }),
    close: () => Promise.resolve(),
  };
  return { logger, entries };
}

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

describe("WorkspacesStore — Windows path case-insensitivity (T-P2-007.5)", () => {
  afterEach(() => {
    restorePlatform();
  });

  it("findByPath matches case-variant query on Windows", async () => {
    setPlatform("win32");
    const store = new WorkspacesStore(storePath);
    await store.load();
    const entry = await store.addTrustedEntry({
      abs_path: "C:\\Projects\\X",
      identifier: "x-aaaaaa",
      name: "X",
    });
    expect(store.findByPath("c:\\projects\\x")).toEqual(entry);
    expect(store.findByPath("C:\\PROJECTS\\X")).toEqual(entry);
    expect(store.findByPath("C:\\Projects\\X")).toEqual(entry);
  });

  it("stored abs_path preserves original case (no in-place rewrite)", async () => {
    setPlatform("win32");
    const store = new WorkspacesStore(storePath);
    await store.load();
    await store.addTrustedEntry({
      abs_path: "C:\\Projects\\X",
      identifier: "x-aaaaaa",
      name: "X",
    });
    // Even after a lookup with a different case, the stored value is unchanged.
    void store.findByPath("c:\\projects\\x");
    const found = store.findByPath("c:\\projects\\x");
    expect(found?.abs_path).toBe("C:\\Projects\\X");
  });

  it("findByPath is case-sensitive on Unix", async () => {
    setPlatform("linux");
    const store = new WorkspacesStore(storePath);
    await store.load();
    const entry = await store.addTrustedEntry({
      abs_path: "/home/user/Project",
      identifier: "p-aaaaaa",
      name: "Project",
    });
    expect(store.findByPath("/home/user/Project")).toEqual(entry);
    expect(store.findByPath("/home/user/project")).toBeNull();
  });

  it("loading workspaces.json with case-variant duplicates dedupes by earliest trusted_at", async () => {
    setPlatform("win32");
    await writeFile(
      storePath,
      JSON.stringify({
        version: "1",
        entries: [
          {
            abs_path: "C:\\Projects\\X",
            identifier: "x-canonical",
            name: "X",
            trust_state: "trusted",
            trusted_at: "2026-05-20T00:00:00.000Z",
          },
          {
            abs_path: "c:\\projects\\x",
            identifier: "x-duplicate",
            name: "X",
            trust_state: "trusted",
            trusted_at: "2026-05-24T00:00:00.000Z",
          },
        ],
      }),
    );
    const { logger, entries } = makeRecordingLogger();
    const store = new WorkspacesStore(storePath, logger);
    await store.load();

    expect(store.list()).toHaveLength(1);
    const remaining = store.list()[0];
    expect(remaining?.identifier).toBe("x-canonical");
    expect(remaining?.abs_path).toBe("C:\\Projects\\X");

    const warn = entries.find((e) => e.level === "warn");
    expect(warn?.msg).toBe("workspaces.json dedupe: removed duplicate entry");
    expect(warn?.extra).toMatchObject({
      abs_path: "c:\\projects\\x",
      identifier: "x-duplicate",
      trusted_at: "2026-05-24T00:00:00.000Z",
      retained_identifier: "x-canonical",
    });
  });

  it("dedupe rewrites workspaces.json to canonical (deduped) state on disk", async () => {
    setPlatform("win32");
    await writeFile(
      storePath,
      JSON.stringify({
        version: "1",
        entries: [
          {
            abs_path: "C:\\Projects\\X",
            identifier: "x-canonical",
            name: "X",
            trust_state: "trusted",
            trusted_at: "2026-05-20T00:00:00.000Z",
          },
          {
            abs_path: "c:\\projects\\x",
            identifier: "x-duplicate",
            name: "X",
            trust_state: "trusted",
            trusted_at: "2026-05-24T00:00:00.000Z",
          },
        ],
      }),
    );
    const store = new WorkspacesStore(storePath);
    await store.load();

    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as {
      version: string;
      entries: { identifier: string; abs_path: string }[];
    };
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.identifier).toBe("x-canonical");
    expect(parsed.entries[0]?.abs_path).toBe("C:\\Projects\\X");
  });

  it("no-op when no duplicates exist (no warn logs, no extra file rewrite)", async () => {
    setPlatform("linux");
    await writeFile(
      storePath,
      JSON.stringify({
        version: "1",
        entries: [
          {
            abs_path: "/home/user/A",
            identifier: "a-aaaaaa",
            name: "A",
            trust_state: "trusted",
            trusted_at: "2026-05-20T00:00:00.000Z",
          },
          {
            abs_path: "/home/user/B",
            identifier: "b-bbbbbb",
            name: "B",
            trust_state: "trusted",
            trusted_at: "2026-05-21T00:00:00.000Z",
          },
        ],
      }),
    );
    const statBefore = await stat(storePath);
    const { logger, entries } = makeRecordingLogger();
    const store = new WorkspacesStore(storePath, logger);
    await store.load();

    expect(store.list()).toHaveLength(2);
    expect(entries.filter((e) => e.level === "warn")).toHaveLength(0);
    const statAfter = await stat(storePath);
    // mtimeMs equality is the cheapest proxy for "no rewrite happened".
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });

  it("dedupe retains earliest trusted_at when three case-variants collide", async () => {
    setPlatform("win32");
    await writeFile(
      storePath,
      JSON.stringify({
        version: "1",
        entries: [
          {
            abs_path: "C:\\X",
            identifier: "newest",
            name: "X",
            trust_state: "trusted",
            trusted_at: "2026-05-24T00:00:00.000Z",
          },
          {
            abs_path: "c:\\x",
            identifier: "earliest",
            name: "X",
            trust_state: "trusted",
            trusted_at: "2026-05-20T00:00:00.000Z",
          },
          {
            abs_path: "C:\\X",
            identifier: "middle",
            name: "X",
            trust_state: "trusted",
            trusted_at: "2026-05-22T00:00:00.000Z",
          },
        ],
      }),
    );
    const { logger, entries } = makeRecordingLogger();
    const store = new WorkspacesStore(storePath, logger);
    await store.load();

    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.identifier).toBe("earliest");
    expect(entries.filter((e) => e.level === "warn")).toHaveLength(2);
  });
});

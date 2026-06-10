// T-CLI-2: `list` read-only inventory + handshake liveness.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatConfigDirList } from "../../src/commands/list.js";
import {
  enumerateConfigDirs,
  type ConfigDirEntry,
} from "../../src/util/config-dirs.js";

describe("formatConfigDirList (T-CLI-2)", () => {
  it("AC-C2-1: renders name/workspace/hash + live or dead", () => {
    const entries: ConfigDirEntry[] = [
      { hash: "a".repeat(16), configDir: "/cfg/a", workspace: "c:\\ws\\a", name: "alpha", live: true },
      { hash: "b".repeat(16), configDir: "/cfg/b", workspace: "c:\\ws\\b", name: "beta", live: false },
    ];
    const out = formatConfigDirList(entries);
    expect(out).toContain("alpha");
    expect(out).toContain("[live]");
    expect(out).toContain("c:\\ws\\a");
    expect(out).toContain("beta");
    expect(out).toContain("[dead]");
  });

  it("empty inventory → a clear no-dirs line", () => {
    expect(formatConfigDirList([])).toContain("No daemon config directories.");
  });
});

describe("enumerateConfigDirs (T-CLI-2)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cb-list-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  async function makeDir(hash: string, name: string, ws: string): Promise<void> {
    const dir = join(root, hash);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "workspaces.json"),
      JSON.stringify({ version: "1", workspaces: [{ abs_path: ws, name }] }),
    );
  }

  it("reads workspace/name from workspaces.json + liveness from the probe; skips non-hash entries", async () => {
    await makeDir("a".repeat(16), "alpha", "c:\\ws\\a");
    await makeDir("b".repeat(16), "beta", "c:\\ws\\b");
    await mkdir(join(root, "daemons"), { recursive: true }); // not a hash → skipped
    await writeFile(join(root, "config.json"), "{}"); // flat file → skipped

    // probe: alpha live, beta dead.
    const entries = await enumerateConfigDirs({
      configRoot: root,
      probe: (e) => Promise.resolve(e.hash === "a".repeat(16)),
    });
    expect(entries.map((e) => e.name)).toEqual(["alpha", "beta"]); // sorted, hash dirs only
    expect(entries.find((e) => e.name === "alpha")?.live).toBe(true);
    expect(entries.find((e) => e.name === "beta")?.live).toBe(false);
    expect(entries.find((e) => e.name === "alpha")?.workspace).toBe("c:\\ws\\a");
  });
});

// T-CLI-4c: `directories` — spare path-printing surface (verify-before-prune).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatDirectories,
  directoriesCommand,
} from "../../src/commands/directories.js";
import { renderDaemonList, type ConfigDirEntry } from "../../src/util/config-dirs.js";

const named: ConfigDirEntry = {
  hash: "135cfaa3d11a768c",
  configDir: "C:\\Users\\x\\AppData\\Roaming\\claude-bridge\\135cfaa3d11a768c",
  name: "clyde_claude_bridge",
  workspace: "c:\\Projects\\clyde_claude_bridge",
  live: true,
  mtime: new Date("2026-06-08T00:00:00.000Z"),
};
const orphan: ConfigDirEntry = {
  hash: "2d7c6310c46c5916",
  configDir: "C:\\Users\\x\\AppData\\Roaming\\claude-bridge\\2d7c6310c46c5916",
  name: null,
  workspace: null,
  live: false,
  mtime: new Date("2026-06-01T00:00:00.000Z"),
};

describe("formatDirectories (T-CLI-4c spare formatter)", () => {
  it("AC-4c-1: prints the config-dir PATH + identity + live/dead per entry", () => {
    const out = formatDirectories([named]);
    expect(out).toContain(named.configDir); // the path — the point of the command
    expect(out).toContain("clyde_claude_bridge"); // identity
    expect(out).toContain("[live]"); // liveness
  });

  it("AC-4c-3: an orphan (no workspaces.json → null name) shows its PATH + hash + dead", () => {
    const out = formatDirectories([orphan]);
    expect(out).toContain(orphan.configDir); // locatable on disk
    expect(out).toContain("2d7c6310c46c5916"); // hash stands in for the missing name
    expect(out).toContain("[dead]"); // the prune-candidate signal
  });

  it("AC-4c-2: SPARE — not the busy renderDaemonList (no workspace, no mtime)", () => {
    const out = formatDirectories([named]);
    expect(out).not.toContain("c:\\Projects\\clyde_claude_bridge"); // no workspace path
    expect(out).not.toContain("last-modified"); // no mtime
    // and it genuinely differs from the dense renderer:
    expect(out).not.toEqual(renderDaemonList([named]));
  });

  it("empty → a clear no-dirs line", () => {
    expect(formatDirectories([])).toContain("No daemon config directories.");
  });
});

describe("directoriesCommand (T-CLI-4c — shares the unified enumeration, read-only)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cb-dirs-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  async function makeDir(hash: string, name: string | null): Promise<void> {
    const d = join(root, hash);
    await mkdir(d, { recursive: true });
    if (name !== null) {
      await writeFile(
        join(d, "workspaces.json"),
        JSON.stringify({ version: "1", entries: [{ abs_path: `c:\\ws\\${name}`, name }] }),
      );
    }
  }

  it("AC-4c-4: routes through enumerateConfigDirs (the unified source) — real config-dir paths", async () => {
    await makeDir("a".repeat(16), "alpha");
    await makeDir("d".repeat(16), null); // orphan: no workspaces.json
    let captured = "";
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((s) => {
        captured += String(s);
        return true;
      });
    try {
      await directoriesCommand({ configRoot: root, probe: () => Promise.resolve(false) });
    } finally {
      spy.mockRestore();
    }
    expect(captured).toContain(join(root, "a".repeat(16))); // alpha's real path
    expect(captured).toContain("alpha");
    expect(captured).toContain(join(root, "d".repeat(16))); // the orphan's real path
    expect(captured).toContain("d".repeat(16)); // hash stands in for the orphan
    expect(captured).toContain("[dead]");
  });
});

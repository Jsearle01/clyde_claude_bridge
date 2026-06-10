// T-CLI-2: `list` read-only inventory + handshake liveness.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatConfigDirList } from "../../src/commands/list.js";
import {
  enumerateConfigDirs,
  renderDaemonList,
  type ConfigDirEntry,
} from "../../src/util/config-dirs.js";

describe("renderDaemonList (T-CLI-4a — the single shared renderer)", () => {
  const liveEntry: ConfigDirEntry = {
    hash: "a".repeat(16),
    configDir: "/cfg/a",
    name: "alpha",
    workspace: "c:\\ws\\a",
    live: true,
    mtime: new Date("2026-06-08T00:00:00.000Z"),
  };
  const betaEntry: ConfigDirEntry = {
    ...liveEntry,
    hash: "b".repeat(16),
    name: "beta",
    workspace: "c:\\ws\\b",
  };
  const orphan: ConfigDirEntry = {
    hash: "2d7c6310c46c5916",
    configDir: "/cfg/o",
    name: null,
    workspace: null,
    live: false,
    mtime: new Date("2026-06-01T00:00:00.000Z"),
  };

  it("AC-4a-1/2: renders name + workspace + hash + live consistently", () => {
    const out = renderDaemonList([liveEntry]);
    expect(out).toContain("alpha");
    expect(out).toContain("[live]");
    expect(out).toContain("c:\\ws\\a");
    expect(out).toContain("a".repeat(16));
  });

  it("AC-4a-3: an orphan (no identity) renders (unnamed) + hash + mtime — still recognisable", () => {
    const out = renderDaemonList([orphan]);
    expect(out).toContain("(unnamed)");
    expect(out).toContain("[dead]");
    expect(out).toContain("2d7c6310c46c5916");
    expect(out).toContain("last-modified 2026-06-01");
  });

  it("AC-4a-5: numbered mode renders the pick's [N] lines (the surface defaultPickNumber writes)", () => {
    const out = renderDaemonList([liveEntry, betaEntry], { numbered: true });
    expect(out).toContain("[1] alpha");
    expect(out).toContain("[2] beta");
    expect(out).toContain("c:\\ws\\b");
  });

  it("AC-4a-4: TTY pick + non-TTY error render the SAME identifying info (both via this renderer)", () => {
    const entries = [liveEntry];
    const picked = renderDaemonList(entries, { numbered: true }); // the TTY pick
    const errored = renderDaemonList(entries); // the non-TTY AmbiguousDaemonError
    for (const frag of ["alpha", "c:\\ws\\a", "a".repeat(16)]) {
      expect(picked).toContain(frag);
      expect(errored).toContain(frag);
    }
  });
});

describe("formatConfigDirList (T-CLI-2)", () => {
  it("AC-C2-1: renders name/workspace/hash + live or dead", () => {
    const entries: ConfigDirEntry[] = [
      { hash: "a".repeat(16), configDir: "/cfg/a", workspace: "c:\\ws\\a", name: "alpha", live: true, mtime: null },
      { hash: "b".repeat(16), configDir: "/cfg/b", workspace: "c:\\ws\\b", name: "beta", live: false, mtime: null },
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
      // The REAL WorkspacesStore shape — `entries`, not `workspaces`.
      JSON.stringify({ version: "1", entries: [{ abs_path: ws, name }] }),
    );
  }

  it("reads workspace/name from workspaces.json (entries) + liveness from the probe; skips non-hash entries", async () => {
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

  it("AC-C3-1: the RENDERED list output (not the data) shows workspace + name per entry", async () => {
    await makeDir("a".repeat(16), "alpha", "c:\\Projects\\alpha");
    const entries = await enumerateConfigDirs({
      configRoot: root,
      probe: () => Promise.resolve(false),
    });
    // Assert the SURFACE a human reads — the defect-1 lesson.
    const rendered = formatConfigDirList(entries);
    expect(rendered).toContain("alpha"); // name
    expect(rendered).toContain("c:\\Projects\\alpha"); // workspace
    expect(rendered).not.toContain("(unknown workspace)"); // the bug's tell
    expect(rendered).not.toContain("(unnamed)");
  });
});

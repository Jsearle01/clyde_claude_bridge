// T-CLI-1/4a: the unified daemon selector — --name resolution + the §2 asymmetric
// default (act-on-sole / pick / none). T-CLI-4a: enumerates the CONFIG-DIR layer
// (the same source `list` uses) + handshake liveness, not adverts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectDaemonTarget,
  enumerateAdverts,
  NoDaemonsRunningError,
  AmbiguousDaemonError,
  DaemonNameNotFoundError,
  InvalidDaemonPickError,
} from "../../src/util/selector.js";

const HASH_A = "a".repeat(16);
const HASH_B = "b".repeat(16);
const HASH_SOLO = "c".repeat(16);

function advertJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    canonical_workspace: "c:\\projects\\a",
    name: "alpha",
    pipe: "\\\\.\\pipe\\claude-bridge-aaaa",
    port: 7423,
    pid: 100,
    started_at: "2026-06-10T00:00:00.000Z",
    ...over,
  });
}

describe("selectDaemonTarget (T-CLI unified selector, config-dir source)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cb-selector-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  // Write a per-daemon CONFIG DIR (hash subdir + workspaces.json identity).
  async function writeDir(hash: string, name: string, ws: string): Promise<void> {
    const d = join(dir, hash);
    await mkdir(d, { recursive: true });
    await writeFile(
      join(d, "workspaces.json"),
      JSON.stringify({ version: "1", entries: [{ abs_path: ws, name }] }),
    );
  }
  const live = (): Promise<boolean> => Promise.resolve(true);
  const dead = (): Promise<boolean> => Promise.resolve(false);

  it("AC-C1-1: --name resolves to the matching daemon's address (by hash) + workspace", async () => {
    await writeDir(HASH_A, "alpha", "c:\\ws\\a");
    await writeDir(HASH_B, "beta", "c:\\ws\\b");
    const t = await selectDaemonTarget({ name: "beta", configRoot: dir, probe: live });
    expect(t.addressOverride).toContain(HASH_B); // per-daemon address by hash
    expect(t.workspace).toBe("c:\\ws\\b");
    expect(t.label).toBe("beta");
  });

  it("--name not found → DaemonNameNotFoundError (lists available)", async () => {
    await writeDir(HASH_A, "alpha", "c:\\ws\\a");
    await expect(
      selectDaemonTarget({ name: "ghost", configRoot: dir, probe: live }),
    ).rejects.toBeInstanceOf(DaemonNameNotFoundError);
  });

  it("asymmetric default — bare + exactly ONE LIVE → acts-on-sole", async () => {
    await writeDir(HASH_SOLO, "solo", "c:\\ws\\solo");
    const t = await selectDaemonTarget({ configRoot: dir, probe: live });
    expect(t.addressOverride).toContain(HASH_SOLO);
    expect(t.label).toBe("solo");
  });

  it("AC-C3-4: bare + MANY + NON-interactive (piped/CI) → error-and-list, never hangs / silently picks", async () => {
    await writeDir(HASH_A, "alpha", "c:\\ws\\a");
    await writeDir(HASH_B, "beta", "c:\\ws\\b");
    await expect(
      selectDaemonTarget({ configRoot: dir, probe: live, interactive: false }),
    ).rejects.toBeInstanceOf(AmbiguousDaemonError);
  });

  it("AC-C3-2: bare + MANY + interactive → numbered pick selects that daemon (sorted)", async () => {
    await writeDir(HASH_A, "alpha", "c:\\ws\\a");
    await writeDir(HASH_B, "beta", "c:\\ws\\b");
    const t = await selectDaemonTarget({
      configRoot: dir,
      probe: live,
      interactive: true,
      pickNumber: () => Promise.resolve(2), // alpha[1], beta[2]
    });
    expect(t.label).toBe("beta");
    expect(t.addressOverride).toContain(HASH_B);
  });

  it("an out-of-range pick → InvalidDaemonPickError (does not act)", async () => {
    await writeDir(HASH_A, "alpha", "c:\\ws\\a");
    await writeDir(HASH_B, "beta", "c:\\ws\\b");
    await expect(
      selectDaemonTarget({
        configRoot: dir,
        probe: live,
        interactive: true,
        pickNumber: () => Promise.resolve(9),
      }),
    ).rejects.toBeInstanceOf(InvalidDaemonPickError);
  });

  it("AC-4a-4: the non-TTY AmbiguousDaemonError renders name+workspace (same info as the pick, not names-only)", async () => {
    await writeDir(HASH_A, "alpha", "c:\\ws\\a");
    await writeDir(HASH_B, "beta", "c:\\ws\\b");
    await expect(
      selectDaemonTarget({ configRoot: dir, probe: live, interactive: false }),
    ).rejects.toThrowError(/alpha[\s\S]*c:\\ws\\a/); // workspace shown, not names-only
  });

  it("asymmetric default — bare + NONE LIVE (a dead dir present) → NoDaemonsRunningError", async () => {
    await writeDir(HASH_A, "alpha", "c:\\ws\\a"); // present but dead
    await expect(
      selectDaemonTarget({ configRoot: dir, probe: dead }),
    ).rejects.toBeInstanceOf(NoDaemonsRunningError);
  });

  it("--workspace targets directly (per-daemon address, no enumeration)", async () => {
    const t = await selectDaemonTarget({ workspace: "C:\\Projects\\X" });
    expect(t.workspace).toBe("C:\\Projects\\X");
    expect(t.addressOverride).toBeDefined();
    expect(t.pidPath).toContain("daemon.pid");
  });

  it("enumerateAdverts (still serves status's bare enumerate) skips unparseable + returns valid", async () => {
    await writeFile(join(dir, "good.json"), advertJson({ name: "good" }));
    await writeFile(join(dir, "broken.json"), "{ not json");
    await writeFile(join(dir, "ignore.txt"), advertJson());
    const adverts = await enumerateAdverts(dir);
    expect(adverts.map((a) => a.name)).toEqual(["good"]);
  });
});

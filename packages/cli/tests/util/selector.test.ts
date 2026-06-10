// T-CLI-1: the unified daemon selector — --name resolution + the §2 asymmetric
// default (act-on-sole / error-and-list / none), never the flat fallthrough.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectDaemonTarget,
  enumerateAdverts,
  NoDaemonsRunningError,
  AmbiguousDaemonError,
  DaemonNameNotFoundError,
} from "../../src/util/selector.js";

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

describe("selectDaemonTarget (T-CLI-1 unified selector)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cb-selector-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  async function write(name: string, over: Record<string, unknown> = {}): Promise<void> {
    await writeFile(join(dir, `${name}.json`), advertJson({ name, ...over }));
  }

  it("AC-C1-1: --name resolves to the matching daemon's address + workspace", async () => {
    await write("alpha", { pipe: "pipe-alpha", canonical_workspace: "c:\\ws\\a" });
    await write("beta", { pipe: "pipe-beta", canonical_workspace: "c:\\ws\\b" });
    const t = await selectDaemonTarget({ name: "beta", daemonsDir: dir });
    expect(t.addressOverride).toBe("pipe-beta");
    expect(t.workspace).toBe("c:\\ws\\b");
    expect(t.label).toBe("beta");
  });

  it("--name not found → DaemonNameNotFoundError (lists available)", async () => {
    await write("alpha");
    await expect(
      selectDaemonTarget({ name: "ghost", daemonsDir: dir }),
    ).rejects.toBeInstanceOf(DaemonNameNotFoundError);
  });

  it("asymmetric default — bare + exactly ONE → acts-on-sole (resolves it, NEVER the flat path)", async () => {
    await write("solo", { pipe: "pipe-solo", canonical_workspace: "c:\\ws\\solo" });
    const t = await selectDaemonTarget({ daemonsDir: dir });
    expect(t.addressOverride).toBe("pipe-solo"); // the advert's address
    expect(t.label).toBe("solo");
  });

  it("asymmetric default — bare + MANY → AmbiguousDaemonError (lists), never silently picks", async () => {
    await write("alpha");
    await write("beta");
    await expect(
      selectDaemonTarget({ daemonsDir: dir }),
    ).rejects.toBeInstanceOf(AmbiguousDaemonError);
  });

  it("asymmetric default — bare + NONE → NoDaemonsRunningError, never flat fallthrough", async () => {
    await expect(
      selectDaemonTarget({ daemonsDir: dir }),
    ).rejects.toBeInstanceOf(NoDaemonsRunningError);
  });

  it("--workspace targets directly (per-daemon address, no enumeration)", async () => {
    const t = await selectDaemonTarget({ workspace: "C:\\Projects\\X" });
    expect(t.workspace).toBe("C:\\Projects\\X");
    expect(t.addressOverride).toBeDefined();
    expect(t.pidPath).toContain("daemon.pid");
  });

  it("enumerateAdverts skips unparseable files + returns the valid adverts", async () => {
    await write("good");
    await writeFile(join(dir, "broken.json"), "{ not json");
    await writeFile(join(dir, "ignore.txt"), advertJson());
    const adverts = await enumerateAdverts(dir);
    expect(adverts.map((a) => a.name)).toEqual(["good"]);
  });
});

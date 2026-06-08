// T-TUNNEL-1 AC-T-3 (the PRIMARY orphan defense): reclaim-on-startup detects +
// kills a cloudflared orphaned by a prior NON-graceful daemon exit.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reclaimOrphanTunnel } from "../../src/tunnel/reclaim.js";
import type { Logger } from "../../src/log/logger.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};

describe("reclaimOrphanTunnel (T-TUNNEL-1 AC-T-3 — PRIMARY)", () => {
  let dir: string;
  let pidPath: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cb-tunnel-reclaim-"));
    pidPath = join(dir, "tunnel.pid");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("AC-T-3: kills a LIVE orphan recorded in tunnel.pid, then clears the file", async () => {
    await writeFile(pidPath, "4242");
    const killed: number[] = [];
    const reclaimed = await reclaimOrphanTunnel(pidPath, silentLogger, {
      isAlive: (pid) => pid === 4242, // the orphan is still alive
      kill: (pid) => killed.push(pid),
    });
    expect(reclaimed).toBe(4242); // detected + killed the orphan
    expect(killed).toEqual([4242]);
    await expect(readFile(pidPath, "utf8")).rejects.toThrow(); // pid file cleared
  });

  it("does NOT kill a pid that is already gone; still clears the file", async () => {
    await writeFile(pidPath, "999999");
    const killed: number[] = [];
    const reclaimed = await reclaimOrphanTunnel(pidPath, silentLogger, {
      isAlive: () => false, // already exited
      kill: (pid) => killed.push(pid),
    });
    expect(reclaimed).toBeNull();
    expect(killed).toEqual([]); // never signalled a dead pid
    await expect(readFile(pidPath, "utf8")).rejects.toThrow();
  });

  it("no tunnel.pid (graceful prior exit cleared it) → no-op", async () => {
    const reclaimed = await reclaimOrphanTunnel(pidPath, silentLogger, {
      isAlive: () => true,
      kill: () => {
        throw new Error("should not kill when no pid recorded");
      },
    });
    expect(reclaimed).toBeNull();
  });
});

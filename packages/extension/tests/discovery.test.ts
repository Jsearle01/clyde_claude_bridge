import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonAdvert } from "@claude-bridge/shared";
import {
  computeWorkspaceIdentity,
  findMatchingAdvert,
  startPairing,
} from "../src/discovery.js";

function advert(over: Partial<DaemonAdvert> = {}): DaemonAdvert {
  return {
    canonical_workspace: "c:\\projects\\clyde_claude_bridge",
    name: "clyde",
    pipe: "\\\\.\\pipe\\claude-bridge-135cfaa3d11a768c",
    port: 7423,
    pid: 4242,
    started_at: "2026-06-07T00:00:00.000Z",
    ...over,
  };
}

describe("computeWorkspaceIdentity — the case-folded match key (P3'-2b, AC-2b-1)", () => {
  // The real captured fsPath (T-P3'-0): C:\Projects\clyde_claude_bridge opens
  // as fsPath "c:\Projects\clyde_claude_bridge"; the identity key case-folds it.
  const EXPECTED = "c:\\projects\\clyde_claude_bridge";
  it("the captured fsPath maps to the daemon's canonical_workspace", () => {
    expect(computeWorkspaceIdentity("c:\\Projects\\clyde_claude_bridge", "win32")).toBe(
      EXPECTED,
    );
  });
  it("mixed-case / separator variants of the SAME folder still match", () => {
    for (const v of [
      "C:\\Projects\\clyde_claude_bridge",
      "C:/PROJECTS/clyde_claude_bridge",
      "c:\\projects\\clyde_claude_bridge\\",
    ]) {
      expect(computeWorkspaceIdentity(v, "win32")).toBe(EXPECTED);
    }
  });
});

describe("findMatchingAdvert (P3'-2b)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cb-disc-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("AC-2b-1: byte-matches canonical_workspace for the same folder", async () => {
    await writeFile(join(dir, "135cfaa3d11a768c.json"), JSON.stringify(advert()));
    const id = computeWorkspaceIdentity("C:\\Projects\\clyde_claude_bridge", "win32");
    const m = await findMatchingAdvert(dir, id);
    expect(m?.pipe).toBe("\\\\.\\pipe\\claude-bridge-135cfaa3d11a768c");
  });

  it("no match for a different workspace's advert", async () => {
    await writeFile(
      join(dir, "other.json"),
      JSON.stringify(advert({ canonical_workspace: "c:\\projects\\other" })),
    );
    const id = computeWorkspaceIdentity("C:\\Projects\\clyde_claude_bridge", "win32");
    expect(await findMatchingAdvert(dir, id)).toBeNull();
  });

  it("skips unparseable adverts (no throw)", async () => {
    await writeFile(join(dir, "junk.json"), "{ not json");
    await writeFile(join(dir, "135cfaa3d11a768c.json"), JSON.stringify(advert()));
    const id = computeWorkspaceIdentity("c:\\Projects\\clyde_claude_bridge", "win32");
    expect((await findMatchingAdvert(dir, id))?.name).toBe("clyde");
  });

  it("missing daemons/ dir → null (no daemons yet)", async () => {
    expect(await findMatchingAdvert(join(dir, "nope"), "x")).toBeNull();
  });
});

describe("startPairing (P3'-2b)", () => {
  it("AC-2b-2 daemon-first: an existing match pairs immediately", async () => {
    const matched: DaemonAdvert[] = [];
    startPairing({
      daemonsDir: "d",
      identity: "id",
      scan: () => Promise.resolve(advert()),
      onMatch: (a) => matched.push(a),
      setIntervalFn: () => 0,
      clearIntervalFn: () => undefined,
    });
    await new Promise((r) => setImmediate(r)); // let the immediate scan resolve
    expect(matched).toHaveLength(1);
  });

  it("AC-2b-2 window-first: pairs when a matching advert APPEARS via poll", async () => {
    const matched: DaemonAdvert[] = [];
    let tick: (() => void) | null = null;
    let scanResult: DaemonAdvert | null = null; // no advert yet
    startPairing({
      daemonsDir: "d",
      identity: "id",
      scan: () => Promise.resolve(scanResult),
      onMatch: (a) => matched.push(a),
      setIntervalFn: (cb) => {
        tick = cb;
        return 1;
      },
      clearIntervalFn: () => undefined,
    });
    await new Promise((r) => setImmediate(r));
    expect(matched).toHaveLength(0); // window-first: nothing yet
    // daemon starts → advert appears → next poll pairs
    scanResult = advert();
    tick?.();
    await new Promise((r) => setImmediate(r));
    expect(matched).toHaveLength(1);
  });

  it("fires onMatch exactly ONCE and stops polling after a match", async () => {
    const matched: DaemonAdvert[] = [];
    let tick: (() => void) | null = null;
    let cleared = false;
    startPairing({
      daemonsDir: "d",
      identity: "id",
      scan: () => Promise.resolve(advert()),
      onMatch: (a) => matched.push(a),
      setIntervalFn: (cb) => {
        tick = cb;
        return 1;
      },
      clearIntervalFn: () => {
        cleared = true;
      },
    });
    await new Promise((r) => setImmediate(r));
    tick?.(); // a stray late poll
    await new Promise((r) => setImmediate(r));
    expect(matched).toHaveLength(1); // not twice
    expect(cleared).toBe(true); // polling stopped
  });
});

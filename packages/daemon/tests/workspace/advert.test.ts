import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonAdvertSchema, type DaemonAdvert } from "@claude-bridge/shared";
import {
  getDaemonsDir,
  advertPath,
  writeAdvert,
  removeAdvert,
  isAdvertLive,
  sweepAdverts,
} from "../../src/workspace/advert.js";

function makeAdvert(over: Partial<DaemonAdvert> = {}): DaemonAdvert {
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

describe("advert lifecycle (P3'-2a)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cb-advert-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("AC-2a-1: writeAdvert creates daemons/<hash>.json with the schema", async () => {
    const path = await writeAdvert(root, "abc123", makeAdvert());
    expect(path).toBe(join(getDaemonsDir(root), "abc123.json"));
    const parsed = DaemonAdvertSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
    expect(parsed.canonical_workspace).toBe("c:\\projects\\clyde_claude_bridge");
    expect(parsed.pipe).toContain("claude-bridge-");
    // scope (a): NO tunnel URL field
    expect(Object.keys(parsed)).not.toContain("tunnel_url");
  });

  it("AC-2a-3: re-writing the same hash overwrites (reclaim-own, no duplicate)", async () => {
    await writeAdvert(root, "abc123", makeAdvert({ pid: 1 }));
    await writeAdvert(root, "abc123", makeAdvert({ pid: 2, port: 7424 }));
    const parsed = DaemonAdvertSchema.parse(
      JSON.parse(await readFile(advertPath(root, "abc123"), "utf8")),
    );
    expect(parsed.pid).toBe(2); // refreshed
    expect(parsed.port).toBe(7424);
  });

  it("AC-2a-2: removeAdvert deletes the file; absent file is not an error", async () => {
    const path = await writeAdvert(root, "abc123", makeAdvert());
    await removeAdvert(path);
    await expect(stat(path)).rejects.toThrow();
    // idempotent: removing again is a no-op (AC-2a-6 flavour)
    await expect(removeAdvert(path)).resolves.toBeUndefined();
  });
});

describe("isAdvertLive — retry-gated liveness (P3'-2a, AC-2a-5)", () => {
  it("LIVE-BUT-SLOW is NOT dead: a probe that fails once then succeeds → live", async () => {
    let calls = 0;
    const flaky = (): Promise<boolean> => {
      calls += 1;
      return Promise.resolve(calls >= 2); // first attempt times out, second answers
    };
    expect(await isAdvertLive("pipe", flaky, 2)).toBe(true);
    expect(calls).toBe(2); // it retried, didn't give up on the first miss
  });

  it("truly dead: every attempt fails → not live", async () => {
    const dead = (): Promise<boolean> => Promise.resolve(false);
    expect(await isAdvertLive("pipe", dead, 2)).toBe(false);
  });

  it("fast-live: first attempt succeeds → live (no needless retry)", async () => {
    let calls = 0;
    const live = (): Promise<boolean> => {
      calls += 1;
      return Promise.resolve(true);
    };
    expect(await isAdvertLive("pipe", live, 2)).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("sweepAdverts (P3'-2a)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cb-sweep-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("AC-2a-4: deletes adverts that fail the handshake, keeps live ones", async () => {
    await writeAdvert(root, "live1", makeAdvert({ pipe: "pipe-live1" }));
    await writeAdvert(root, "dead1", makeAdvert({ pipe: "pipe-dead1" }));
    await writeAdvert(root, "live2", makeAdvert({ pipe: "pipe-live2" }));
    const liveOf = (pipe: string): Promise<boolean> =>
      Promise.resolve(pipe !== "pipe-dead1");
    const res = await sweepAdverts(root, liveOf);
    expect(res.swept).toEqual(["dead1"]);
    expect(res.kept.sort()).toEqual(["live1", "live2"]);
    await expect(stat(advertPath(root, "dead1"))).rejects.toThrow(); // gone
    await expect(stat(advertPath(root, "live1"))).resolves.toBeTruthy(); // intact
  });

  it("AC-2a-4: never sweeps its own (selfHash) advert without handshaking", async () => {
    await writeAdvert(root, "self", makeAdvert({ pipe: "pipe-self" }));
    // liveOf would call the corpse dead, but selfHash is skipped entirely.
    const res = await sweepAdverts(root, () => Promise.resolve(false), {
      selfHash: "self",
    });
    expect(res.swept).toEqual([]);
    expect(res.kept).toEqual(["self"]);
    await expect(stat(advertPath(root, "self"))).resolves.toBeTruthy();
  });

  it("AC-2a-5: a LIVE-BUT-SLOW daemon (via isAdvertLive retry) is NOT swept", async () => {
    await writeAdvert(root, "slow", makeAdvert({ pipe: "pipe-slow" }));
    // The real retry gate: probe fails the first attempt, answers the second.
    let calls = 0;
    const slowProbe = (): Promise<boolean> => {
      calls += 1;
      return Promise.resolve(calls >= 2);
    };
    const res = await sweepAdverts(root, (pipe) =>
      isAdvertLive(pipe, slowProbe, 2),
    );
    expect(res.swept).toEqual([]); // NOT swept — the retry caught it
    expect(res.kept).toEqual(["slow"]);
    await expect(stat(advertPath(root, "slow"))).resolves.toBeTruthy();
  });

  it("AC-2a-6: idempotent — sweeping an already-deleted dead advert does not fault", async () => {
    await writeAdvert(root, "dead", makeAdvert({ pipe: "pipe-dead" }));
    const dead = (): Promise<boolean> => Promise.resolve(false);
    const a = await sweepAdverts(root, dead);
    const b = await sweepAdverts(root, dead); // second boot — file already gone
    expect(a.swept).toEqual(["dead"]);
    expect(b.swept).toEqual([]); // nothing left; no error
  });

  it("invariant: an UNPARSEABLE advert is left intact (delete only on failed handshake)", async () => {
    await mkdir(getDaemonsDir(root), { recursive: true });
    await writeFile(join(getDaemonsDir(root), "junk.json"), "{ not valid json");
    const res = await sweepAdverts(root, () => Promise.resolve(false));
    expect(res.swept).toEqual([]);
    expect(res.kept).toEqual(["junk"]);
    await expect(stat(advertPath(root, "junk"))).resolves.toBeTruthy();
  });

  it("AC-2a-7: durable state (tokens.json etc.) is never touched by the sweep", async () => {
    // A tokens.json at the root must survive — sweep only scans daemons/.
    await writeFile(join(root, "tokens.json"), '{"version":"1"}');
    await writeAdvert(root, "dead", makeAdvert({ pipe: "pipe-dead" }));
    await sweepAdverts(root, () => Promise.resolve(false));
    await expect(stat(join(root, "tokens.json"))).resolves.toBeTruthy();
  });

  it("missing daemons/ dir → empty result, no error", async () => {
    const res = await sweepAdverts(root, () => Promise.resolve(false));
    expect(res).toEqual({ swept: [], kept: [] });
  });
});

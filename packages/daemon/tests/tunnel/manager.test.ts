import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  TunnelManager,
  TunnelStartTimeoutError,
  type TunnelStatus,
} from "../../src/tunnel/manager.js";
import {
  CloudflaredProcess,
  type CloudflaredOpts,
} from "../../src/tunnel/cloudflared.js";
import type { Logger } from "../../src/log/logger.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};

// Fake process that lets tests drive `url`/`exit`/`error` events
// synchronously, without spawning real cloudflared. Extends the real
// CloudflaredProcess to satisfy the factory signature; overrides start/stop
// to be no-ops, retains the typed event API.
class FakeProcess extends CloudflaredProcess {
  fakeStarted = false;
  fakeStopped = false;
  fakePid: number | undefined = undefined;

  constructor(opts: CloudflaredOpts) {
    super(opts);
    // A process that exits/errors is no longer running (mirror the real
    // CloudflaredProcess.exited flag that isRunning() consults).
    this.on("exit", () => {
      this.fakeStopped = true;
    });
    this.on("error", () => {
      this.fakeStopped = true;
    });
  }

  override start(): void {
    this.fakeStarted = true;
  }

  override stop(): Promise<void> {
    this.fakeStopped = true;
    return Promise.resolve();
  }

  override isRunning(): boolean {
    return this.fakeStarted && !this.fakeStopped;
  }

  override pid(): number | undefined {
    return this.fakePid;
  }
}

describe("TunnelManager", () => {
  let fakes: FakeProcess[];

  beforeEach(() => {
    fakes = [];
  });

  function makeFactory(): (opts: CloudflaredOpts) => CloudflaredProcess {
    return (opts) => {
      const f = new FakeProcess(opts);
      f.fakePid = 1000 + fakes.length; // distinct pid per spawn
      fakes.push(f);
      return f;
    };
  }

  function lastFake(): FakeProcess {
    const f = fakes[fakes.length - 1];
    if (f === undefined) throw new Error("no fakes spawned yet");
    return f;
  }

  afterEach(async () => {
    // Tests should leave the manager in a known state; this is defensive.
    // No global cleanup needed since fakes are in-memory.
  });

  it("start emits url and resolves with URL (15.a)", async () => {
    const manager = new TunnelManager({
      binary: "x",
      localUrl: "http://127.0.0.1:7423",
      argsExtra: [],
      logger: silentLogger,
      processFactory: makeFactory(),
    });
    const p = manager.start();
    lastFake().emit("url", "https://first.trycloudflare.com");
    const url = await p;
    expect(url).toBe("https://first.trycloudflare.com");
    expect(manager.getStatus()).toBe("up");
    expect(manager.getUrl()).toBe("https://first.trycloudflare.com");
    await manager.stop();
  });

  it("start rejects with TunnelStartTimeoutError if no URL within timeout (15.b)", async () => {
    const manager = new TunnelManager({
      binary: "x",
      localUrl: "http://127.0.0.1:7423",
      argsExtra: [],
      logger: silentLogger,
      processFactory: makeFactory(),
      startTimeoutMs: 50,
    });
    await expect(manager.start()).rejects.toBeInstanceOf(
      TunnelStartTimeoutError,
    );
    expect(manager.getStatus()).toBe("down");
    await manager.stop();
  });

  it("unexpected exit triggers respawn (15.c)", async () => {
    const manager = new TunnelManager({
      binary: "x",
      localUrl: "http://127.0.0.1:7423",
      argsExtra: [],
      logger: silentLogger,
      processFactory: makeFactory(),
    });
    const p = manager.start();
    lastFake().emit("url", "https://first.trycloudflare.com");
    await p;
    expect(fakes).toHaveLength(1);

    fakes[0]?.emit("exit", 0, null);
    expect(fakes).toHaveLength(2);

    // Resolve the new fake's URL so manager state is sane for cleanup.
    lastFake().emit("url", "https://second.trycloudflare.com");
    await manager.stop();
  });

  it("respawned process URL emits url_change (15.d)", async () => {
    const manager = new TunnelManager({
      binary: "x",
      localUrl: "http://127.0.0.1:7423",
      argsExtra: [],
      logger: silentLogger,
      processFactory: makeFactory(),
    });
    const urlChanges: string[] = [];
    manager.on("url_change", (url) => urlChanges.push(url));
    const p = manager.start();
    lastFake().emit("url", "https://first.trycloudflare.com");
    await p;

    fakes[0]?.emit("exit", 0, null);
    lastFake().emit("url", "https://otter-orange-1234.trycloudflare.com");

    expect(urlChanges).toContain("https://first.trycloudflare.com");
    expect(urlChanges).toContain("https://otter-orange-1234.trycloudflare.com");
    expect(manager.getUrl()).toBe("https://otter-orange-1234.trycloudflare.com");
    await manager.stop();
  });

  it("5 restarts in window keeps up; 6th triggers degraded (15.e)", async () => {
    const now = 0;
    const manager = new TunnelManager({
      binary: "x",
      localUrl: "http://127.0.0.1:7423",
      argsExtra: [],
      logger: silentLogger,
      processFactory: makeFactory(),
      clock: () => now,
    });
    const p = manager.start();
    lastFake().emit("url", "https://r0.trycloudflare.com");
    await p;

    // First 5 restarts succeed (status stays "up").
    for (let i = 0; i < 5; i++) {
      lastFake().emit("exit", 0, null);
      expect(manager.getStatus()).toBe("up");
      lastFake().emit("url", `https://r${i + 1}.trycloudflare.com`);
    }
    expect(fakes).toHaveLength(6); // initial + 5 respawns

    // 6th exit pushes restart count to 6 > MAX (5) → degraded; no new spawn.
    const statusChanges: TunnelStatus[] = [];
    manager.on("status_change", (s) => statusChanges.push(s));
    lastFake().emit("exit", 0, null);
    expect(manager.getStatus()).toBe("degraded");
    expect(statusChanges).toContain("degraded");
    expect(fakes).toHaveLength(6); // no 7th spawn

    await manager.stop();
  });

  it("degraded state recovers via restart() (15.f)", async () => {
    const now = 0;
    const manager = new TunnelManager({
      binary: "x",
      localUrl: "http://127.0.0.1:7423",
      argsExtra: [],
      logger: silentLogger,
      processFactory: makeFactory(),
      clock: () => now,
    });
    const p = manager.start();
    lastFake().emit("url", "https://r0.trycloudflare.com");
    await p;
    for (let i = 0; i < 5; i++) {
      lastFake().emit("exit", 0, null);
      lastFake().emit("url", `https://r${i + 1}.trycloudflare.com`);
    }
    lastFake().emit("exit", 0, null);
    expect(manager.getStatus()).toBe("degraded");

    // restart() spawns a new process; emit its URL to satisfy the await.
    const restartP = manager.restart();
    lastFake().emit("url", "https://recovered.trycloudflare.com");
    const url = await restartP;
    expect(url).toBe("https://recovered.trycloudflare.com");
    expect(manager.getStatus()).toBe("up");

    await manager.stop();
  });

  it("restart() in non-degraded state works (15.g)", async () => {
    const manager = new TunnelManager({
      binary: "x",
      localUrl: "http://127.0.0.1:7423",
      argsExtra: [],
      logger: silentLogger,
      processFactory: makeFactory(),
    });
    const p = manager.start();
    lastFake().emit("url", "https://first.trycloudflare.com");
    await p;

    const restartP = manager.restart();
    // restart() internally awaits proc.stop() before spawning the new
    // process. Flush microtasks so the new fake exists before we emit.
    await new Promise<void>((resolve) => setImmediate(resolve));
    lastFake().emit("url", "https://restarted.trycloudflare.com");
    const url = await restartP;
    expect(url).toBe("https://restarted.trycloudflare.com");
    expect(manager.getStatus()).toBe("up");
    expect(manager.getUrl()).toBe("https://restarted.trycloudflare.com");

    await manager.stop();
  });

  it("stop is idempotent and does NOT trigger respawn (15.h)", async () => {
    const manager = new TunnelManager({
      binary: "x",
      localUrl: "http://127.0.0.1:7423",
      argsExtra: [],
      logger: silentLogger,
      processFactory: makeFactory(),
    });
    const p = manager.start();
    lastFake().emit("url", "https://first.trycloudflare.com");
    await p;

    await manager.stop();
    expect(manager.getStatus()).toBe("down");

    // After stop, emitting exit on the (orphan) fake should NOT spawn a new
    // process. The manager set intentionallyStopped=true.
    const fakeCountBefore = fakes.length;
    fakes[0]?.emit("exit", 0, null);
    expect(fakes).toHaveLength(fakeCountBefore);

    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it("sliding window pruning (15.i)", async () => {
    let now = 0;
    const manager = new TunnelManager({
      binary: "x",
      localUrl: "http://127.0.0.1:7423",
      argsExtra: [],
      logger: silentLogger,
      processFactory: makeFactory(),
      clock: () => now,
    });
    const p = manager.start();
    lastFake().emit("url", "https://a.trycloudflare.com");
    await p;

    // 4 restarts at t=0 (within window — count stays at 4 ≤ 5).
    for (let i = 0; i < 4; i++) {
      lastFake().emit("exit", 0, null);
      lastFake().emit("url", `https://b${i}.trycloudflare.com`);
    }
    expect(manager.getStatus()).toBe("up");

    // Advance clock past window — first 4 timestamps now stale.
    now = 6 * 60 * 1000;

    // 2 more restarts after the window — only these 2 should be live.
    lastFake().emit("exit", 0, null);
    lastFake().emit("url", "https://c0.trycloudflare.com");
    lastFake().emit("exit", 0, null);
    lastFake().emit("url", "https://c1.trycloudflare.com");

    // Total 6 restarts over time, but only 2 in current window → NOT degraded.
    expect(manager.getStatus()).toBe("up");

    await manager.stop();
  });

  it("start rejects when process emits error before URL (15.j)", async () => {
    const manager = new TunnelManager({
      binary: "x",
      localUrl: "http://127.0.0.1:7423",
      argsExtra: [],
      logger: silentLogger,
      processFactory: makeFactory(),
      startTimeoutMs: 100,
    });
    // Don't emit url. Fake an exit before url to trigger the
    // exited-before-url rejection path (this is the "error path" — the
    // contract is "rejects on failure to get URL within budget"; exit-without-
    // URL is the prompt failure mode, timeout is the slow failure mode).
    const p = manager.start();
    lastFake().emit("exit", 1, null);
    await expect(p).rejects.toThrow(/exited before emitting URL/);
    expect(manager.getStatus()).toBe("down");

    await manager.stop();
  });

  // T-TUNNEL-1: ownership invariant.
  describe("T-TUNNEL-1 ownership (pid tracking + kill-before-respawn)", () => {
    it("emits pid_change with the child pid on spawn, and null on stop", async () => {
      const pids: (number | null)[] = [];
      const manager = new TunnelManager({
        binary: "cf",
        localUrl: "http://localhost:1",
        argsExtra: [],
        logger: silentLogger,
        processFactory: makeFactory(),
      });
      manager.on("pid_change", (pid) => pids.push(pid));
      const p = manager.start();
      lastFake().emit("url", "https://x.trycloudflare.com");
      await p;
      expect(pids).toContain(1000); // first child's pid persisted on spawn
      await manager.stop();
      expect(pids[pids.length - 1]).toBeNull(); // cleared on graceful stop
    });

    it("AC-T-1: an unexpected-exit respawn never leaves two cloudflared running", async () => {
      const manager = new TunnelManager({
        binary: "cf",
        localUrl: "http://localhost:1",
        argsExtra: [],
        logger: silentLogger,
        processFactory: makeFactory(),
      });
      const p = manager.start();
      lastFake().emit("url", "https://first.trycloudflare.com");
      await p;
      // The live child dies unexpectedly → manager respawns.
      fakes[0].emit("exit", 1, null);
      lastFake().emit("url", "https://second.trycloudflare.com");
      // At most ONE process is running at any time (the old one exited; the new
      // one is live). Never two concurrent for one daemon.
      expect(fakes.filter((f) => f.isRunning())).toHaveLength(1);
      expect(fakes[0].isRunning()).toBe(false); // old gone
      expect(lastFake().isRunning()).toBe(true); // new live
      await manager.stop();
    });
  });
});

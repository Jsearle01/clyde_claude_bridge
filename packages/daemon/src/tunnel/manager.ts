// Tunnel manager. Wraps CloudflaredProcess with restart policy, status
// tracking, and degraded-state detection.
//
// AC-6 closure: when cloudflared exits unexpectedly, TunnelManager spawns
// a fresh process (within ~15s for the URL to land). After 5 restarts in a
// 5-minute sliding window, the manager refuses further automatic respawns
// and transitions to "degraded"; `restart()` (called manually by the CLI)
// clears the degraded flag.
//
// Per CC-1: every async path catches its own rejections; per-process event
// handlers never propagate errors as unhandled rejections.

import { EventEmitter } from "node:events";
import { CloudflaredProcess, type CloudflaredOpts } from "./cloudflared.js";
import type { Logger } from "../log/logger.js";

export type TunnelStatus = "up" | "degraded" | "down";

export interface TunnelManagerOpts {
  binary: string;
  localUrl: string;
  argsExtra: readonly string[];
  logger: Logger;
  // Optional: test-only injection points.
  processFactory?: (opts: CloudflaredOpts) => CloudflaredProcess;
  clock?: () => number;
  startTimeoutMs?: number;
}

export interface TunnelManagerEvents {
  url_change: (url: string) => void;
  status_change: (status: TunnelStatus) => void;
  // T-TUNNEL-1: the owned cloudflared child's pid changed — a new pid on each
  // (re)spawn, null when intentionally stopped. main.ts persists it to
  // tunnel.pid so a future daemon can reclaim an orphan.
  pid_change: (pid: number | null) => void;
}

export class TunnelStartTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Tunnel did not emit URL within ${timeoutMs}ms`);
    this.name = "TunnelStartTimeoutError";
  }
}

export class TunnelDegradedError extends Error {
  constructor() {
    super("Tunnel restarted too many times; daemon is in degraded state");
    this.name = "TunnelDegradedError";
  }
}

const RESTART_WINDOW_MS = 5 * 60 * 1000;
const MAX_RESTARTS_IN_WINDOW = 5;
const DEFAULT_START_TIMEOUT_MS = 15000;

export class TunnelManager extends EventEmitter {
  private readonly binary: string;
  private readonly localUrl: string;
  private readonly argsExtra: readonly string[];
  private readonly logger: Logger;
  private readonly processFactory: (
    opts: CloudflaredOpts,
  ) => CloudflaredProcess;
  private readonly clock: () => number;
  private readonly startTimeoutMs: number;

  private currentProcess: CloudflaredProcess | null = null;
  private currentUrl: string | null = null;
  private status: TunnelStatus = "down";
  private restartTimestamps: number[] = [];
  private respawnSuspended = false;
  private intentionallyStopped = false;

  constructor(opts: TunnelManagerOpts) {
    super();
    this.binary = opts.binary;
    this.localUrl = opts.localUrl;
    this.argsExtra = opts.argsExtra;
    this.logger = opts.logger;
    this.processFactory =
      opts.processFactory ?? ((o) => new CloudflaredProcess(o));
    this.clock = opts.clock ?? (() => Date.now());
    this.startTimeoutMs = opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  }

  start(): Promise<string> {
    if (this.currentProcess !== null) {
      return Promise.reject(new Error("TunnelManager already started"));
    }
    this.intentionallyStopped = false;
    return new Promise<string>((resolve, reject) => {
      const proc = this.spawnProcess(true, resolve, reject);
      this.currentProcess = proc;
    });
  }

  // Spawn a process, wire events, set the start-timeout. `isInitial`
  // distinguishes the start() call from automatic/manual respawns:
  // - initial: timeout/exit-before-url reject the caller's Promise.
  // - respawn (isInitial=false): timeout/exit-before-url trigger
  //   attemptRespawn (which may degrade the manager).
  private spawnProcess(
    isInitial: boolean,
    initialResolve?: (url: string) => void,
    initialReject?: (err: Error) => void,
  ): CloudflaredProcess {
    // T-TUNNEL-1 (AC-T-1, kill-before-respawn): NEVER two concurrent cloudflared
    // for one daemon. The normal respawn paths already null currentProcess (exit
    // handler) or stop it (restart/timeout) before reaching here; this guard
    // makes the invariant explicit + terminates any child that somehow lingers.
    if (this.currentProcess !== null && this.currentProcess.isRunning()) {
      const stale = this.currentProcess;
      this.currentProcess = null;
      void stale.stop().catch(() => undefined);
    }
    const proc = this.processFactory({
      binary: this.binary,
      localUrl: this.localUrl,
      argsExtra: this.argsExtra,
    });

    let urlReceived = false;
    let timer: NodeJS.Timeout | null = null;
    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    proc.on("url", (url: string) => {
      if (urlReceived) return;
      urlReceived = true;
      clearTimer();
      this.currentUrl = url;
      if (this.status !== "up") {
        this.status = "up";
        this.emit("status_change", "up");
      }
      this.emit("url_change", url);
      if (isInitial && initialResolve !== undefined) {
        initialResolve(url);
      }
    });

    proc.on("exit", () => {
      clearTimer();
      if (this.currentProcess === proc) {
        this.currentProcess = null;
      }
      if (this.intentionallyStopped) return;
      if (!urlReceived) {
        if (isInitial && initialReject !== undefined) {
          initialReject(new Error("cloudflared exited before emitting URL"));
          return;
        }
        this.attemptRespawn();
        return;
      }
      // Exit after URL — process died unexpectedly. Try to respawn.
      this.attemptRespawn();
    });

    proc.on("error", (err: Error) => {
      this.logger.warn("cloudflared error", { error: err.message });
    });

    proc.on("log", (line: string) => {
      this.logger.debug("cloudflared", { line });
    });

    timer = setTimeout(() => {
      timer = null;
      if (urlReceived) return;
      // Timeout — stop the process and route the failure.
      if (this.currentProcess === proc) {
        this.currentProcess = null;
      }
      void proc.stop().catch(() => undefined);
      if (isInitial && initialReject !== undefined) {
        initialReject(new TunnelStartTimeoutError(this.startTimeoutMs));
        return;
      }
      this.attemptRespawn();
    }, this.startTimeoutMs);

    proc.start();
    // T-TUNNEL-1: persist the new child's pid (for orphan reclaim). Emitted
    // after start() so proc.pid() is populated.
    this.emit("pid_change", proc.pid() ?? null);
    return proc;
  }

  private attemptRespawn(): void {
    if (this.respawnSuspended) return;
    if (this.intentionallyStopped) return;

    const now = this.clock();
    this.restartTimestamps = this.restartTimestamps.filter(
      (t) => now - t < RESTART_WINDOW_MS,
    );
    this.restartTimestamps.push(now);

    if (this.restartTimestamps.length > MAX_RESTARTS_IN_WINDOW) {
      this.respawnSuspended = true;
      if (this.status !== "degraded") {
        this.status = "degraded";
        this.emit("status_change", "degraded");
      }
      this.logger.warn("tunnel respawn suspended; entering degraded state", {
        restarts_in_window: this.restartTimestamps.length,
        window_ms: RESTART_WINDOW_MS,
      });
      return;
    }

    // Spawn a respawn-style process — exit/timeout failures recurse via
    // attemptRespawn rather than rejecting any external Promise.
    const proc = this.spawnProcess(false);
    this.currentProcess = proc;
  }

  async stop(): Promise<void> {
    if (this.intentionallyStopped && this.currentProcess === null) {
      return;
    }
    this.intentionallyStopped = true;
    if (this.currentProcess !== null) {
      const proc = this.currentProcess;
      this.currentProcess = null;
      await proc.stop().catch(() => undefined);
    }
    // T-TUNNEL-1: the child is gone (graceful) — clear the persisted pid so a
    // future daemon doesn't try to reclaim a dead/recycled pid.
    this.emit("pid_change", null);
    if (this.status !== "down") {
      this.status = "down";
      this.emit("status_change", "down");
    }
  }

  async restart(): Promise<string> {
    // Manual restart clears the suspended flag and the rolling window.
    this.respawnSuspended = false;
    this.restartTimestamps = [];
    this.intentionallyStopped = false;

    if (this.currentProcess !== null) {
      const proc = this.currentProcess;
      this.currentProcess = null;
      await proc.stop().catch(() => undefined);
    }

    let url: string;
    try {
      url = await new Promise<string>((resolve, reject) => {
        const proc = this.spawnProcess(true, resolve, reject);
        this.currentProcess = proc;
      });
    } catch {
      // Failed restart — mark degraded and refuse further automatic respawn
      // until another manual restart.
      this.respawnSuspended = true;
      if (this.status !== "degraded") {
        this.status = "degraded";
        this.emit("status_change", "degraded");
      }
      throw new TunnelDegradedError();
    }
    return url;
  }

  getStatus(): TunnelStatus {
    return this.status;
  }

  getUrl(): string | null {
    return this.currentUrl;
  }

  override on<E extends keyof TunnelManagerEvents>(
    event: E,
    listener: TunnelManagerEvents[E],
  ): this {
    return super.on(event, listener as never);
  }
  override off<E extends keyof TunnelManagerEvents>(
    event: E,
    listener: TunnelManagerEvents[E],
  ): this {
    return super.off(event, listener as never);
  }
  override emit<E extends keyof TunnelManagerEvents>(
    event: E,
    ...args: Parameters<TunnelManagerEvents[E]>
  ): boolean {
    return super.emit(event, ...args);
  }
}

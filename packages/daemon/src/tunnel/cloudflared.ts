// Cloudflared subprocess wrapper. Spawns `cloudflared tunnel --url <local>`,
// parses stdout/stderr line-by-line for the assigned trycloudflare.com URL,
// emits typed events (url / exit / error / log).
//
// Per CC-5 (process lifecycle): stop() sends SIGTERM with a 5-second grace
// period before escalating to SIGKILL. Idempotent.
//
// Per-line buffering follows the same shape as T-0008's IPC server
// (accumulate chunks; slice on \n; retain partial). Codified in
// `patterns/project/line-buffered-stream-reader.md` (T-0012 closure).

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export interface CloudflaredOpts {
  binary: string;
  localUrl: string;
  argsExtra: readonly string[];
}

export interface CloudflaredEvents {
  url: (url: string) => void;
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
  error: (err: Error) => void;
  log: (line: string) => void;
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const STOP_GRACE_MS = 5000;

export class CloudflaredProcess extends EventEmitter {
  private readonly opts: CloudflaredOpts;
  private child: ChildProcess | null = null;
  private exited = false;
  private urlEmitted = false;
  private stdoutBuf = "";
  private stderrBuf = "";

  constructor(opts: CloudflaredOpts) {
    super();
    this.opts = opts;
  }

  start(): void {
    if (this.child !== null) {
      throw new Error("CloudflaredProcess already started");
    }
    const args = [
      "tunnel",
      "--url",
      this.opts.localUrl,
      ...this.opts.argsExtra,
    ];
    const child = spawn(this.opts.binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.on("error", (err: Error) => {
      this.exited = true;
      this.emit("error", err);
    });

    child.on("exit", (code, signal) => {
      this.exited = true;
      this.emit("exit", code, signal);
    });

    if (child.stdout !== null) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        this.stdoutBuf = this.handleStream(this.stdoutBuf, chunk);
      });
    }

    if (child.stderr !== null) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        this.stderrBuf = this.handleStream(this.stderrBuf, chunk);
      });
    }

    this.child = child;
  }

  private handleStream(buffer: string, chunk: string): string {
    let buf = buffer + chunk;
    let newlineIdx = buf.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = buf.slice(0, newlineIdx);
      buf = buf.slice(newlineIdx + 1);
      this.processLine(line);
      newlineIdx = buf.indexOf("\n");
    }
    return buf;
  }

  private processLine(line: string): void {
    this.emit("log", line);
    if (this.urlEmitted) return;
    const match = URL_RE.exec(line);
    const url = match?.[0];
    if (url !== undefined) {
      this.urlEmitted = true;
      this.emit("url", url);
    }
  }

  stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.child === null || this.exited) return Promise.resolve();
    const child = this.child;
    return new Promise<void>((resolve) => {
      let killTimer: NodeJS.Timeout | null = null;
      const onExit = (): void => {
        if (killTimer !== null) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        resolve();
      };
      child.once("exit", onExit);
      child.kill(signal);
      killTimer = setTimeout(() => {
        if (!this.exited) {
          child.kill("SIGKILL");
        }
      }, STOP_GRACE_MS);
    });
  }

  isRunning(): boolean {
    return this.child !== null && !this.exited;
  }

  pid(): number | undefined {
    return this.child?.pid;
  }

  // Type-safe event API: the bare EventEmitter signatures use `any[]` for
  // listener args, which leaks through to `recommendedTypeChecked` as
  // `no-unsafe-*` fires downstream. Overriding with the CloudflaredEvents
  // map gives subscribers typed args.
  override on<E extends keyof CloudflaredEvents>(
    event: E,
    listener: CloudflaredEvents[E],
  ): this {
    return super.on(event, listener as never);
  }
  override off<E extends keyof CloudflaredEvents>(
    event: E,
    listener: CloudflaredEvents[E],
  ): this {
    return super.off(event, listener as never);
  }
  override once<E extends keyof CloudflaredEvents>(
    event: E,
    listener: CloudflaredEvents[E],
  ): this {
    return super.once(event, listener as never);
  }
  override emit<E extends keyof CloudflaredEvents>(
    event: E,
    ...args: Parameters<CloudflaredEvents[E]>
  ): boolean {
    return super.emit(event, ...args);
  }
}

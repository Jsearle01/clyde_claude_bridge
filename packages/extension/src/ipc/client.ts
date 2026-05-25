// IPC client for the VS Code extension. Connects to the daemon's local
// socket (Unix domain socket or Windows named pipe), sends a hello prelude
// per T-P2-002's protocol, and tracks connection state through
// disconnect/reconnect cycles with exponential backoff.
//
// Endpoint discovery is inline-duplicated from CLI's util/paths.ts shape
// because cross-package dependency on the CLI is not allowed; the
// duplication is small (~20 lines) and stable.

import { connect as netConnect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import * as vscode from "vscode";

const WINDOWS_PIPE_PATH = "\\\\.\\pipe\\claude-bridge";
const IPC_CLIENT_VERSION = "1.0";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export type ConnectionStateKind =
  | "disconnected"
  | "connecting"
  | "connected"
  | "version_mismatch";

export interface IpcClientOptions {
  // Test seam: inject a socket factory to bypass real net.connect.
  socketFactory?: (endpoint: string) => Socket;
}

interface CliConfigShape {
  daemon?: { ipc_socket?: string };
}

// Locate the daemon's config file. Mirrors CLI's util/paths.ts logic.
// Returns the IPC endpoint (socket path on Unix; named pipe on Windows).
export function discoverDaemonEndpoint(): string {
  if (process.platform === "win32") {
    return WINDOWS_PIPE_PATH;
  }
  const configPath = join(homedir(), ".claude-bridge", "config.json");
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as CliConfigShape;
    if (
      typeof parsed.daemon?.ipc_socket === "string" &&
      parsed.daemon.ipc_socket.length > 0
    ) {
      return parsed.daemon.ipc_socket;
    }
  } catch {
    // Config absent or malformed; fall back to the conventional path.
  }
  return join(homedir(), ".claude-bridge", "daemon.sock");
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class IpcClient {
  private state: ConnectionStateKind = "disconnected";
  private socket: Socket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private explicitlyClosed = false;
  private readonly socketFactory: (endpoint: string) => Socket;
  // Single-flight queue for post-hello requests. T-P2-003 needs at most
  // one in-flight request at a time (register_workspace then maybe
  // confirm_trust); P3+ may grow this to multiplexed concurrent requests
  // if real demand surfaces.
  private pending: PendingRequest | null = null;
  // Optional hook fired after each reconnect attempt is scheduled (i.e.,
  // after the reconnectAttempt counter has just been incremented). Used by
  // extension.ts (T-P2-005) to surface a user-visible "daemon not running"
  // notification after N attempts. Single-subscriber model — not
  // EventEmitter — to keep IpcClient's public API minimal and tests
  // direct-assignable. Errors thrown by the callback are caught and
  // swallowed in scheduleReconnect() so subscriber failures cannot
  // corrupt the reconnect machinery.
  public onReconnectAttempt?: (attempt: number) => void;

  constructor(
    private readonly endpoint: string,
    opts: IpcClientOptions = {},
  ) {
    this.socketFactory = opts.socketFactory ?? ((ep) => netConnect(ep));
  }

  getConnectionState(): ConnectionStateKind {
    return this.state;
  }

  // Send a request on the established connection and await the next
  // response line. Single-flight: rejects if another request is already
  // pending. P2 callers (registration flow) are strictly sequential so
  // the constraint is non-blocking; promotion to multiplexed concurrent
  // requests is a P3+ candidate.
  request<R>(req: unknown): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      if (this.state !== "connected" || this.socket === null) {
        reject(new Error(`ipc-client: not connected (state=${this.state})`));
        return;
      }
      if (this.pending !== null) {
        reject(new Error("ipc-client: another request is already in flight"));
        return;
      }
      this.pending = {
        resolve: (value: unknown) => resolve(value as R),
        reject,
      };
      this.socket.write(JSON.stringify(req) + "\n");
    });
  }

  // Connect to the daemon and complete the hello handshake.
  // Resolves on hello_ok; rejects on version mismatch (and surfaces a
  // VS Code error notification). Does NOT auto-retry on mismatch — only on
  // disconnect after a successful hello.
  connect(): Promise<void> {
    this.explicitlyClosed = false;
    if (
      this.state === "connecting" ||
      this.state === "connected" ||
      this.state === "version_mismatch"
    ) {
      return Promise.resolve();
    }
    return this.doConnect();
  }

  // Cancel any pending reconnect and close the socket. Idempotent.
  disconnect(): void {
    this.explicitlyClosed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectPending(new Error("ipc-client: disconnect requested"));
    if (this.socket !== null) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.state = "disconnected";
  }

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.state = "connecting";
      const sock = this.socketFactory(this.endpoint);
      this.socket = sock;
      sock.setEncoding("utf8");

      let buffer = "";
      let settled = false;

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };

      sock.on("connect", () => {
        sock.write(
          JSON.stringify({
            kind: "hello",
            version: IPC_CLIENT_VERSION,
            role: "extension",
            pid: process.pid,
          }) + "\n",
        );
      });

      sock.on("data", (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf("\n");
        while (idx !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);

          let parsed: { kind?: string; reason?: string; message?: string };
          try {
            parsed = JSON.parse(line) as typeof parsed;
          } catch {
            const malformed = new Error("ipc-client: malformed JSON from daemon");
            settle(() => reject(malformed));
            this.rejectPending(malformed);
            sock.destroy();
            return;
          }

          // Hello phase: any pre-hello_ok response is one of hello_ok /
          // error+version_mismatch / error+other. After hello_ok, state
          // transitions to "connected" and subsequent lines feed the
          // pending-request queue.
          if (this.state !== "connected") {
            if (parsed.kind === "hello_ok") {
              this.state = "connected";
              this.reconnectAttempt = 0;
              settle(() => resolve());
            } else if (parsed.kind === "error" && parsed.reason === "version_mismatch") {
              this.state = "version_mismatch";
              const message = parsed.message ?? "version mismatch";
              void vscode.window.showErrorMessage(
                `Claude Bridge: ${message}. Update one of them to continue.`,
              );
              settle(() => reject(new Error(message)));
              sock.destroy();
              return;
            } else if (parsed.kind === "error") {
              settle(() =>
                reject(new Error(parsed.message ?? "ipc hello rejected")),
              );
              sock.destroy();
              return;
            } else {
              settle(() =>
                reject(
                  new Error(`ipc-client: unexpected ${parsed.kind ?? "?"} during hello`),
                ),
              );
              sock.destroy();
              return;
            }
          } else {
            // Post-hello: dispatch to the single-flight pending-request
            // handler. Lines arriving with no pending request are a
            // protocol invariant violation; log and drop rather than
            // crash (P2 doesn't have a server-push channel).
            if (this.pending !== null) {
              const p = this.pending;
              this.pending = null;
              p.resolve(parsed);
            }
            // else: drop silently (no current caller; future server-push
            // could land here).
          }
          idx = buffer.indexOf("\n");
        }
      });

      sock.on("error", (err: Error) => {
        if (!settled) {
          settle(() => reject(err));
        }
        this.rejectPending(err);
        this.handleDisconnect();
      });

      sock.on("close", () => {
        if (!settled) {
          settle(() => reject(new Error("ipc-client: socket closed during hello")));
        }
        this.rejectPending(new Error("ipc-client: socket closed"));
        this.handleDisconnect();
      });
    });
  }

  private rejectPending(err: Error): void {
    if (this.pending !== null) {
      const p = this.pending;
      this.pending = null;
      p.reject(err);
    }
  }

  // On unexpected disconnect (after a successful hello), schedule a
  // reconnect with exponential backoff. Skip if explicitly closed or if
  // the connection ended in version_mismatch (per Q-P2-002 Decision 5:
  // mismatch is fatal-until-restart, not auto-retried).
  private handleDisconnect(): void {
    this.socket = null;
    if (this.explicitlyClosed) return;
    if (this.state === "version_mismatch") return;
    this.state = "disconnected";
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt += 1;
    // Notify subscribers AFTER the counter increment. Subscriber receives
    // the new attempt count (1 on the first reconnect, 2 on the second).
    // Subscriber errors are swallowed; the reconnect machinery must
    // continue regardless of subscriber behavior. T-P2-005.
    if (this.onReconnectAttempt !== undefined) {
      try {
        this.onReconnectAttempt(this.reconnectAttempt);
      } catch {
        // intentional swallow — subscriber failures must not break reconnect
      }
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect().catch(() => {
        // doConnect's catch path already routes via handleDisconnect for
        // socket-level errors; for synchronous failures the reconnect
        // schedule will continue via the next disconnect signal.
      });
    }, delay);
  }
}

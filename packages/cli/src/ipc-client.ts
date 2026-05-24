// CLI side of the IPC channel. Reads the daemon's config to learn the
// socket path, connects via net.connect, sends one newline-delimited JSON
// request, reads one response line, returns the parsed IpcResponse.
//
// Path/address helpers and config loading were extracted to `util/` at
// T-0016 when the third use site (stop/status) needed them.

import { connect, type Socket } from "node:net";
import {
  IpcResponseSchema,
  type IpcRequest,
  type IpcResponse,
} from "@claude-bridge/shared";
import { addressFor, getCliConfigPath } from "./util/paths.js";
import { loadCliConfig } from "./util/config.js";

const DEFAULT_TIMEOUT_MS = 10000;

// IPC protocol version this CLI emits in the hello prelude. Pinned at "1.0"
// for P2; bumps independently of the package version when the wire shape
// changes. The daemon's IPC_DAEMON_VERSION (in daemon/src/ipc/server.ts)
// must match this for the hello gate to accept the connection.
const IPC_CLIENT_VERSION = "1.0";

export class IpcClientTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`IPC request timed out after ${timeoutMs}ms`);
    this.name = "IpcClientTimeoutError";
  }
}

export class IpcClientConnectionError extends Error {
  constructor(
    public readonly address: string,
    public readonly cause?: unknown,
  ) {
    super(`Cannot connect to daemon at ${address}`);
    this.name = "IpcClientConnectionError";
  }
}

export class IpcClientProtocolError extends Error {
  constructor(public readonly reason: string) {
    super(`IPC protocol error: ${reason}`);
    this.name = "IpcClientProtocolError";
  }
}

// Raised when the daemon's hello-gate rejects the CLI's version. Carries
// the daemon's reported versions for the user-facing stderr message. The
// CLI's reportError maps this to a distinct exit code (4) so scripts can
// distinguish version-skew failures from transient connection errors.
export class IpcClientVersionMismatchError extends Error {
  public readonly exitCode = 4;
  constructor(
    public readonly clientVersion: string,
    public readonly daemonVersion: string,
    public readonly minSupported: string,
  ) {
    super(
      `IPC version mismatch: CLI ${clientVersion}, daemon ${daemonVersion}, ` +
        `min supported ${minSupported}. Update one of them to continue.`,
    );
    this.name = "IpcClientVersionMismatchError";
  }
}

export interface SendIpcOpts {
  timeoutMs?: number;
  /** Bypass config loading and use this address directly. Test-only
   * (mirrors T-0008's IpcServer addressOverride for the same reason: the
   * single hardcoded Windows pipe name forces parallel tests to use
   * distinct addresses). Production callers omit this. */
  addressOverride?: string;
}

export async function sendIpc<R extends IpcResponse>(
  req: IpcRequest,
  opts: SendIpcOpts = {},
): Promise<R> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let address: string;
  if (opts.addressOverride !== undefined) {
    address = opts.addressOverride;
  } else {
    const config = await loadCliConfig(getCliConfigPath());
    address = addressFor(config.daemon.ipc_socket);
  }
  return performIpc<R>(address, req, timeoutMs);
}

function performIpc<R extends IpcResponse>(
  address: string,
  req: IpcRequest,
  timeoutMs: number,
): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    const client: Socket = connect(address);
    let buffer = "";
    let settled = false;
    // Two-phase line consumer: first parsed line must be hello_ok or
    // an error response; second is the real request's response. Refactored
    // at T-P2-002 when the daemon's hello-gate landed.
    let phase: "awaiting_hello_ok" | "awaiting_response" = "awaiting_hello_ok";

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      client.removeAllListeners();
      client.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        reject(new IpcClientTimeoutError(timeoutMs));
      });
    }, timeoutMs);

    client.setEncoding("utf8");

    client.on("connect", () => {
      const hello: IpcRequest = {
        kind: "hello",
        version: IPC_CLIENT_VERSION,
        role: "cli",
        pid: process.pid,
      };
      client.write(JSON.stringify(hello) + "\n");
    });

    client.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          const reason = err instanceof Error ? err.message : "JSON parse error";
          clearTimeout(timer);
          settle(() => {
            reject(new IpcClientProtocolError(reason));
          });
          return;
        }

        const result = IpcResponseSchema.safeParse(parsed);
        if (!result.success) {
          clearTimeout(timer);
          settle(() => {
            reject(
              new IpcClientProtocolError("response did not match IpcResponseSchema"),
            );
          });
          return;
        }

        const response = result.data;

        if (response.kind === "error") {
          clearTimeout(timer);
          if (response.reason === "version_mismatch") {
            // Daemon's mismatch message embeds its versions; surface via
            // the typed error so reportError can map to exit code 4.
            // Fallback values used only if a malformed daemon response
            // ever omits the structured shape (shouldn't happen).
            const match = /daemon\s+(\S+),\s+min supported\s+(\S+)/.exec(
              response.message,
            );
            const daemonVersion = match?.[1] ?? "unknown";
            const minSupported = match?.[2] ?? "unknown";
            settle(() => {
              reject(
                new IpcClientVersionMismatchError(
                  IPC_CLIENT_VERSION,
                  daemonVersion,
                  minSupported,
                ),
              );
            });
            return;
          }
          settle(() => {
            reject(new Error(response.message));
          });
          return;
        }

        if (phase === "awaiting_hello_ok") {
          if (response.kind !== "hello_ok") {
            clearTimeout(timer);
            settle(() => {
              reject(
                new IpcClientProtocolError(
                  `expected hello_ok, got ${response.kind}`,
                ),
              );
            });
            return;
          }
          // Hello accepted; send the real request now.
          phase = "awaiting_response";
          client.write(JSON.stringify(req) + "\n");
        } else {
          clearTimeout(timer);
          settle(() => {
            resolve(response as R);
          });
          return;
        }

        idx = buffer.indexOf("\n");
      }
    });

    client.on("error", (err: Error) => {
      clearTimeout(timer);
      settle(() => {
        reject(new IpcClientConnectionError(address, err));
      });
    });

    client.on("close", () => {
      if (!settled) {
        clearTimeout(timer);
        settle(() => {
          reject(
            new IpcClientConnectionError(
              address,
              new Error("connection closed without response"),
            ),
          );
        });
      }
    });
  });
}

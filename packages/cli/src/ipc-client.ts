// CLI side of the IPC channel. Reads the daemon's config to learn the
// socket path, connects via net.connect, sends one newline-delimited JSON
// request, reads one response line, returns the parsed IpcResponse.
//
// `getCliConfigPath` and `addressFor` are duplicated from
// `packages/daemon/src/config/paths.ts` and
// `packages/daemon/src/ipc/server.ts` respectively. T-0002 deliberately
// avoided a cli→daemon TS project reference (the IPC channel IS the
// boundary; static helpers shouldn't pull daemon into cli's type graph).
// Each helper is small; if either ever changes, both sides update.

import { connect, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ConfigSchema,
  IpcResponseSchema,
  type Config,
  type IpcRequest,
  type IpcResponse,
} from "@claude-bridge/shared";

const WINDOWS_PIPE_PATH = "\\\\.\\pipe\\claude-bridge";
const DEFAULT_TIMEOUT_MS = 10000;

function getCliConfigDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData === undefined || appData === "") {
      throw new Error("APPDATA environment variable is not set");
    }
    return join(appData, "claude-bridge");
  }
  const home = process.env.HOME ?? homedir();
  return join(home, ".claude-bridge");
}

function getCliConfigPath(): string {
  return join(getCliConfigDir(), "config.json");
}

function addressFor(socketPath: string): string {
  if (process.platform === "win32") {
    return WINDOWS_PIPE_PATH;
  }
  return socketPath;
}

async function loadCliConfig(path: string): Promise<Config> {
  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  return ConfigSchema.parse(parsed);
}

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
      client.write(JSON.stringify(req) + "\n");
    });

    client.on("data", (chunk: string) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      clearTimeout(timer);

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        const reason = err instanceof Error ? err.message : "JSON parse error";
        settle(() => {
          reject(new IpcClientProtocolError(reason));
        });
        return;
      }

      const result = IpcResponseSchema.safeParse(parsed);
      if (!result.success) {
        settle(() => {
          reject(
            new IpcClientProtocolError("response did not match IpcResponseSchema"),
          );
        });
        return;
      }

      const response = result.data;
      if (response.kind === "error") {
        settle(() => {
          reject(new Error(response.message));
        });
        return;
      }

      settle(() => {
        resolve(response as R);
      });
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

// Local IPC server for CLI ↔ daemon traffic. Cross-platform:
// Unix domain socket at `config.daemon.ipc_socket`, Windows named pipe at
// `\\.\pipe\claude-bridge`. Newline-delimited JSON per `protocol.ts`.
//
// Q005 closure: stale-socket cleanup on Unix uses connect-first probe before
// unlink; collision on either platform surfaces as IpcSocketBusyError.
//
// CC-2 (cross-platform paths/IPC), CC-3 (mode 0o600 on Unix), CC-6 (schema
// validation at the dispatch boundary via IpcRequestSchema.safeParse).

import { createServer, connect, type Server, type Socket } from "node:net";
import { unlink, chmod, stat } from "node:fs/promises";
import {
  IpcRequestSchema,
  type IpcRequest,
  type IpcResponse,
  type StatusPayload,
} from "@claude-bridge/shared";
import {
  encodeMessage,
  decodeMessage,
  IpcProtocolError,
  NEWLINE,
} from "./protocol.js";
import type { Logger } from "../log/logger.js";

const WINDOWS_PIPE_PATH = "\\\\.\\pipe\\claude-bridge";

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === code
  );
}

// Single source of truth for the platform-specific address transform.
// Tests bypass via the IpcServer constructor's `addressOverride` arg.
function addressFor(socketPath: string): string {
  if (process.platform === "win32") {
    return WINDOWS_PIPE_PATH;
  }
  return socketPath;
}

export interface IpcHandlers {
  status(): Promise<StatusPayload>;
  stop(): Promise<void>;
  tokenRotate(): Promise<{ new_token: string }>;
  tunnelRestart(): Promise<{ new_url: string }>;
}

export class IpcSocketBusyError extends Error {
  constructor(public readonly path: string) {
    super(`IPC socket busy at ${path}`);
    this.name = "IpcSocketBusyError";
  }
}

export class IpcServer {
  private readonly address: string;
  private readonly handlers: IpcHandlers;
  private readonly logger: Logger;
  private server: Server | null = null;
  private closed = false;

  constructor(
    socketPath: string,
    handlers: IpcHandlers,
    logger: Logger,
    addressOverride?: string,
  ) {
    this.address = addressOverride ?? addressFor(socketPath);
    this.handlers = handlers;
    this.logger = logger;
  }

  async start(): Promise<void> {
    if (process.platform !== "win32") {
      await this.cleanupStaleSocket();
    }

    const server = createServer((socket) => {
      this.handleConnection(socket);
    });

    server.on("error", (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn("ipc server error", { error: msg });
    });

    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      const onError = (err: unknown): void => {
        server.off("listening", onListening);
        if (isErrnoCode(err, "EADDRINUSE")) {
          reject(new IpcSocketBusyError(this.address));
        } else {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      server.once("listening", onListening);
      server.once("error", onError);
      server.listen(this.address);
    });

    if (process.platform !== "win32") {
      // chmod after listen succeeds so the socket file is owner-only.
      try {
        await chmod(this.address, 0o600);
      } catch {
        // Best-effort — if chmod fails the socket is still functional.
      }
    }

    this.server = server;
  }

  private async cleanupStaleSocket(): Promise<void> {
    let exists = true;
    try {
      await stat(this.address);
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) {
        exists = false;
      } else {
        throw err;
      }
    }
    if (!exists) return;

    const probe = await this.probeConnect();
    if (probe === "alive") {
      throw new IpcSocketBusyError(this.address);
    }
    if (probe === "stale") {
      try {
        await unlink(this.address);
      } catch (err) {
        if (!isErrnoCode(err, "ENOENT")) throw err;
      }
      this.logger.info("ipc: cleaned up stale socket", { path: this.address });
      return;
    }
    // probe === "uncertain" — refuse to clobber.
    throw new IpcSocketBusyError(this.address);
  }

  private probeConnect(): Promise<"alive" | "stale" | "uncertain"> {
    return new Promise((resolve) => {
      const client = connect(this.address);
      const cleanup = (): void => {
        client.removeAllListeners();
        client.destroy();
      };
      client.once("connect", () => {
        cleanup();
        resolve("alive");
      });
      client.once("error", (err: unknown) => {
        cleanup();
        if (
          isErrnoCode(err, "ECONNREFUSED") ||
          isErrnoCode(err, "ENOENT")
        ) {
          resolve("stale");
        } else {
          resolve("uncertain");
        }
      });
    });
  }

  private handleConnection(socket: Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIdx = buffer.indexOf(NEWLINE);
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        void this.dispatchLine(socket, line);
        newlineIdx = buffer.indexOf(NEWLINE);
      }
    });

    socket.on("error", (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn("ipc socket error", { error: msg });
      socket.destroy();
    });

    socket.on("end", () => {
      socket.end();
    });
  }

  private async dispatchLine(socket: Socket, line: string): Promise<void> {
    let request: IpcRequest;
    try {
      const parsed = decodeMessage(line);
      const result = IpcRequestSchema.safeParse(parsed);
      if (!result.success) {
        await this.writeResponse(socket, {
          kind: "error",
          message: "protocol: unknown request kind",
        });
        return;
      }
      request = result.data;
    } catch (err) {
      if (err instanceof IpcProtocolError) {
        await this.writeResponse(socket, {
          kind: "error",
          message: `protocol: ${err.reason}`,
        });
        return;
      }
      // Anything else is unexpected — surface and close the socket via the
      // error handler.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn("ipc dispatch error", { error: msg });
      return;
    }

    try {
      const response = await this.handleRequest(request);
      await this.writeResponse(socket, response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.writeResponse(socket, { kind: "error", message }).catch(
        (writeErr: unknown) => {
          const wmsg =
            writeErr instanceof Error ? writeErr.message : String(writeErr);
          this.logger.warn("ipc write error", { error: wmsg });
        },
      );
    }
  }

  private async handleRequest(request: IpcRequest): Promise<IpcResponse> {
    switch (request.kind) {
      case "status": {
        const payload = await this.handlers.status();
        return { kind: "status_ok", payload };
      }
      case "stop": {
        await this.handlers.stop();
        return { kind: "stop_ok" };
      }
      case "token_rotate": {
        const { new_token } = await this.handlers.tokenRotate();
        return { kind: "token_rotate_ok", new_token };
      }
      case "tunnel_restart": {
        const { new_url } = await this.handlers.tunnelRestart();
        return { kind: "tunnel_restart_ok", new_url };
      }
    }
  }

  private writeResponse(socket: Socket, response: IpcResponse): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.write(encodeMessage(response), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const server = this.server;
    if (server !== null) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      this.server = null;
    }
    if (process.platform !== "win32") {
      try {
        await unlink(this.address);
      } catch {
        // Best-effort. The socket may already be gone if stop ran after a
        // failed start, or if cleanupStaleSocket already removed it.
      }
    }
  }
}

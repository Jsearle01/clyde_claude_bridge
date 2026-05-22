// MCP server skeleton + HTTP transport + bearer-token auth (build plan §4.1,
// first two slices). Bound to 127.0.0.1 by default; the tunnel (T-0012)
// routes external traffic here. This slice ships auth (T-0010 / AC-4) but
// no tools (T-0011 — closes AC-3, AC-5). The server announces the `tools`
// capability but registers zero tools.
//
// Documentation-first: this implementation targets `@modelcontextprotocol/sdk`
// v1.29, which exposes `Server` from `server/index.js` and
// `StreamableHTTPServerTransport` from `server/streamableHttp.js`. The
// transport's `handleRequest(req, res)` is what the HTTP listener calls
// per-request after authentication.

import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "../log/logger.js";
import type { AuditLog } from "../audit/log.js";
import { authenticate, type AuthFailureReason } from "./auth.js";
import { onceOrError, promisifyCallback } from "../util/promises.js";

const localRequire = createRequire(import.meta.url);
const pkg = localRequire("../../package.json") as { version: string };

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === code
  );
}

function generateRequestId(): string {
  return "req_" + randomBytes(4).toString("hex");
}

export interface McpServerOpts {
  bindHost: string;
  bindPort: number;
  logger: Logger;
  // Thunk for the expected token — read fresh on every request so token
  // rotation (T-0017) takes effect without recreating the server.
  getExpectedToken: () => string;
  auditLog: AuditLog;
}

export class McpBindError extends Error {
  constructor(
    public readonly host: string,
    public readonly port: number,
  ) {
    super(`MCP server cannot bind to ${host}:${port}`);
    this.name = "McpBindError";
  }
}

export class McpServer {
  private readonly opts: McpServerOpts;
  private httpServer: HttpServer | null = null;
  private mcpServer: McpSdkServer | null = null;
  private transport: StreamableHTTPServerTransport | null = null;
  private closed = false;

  constructor(opts: McpServerOpts) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const mcp = new McpSdkServer(
      { name: "claude-bridge-daemon", version: pkg.version },
      { capabilities: { tools: {} } },
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await mcp.connect(transport);

    const httpServer = createHttpServer(
      (req: IncomingMessage, res: ServerResponse) => {
        this.handleHttpRequest(req, res, transport);
      },
    );
    httpServer.on("error", (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.logger.warn("mcp http server error", { error: msg });
    });

    const listenSettled = onceOrError<void>(httpServer, "listening", "error");
    httpServer.listen(this.opts.bindPort, this.opts.bindHost);
    try {
      await listenSettled;
    } catch (err) {
      await mcp.close().catch(() => undefined);
      if (isErrnoCode(err, "EADDRINUSE")) {
        throw new McpBindError(this.opts.bindHost, this.opts.bindPort);
      }
      throw err;
    }

    this.mcpServer = mcp;
    this.transport = transport;
    this.httpServer = httpServer;

    const bound = this.address();
    this.opts.logger.info("mcp server listening", {
      host: bound?.host ?? this.opts.bindHost,
      port: bound?.port ?? this.opts.bindPort,
    });
  }

  private handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    transport: StreamableHTTPServerTransport,
  ): void {
    const requestId = generateRequestId();
    const remoteAddr = req.socket.remoteAddress ?? "unknown";
    const startMs = Date.now();

    const authResult = authenticate(req, this.opts.getExpectedToken());
    if (!authResult.ok) {
      // Per AC-9 / 01-p0-bus.md §Auth: 401 with no body, no
      // WWW-Authenticate header (defensive against scheme advertisement).
      res.writeHead(401);
      res.end();
      const durationMs = Date.now() - startMs;
      void this.auditAuthFailure({
        reason: authResult.reason,
        requestId,
        remoteAddr,
        durationMs,
      });
      return;
    }

    // Authenticated — delegate to the MCP transport. Per-tool audit lands at
    // T-0011 (closes AC-5).
    void transport.handleRequest(req, res).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.logger.warn("mcp transport.handleRequest failed", {
        error: msg,
        request_id: requestId,
      });
    });
  }

  private async auditAuthFailure(args: {
    reason: AuthFailureReason;
    requestId: string;
    remoteAddr: string;
    durationMs: number;
  }): Promise<void> {
    try {
      await this.opts.auditLog.append({
        ts: new Date().toISOString(),
        // Sentinel for pre-dispatch failures; angle brackets keep these
        // grep-distinguishable from real tool entries (T-0011).
        tool: "<auth>",
        // CC-4: never hash the presented token (a hash would be a side
        // channel testable against guessed tokens). The literal "sha256:n/a"
        // keeps the AuditEntry shape valid while signaling no hashable input.
        input_hash: "sha256:n/a",
        allowed: false,
        reason: args.reason,
        duration_ms: args.durationMs,
        result_bytes: 0,
        request_id: args.requestId,
        remote_addr: args.remoteAddr,
      });
    } catch (err) {
      // AuditLog already surfaces internal write failures to stderr via the
      // queue's catch. This catch keeps the void-discarded caller from
      // producing an unhandled rejection if the per-write Promise rejects.
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.logger.warn("audit-write failed for auth rejection", {
        error: msg,
        request_id: args.requestId,
      });
    }
  }

  address(): { host: string; port: number } | null {
    if (this.httpServer === null) return null;
    const addr = this.httpServer.address();
    if (addr === null || typeof addr === "string") return null;
    return { host: addr.address, port: addr.port };
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const httpServer = this.httpServer;
    if (httpServer !== null) {
      await promisifyCallback((cb) => {
        httpServer.close(cb);
      });
      this.httpServer = null;
    }

    if (this.mcpServer !== null) {
      await this.mcpServer.close();
      this.mcpServer = null;
    }

    this.transport = null;
  }
}

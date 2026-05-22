// MCP server skeleton + HTTP transport (build plan §4.1 first slice).
// Bound to 127.0.0.1 by default; the tunnel (T-0012) routes external traffic
// here. This slice ships NO auth (T-0010) and NO tools (T-0011). The server
// announces the `tools` capability but registers zero tools.
//
// Documentation-first: this implementation targets `@modelcontextprotocol/sdk`
// v1.29, which exposes `Server` from `server/index.js` and
// `StreamableHTTPServerTransport` from `server/streamableHttp.js`. The
// transport's `handleRequest(req, res)` is what the HTTP listener calls
// per-request.

import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "../log/logger.js";
import { onceOrError, promisifyCallback } from "../util/promises.js";

// Daemon version from this package's own package.json. createRequire is
// used instead of an ESM JSON import to keep the relative path lookup
// stable across dev (src/) vs built (dist/) layouts — both resolve to the
// same package.json one level up from this file's package boundary.
const localRequire = createRequire(import.meta.url);
const pkg = localRequire("../../package.json") as { version: string };

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === code
  );
}

export interface McpServerOpts {
  bindHost: string;
  bindPort: number;
  logger: Logger;
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

    // Stateless mode — no per-client session tracking in P0. Each request
    // is independent. T-0011's tool dispatch and T-0010's auth middleware
    // build on top of this.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await mcp.connect(transport);

    const httpServer = createHttpServer(
      (req: IncomingMessage, res: ServerResponse) => {
        void transport.handleRequest(req, res);
      },
    );

    // Persistent error listener — fires for runtime errors after listen
    // succeeds (the listen-phase error is captured by onceOrError below).
    httpServer.on("error", (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.logger.warn("mcp http server error", { error: msg });
    });

    const listenSettled = onceOrError<void>(httpServer, "listening", "error");
    httpServer.listen(this.opts.bindPort, this.opts.bindHost);
    try {
      await listenSettled;
    } catch (err) {
      // Roll back the SDK-side setup if listen failed.
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

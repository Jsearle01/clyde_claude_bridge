// MCP server + HTTP transport + bearer-token auth + tool dispatch
// (build plan §4.1, complete). Bound to 127.0.0.1 by default; the tunnel
// (T-0012) routes external traffic here.
//
// Targets `@modelcontextprotocol/sdk` v1.29 with `StreamableHTTPServerTransport`
// in stateless mode. Tools/list and tools/call dispatch through the project's
// own `ToolRegistry` (T-0011) which centralizes per-call auditing.
//
// Per-request context (request_id, remote_addr) is plumbed through
// AsyncLocalStorage so the SDK's request handler callbacks can read it
// without coupling to the HTTP-level handler.

import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../log/logger.js";
import type { AuditLog } from "../audit/log.js";
import type { DaemonState } from "../state.js";
import {
  authenticate,
  type AuthFailureReason,
  type WorkspaceBinding,
  type OAuthTokenLookup,
} from "./auth.js";
import { onceOrError, promisifyCallback } from "../util/promises.js";
import {
  ToolRegistry,
  ToolNotFoundError,
  ToolInputError,
  type ToolContext,
} from "./dispatch.js";

const localRequire = createRequire(import.meta.url);
const pkg = localRequire("../../package.json") as { version: string };

interface RequestContextData {
  request_id: string;
  remote_addr: string;
  // T-P2-008.7 (C-30): the MCP session id from the `Mcp-Session-Id`
  // request header (SDK stateful mode echoes it on every post-initialize
  // request). Undefined on the initialize request itself; present on
  // tools/call. Threaded into ToolContext so the approval gate can key
  // session-bypass state by (mcp_session_id + workspace_id).
  mcp_session_id?: string;
  // T-P3-004a: the authenticated request's workspace binding (from
  // authenticate()). Threaded into ToolContext so tool handlers enforce
  // that an OAuth-bound token acts only on its bound workspace.
  workspace_binding?: WorkspaceBinding;
}

// Module-scope ALS — one per process. Each HTTP request runs its async
// continuation inside `requestContext.run({...}, ...)`; the SDK's request
// handler callbacks read via `requestContext.getStore()`.
const requestContext = new AsyncLocalStorage<RequestContextData>();

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === code
  );
}

function generateRequestId(): string {
  return "req_" + randomBytes(4).toString("hex");
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown";
}

export interface McpServerOpts {
  bindHost: string;
  bindPort: number;
  logger: Logger;
  getExpectedToken: () => string;
  auditLog: AuditLog;
  state: DaemonState;
  registry: ToolRegistry;
  // T-P3-001: OAuth bootstrap handler. Routes `/.well-known/oauth-
  // authorization-server` and `/register` BEFORE the Bearer auth check
  // (both endpoints are unauthenticated by RFC 8414 / RFC 7591 design).
  // Returns true when the request was handled (caller short-circuits);
  // false when the request should fall through to MCP routing.
  oauthHandler?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  // T-P3-004a: resolve a presented OAuth access token to its binding (wraps
  // TokenStore.lookup). Optional — when absent, only the static Bearer
  // authenticates (legacy behavior; all OAuth tokens fail as invalid_token).
  lookupOAuthToken?: OAuthTokenLookup;
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

    // Wire tools/list and tools/call to the project's ToolRegistry. The
    // request_id and remote_addr for the ToolContext come from
    // AsyncLocalStorage set at the HTTP listener level.
    mcp.setRequestHandler(ListToolsRequestSchema, () => {
      return Promise.resolve({ tools: this.opts.registry.list() });
    });

    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      return this.handleToolsCall(request.params.name, request.params.arguments);
    });

    // Stateful mode: the SDK generates a session ID on initialize and the
    // client echoes it on subsequent requests. Stateless mode (passing
    // `sessionIdGenerator: undefined`) was tried first but the SDK v1.29
    // returns 500 on the `notifications/initialized` follow-up in that mode.
    // Per-process session scope is fine for P0 (one Claude.ai connector
    // per daemon).
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await mcp.connect(transport);

    const httpServer = createHttpServer(
      (req: IncomingMessage, res: ServerResponse) => {
        this.handleHttpRequest(req, res, transport);
      },
    );
    httpServer.on("error", (err: unknown) => {
      this.opts.logger.warn("mcp http server error", { error: errorMessage(err) });
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
    // T-P2-008.7 (C-30): capture the MCP session id (Node lowercases
    // header names). Present on tools/call in stateful mode; used to key
    // approval-gate session-bypass state.
    const sessionHeader = req.headers["mcp-session-id"];
    const mcpSessionId =
      typeof sessionHeader === "string" ? sessionHeader : undefined;
    const startMs = Date.now();

    // T-P3-001: OAuth bootstrap routing runs BEFORE the Bearer auth
    // check. The two OAuth endpoints (`/.well-known/oauth-authorization-
    // server` and `/register`) are unauthenticated by spec; routing them
    // through `authenticate` would 401 valid discovery + DCR traffic.
    // The handler returns `true` when it consumed the request (we exit);
    // `false` when the URL didn't match its routes (fall through to MCP).
    if (this.opts.oauthHandler !== undefined) {
      const oauthHandler = this.opts.oauthHandler;
      void oauthHandler(req, res).then(
        (handled) => {
          if (handled) return;
          this.handleMcpAfterOAuthMiss(req, res, transport, requestId, remoteAddr, mcpSessionId, startMs);
        },
        (err: unknown) => {
          this.opts.logger.warn("mcp oauth handler failed", {
            error: errorMessage(err),
            request_id: requestId,
          });
          // Best-effort: if the response isn't written yet, close cleanly.
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        },
      );
      return;
    }

    this.handleMcpAfterOAuthMiss(req, res, transport, requestId, remoteAddr, mcpSessionId, startMs);
  }

  private handleMcpAfterOAuthMiss(
    req: IncomingMessage,
    res: ServerResponse,
    transport: StreamableHTTPServerTransport,
    requestId: string,
    remoteAddr: string,
    mcpSessionId: string | undefined,
    startMs: number,
  ): void {
    const authResult = authenticate(
      req,
      this.opts.getExpectedToken(),
      this.opts.lookupOAuthToken,
    );
    if (!authResult.ok) {
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

    // Authenticated — run the SDK dispatch inside an ALS context so the
    // tools/call handler can read request_id, remote_addr, and the
    // workspace binding (T-P3-004a) the enforcement layer uses.
    void requestContext.run(
      {
        request_id: requestId,
        remote_addr: remoteAddr,
        mcp_session_id: mcpSessionId,
        workspace_binding: authResult.binding,
      },
      () =>
        transport.handleRequest(req, res).catch((err: unknown) => {
          this.opts.logger.warn("mcp transport.handleRequest failed", {
            error: errorMessage(err),
            request_id: requestId,
          });
        }),
    );
  }

  private async handleToolsCall(
    name: string,
    args: unknown,
  ): Promise<CallToolResult> {
    const ctxData = requestContext.getStore();
    if (ctxData === undefined) {
      // Should not happen — handleHttpRequest always runs the SDK dispatch
      // inside ALS. Defensive: if it does, we still produce a well-formed
      // CallToolResult rather than throwing into the SDK.
      return {
        content: [
          { type: "text", text: "internal error: missing request context" },
        ],
        isError: true,
      };
    }

    // setAuditMetadata is injected by ToolRegistry.invoke; the McpServer
    // hands invoke a base ctx without it.
    const ctx: Omit<ToolContext, "setAuditMetadata"> = {
      request_id: ctxData.request_id,
      remote_addr: ctxData.remote_addr,
      mcp_session_id: ctxData.mcp_session_id,
      workspaceBinding: ctxData.workspace_binding,
      auditLog: this.opts.auditLog,
      logger: this.opts.logger,
      state: this.opts.state,
    };

    try {
      const output = await this.opts.registry.invoke(name, args, ctx);
      // Wrap the tool's structured output as both a text content block (the
      // SDK's required surface) and a structuredContent record (typed JSON
      // for clients that want it without re-parsing the text).
      const text = JSON.stringify(output);
      const result: CallToolResult = {
        content: [{ type: "text", text: text ?? "" }],
      };
      if (typeof output === "object" && output !== null && !Array.isArray(output)) {
        result.structuredContent = output as Record<string, unknown>;
      }
      return result;
    } catch (err) {
      let text: string;
      if (err instanceof ToolNotFoundError) {
        text = `tool not found: ${err.toolName}`;
      } else if (err instanceof ToolInputError) {
        text = `invalid input: ${err.message}`;
      } else {
        text = `internal error: ${errorMessage(err)}`;
      }
      return {
        content: [{ type: "text", text }],
        isError: true,
      };
    }
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
        tool: "<auth>",
        input_hash: "sha256:n/a",
        allowed: false,
        reason: args.reason,
        duration_ms: args.durationMs,
        result_bytes: 0,
        request_id: args.requestId,
        remote_addr: args.remoteAddr,
      });
    } catch (err) {
      this.opts.logger.warn("audit-write failed for auth rejection", {
        error: errorMessage(err),
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

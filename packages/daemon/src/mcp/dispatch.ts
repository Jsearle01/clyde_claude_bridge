// Tool registry + centralized dispatch. Single audit-write point for both
// success and failure paths (input validation, handler exception,
// successful handler return). Per CC-4 the audit-write hashes the
// validated input (after Zod parse), never raw token-bearing or
// unvalidated input.
//
// The build plan §4.1 specifies this registry shape so that P1+ tools
// (delegate_to_claude_code, etc.) plug in without dispatch-side changes.

import { z } from "zod";
import type { AuditLog } from "../audit/log.js";
import type { Logger } from "../log/logger.js";
import type { DaemonState } from "../state.js";
import { hashInput } from "../audit/hash.js";
import type { WorkspaceBinding } from "./auth.js";

/** Optional metadata a tool handler may attach to its audit entry.
 * P1 delegation tools use this to record job_id + workspace_id. P0 tools
 * (ping) leave it untouched and produce audit entries with these fields
 * absent. Set via `ctx.setAuditMetadata({...})` from inside the handler;
 * dispatch reads it after the handler returns and merges into the audit
 * write. Multiple calls in the same handler overwrite (last write wins). */
export interface AuditMetadata {
  job_id?: string;
  workspace_id?: string;
}

export interface ToolContext {
  readonly request_id: string;
  readonly remote_addr: string;
  // T-P2-008.7 (C-30): MCP session id (from the Mcp-Session-Id header).
  // Optional so P0 ctx-construction sites (tests, ping) compile without
  // change. The approval gate uses it to key session-bypass state by
  // (mcp_session_id + workspace_id) so bypass never leaks across sessions.
  readonly mcp_session_id?: string;
  // T-P3-004a: the authenticated request's workspace binding. Optional so
  // P0 ctx-construction sites (tests, ping) compile unchanged; undefined is
  // treated as "unconstrained" (legacy global) by the enforcement helper.
  readonly workspaceBinding?: WorkspaceBinding;
  readonly auditLog: AuditLog;
  readonly logger: Logger;
  readonly state: DaemonState;
  /** Optional in the type so existing P0 ctx-construction sites
   * (tests, mcp/server.ts) compile without change. The ToolRegistry's
   * invoke() always wraps the ctx with a real setAuditMetadata before
   * calling the handler, so inside a handler this is always defined. */
  setAuditMetadata?(meta: AuditMetadata): void;
}

/** Thrown by tool handlers for handler-level rejections (400/404/503 etc.).
 * Dispatch surfaces `code` + `reason` in the audit entry's `reason` field;
 * the MCP server layer maps them to client-facing error responses. */
export class ToolHandlerError extends Error {
  constructor(
    public readonly code: number,
    public readonly reason: string,
    message?: string,
  ) {
    super(message ?? `${code} ${reason}`);
    this.name = "ToolHandlerError";
  }
}

export interface ToolDef<I, O> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<I>;
  handler(input: I, ctx: ToolContext): Promise<O>;
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown; // JSON Schema, per MCP wire format
}

export class ToolNotFoundError extends Error {
  constructor(public readonly toolName: string) {
    super(`Tool not found: ${toolName}`);
    this.name = "ToolNotFoundError";
  }
}

export class ToolInputError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly issues: unknown,
  ) {
    super(`Invalid input for tool ${toolName}`);
    this.name = "ToolInputError";
  }
}

export class DuplicateToolError extends Error {
  constructor(public readonly toolName: string) {
    super(`Tool already registered: ${toolName}`);
    this.name = "DuplicateToolError";
  }
}

function errorReason(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "non-Error thrown";
}

function serializedLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : serialized.length;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef<unknown, unknown>>();

  register<I, O>(def: ToolDef<I, O>): void {
    if (this.tools.has(def.name)) {
      throw new DuplicateToolError(def.name);
    }
    // TS variance accepts the wider ToolDef<unknown, unknown> map type for
    // a more specific ToolDef<I, O>; we re-validate via def.inputSchema in
    // invoke() before passing to the handler.
    this.tools.set(def.name, def);
  }

  list(): McpToolDescriptor[] {
    return Array.from(this.tools.values()).map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: z.toJSONSchema(def.inputSchema),
    }));
  }

  async invoke(
    name: string,
    rawInput: unknown,
    ctx: Omit<ToolContext, "setAuditMetadata">,
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new ToolNotFoundError(name);
    }

    // Per-invocation metadata holder. Handlers populate via
    // ctx.setAuditMetadata; dispatch reads at audit-write time.
    let captured: AuditMetadata = {};
    const handlerCtx: ToolContext = {
      ...ctx,
      setAuditMetadata: (meta: AuditMetadata): void => {
        captured = { ...captured, ...meta };
      },
    };

    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      // Audit invalid-input then re-throw the typed error.
      await this.tryAudit(ctx, {
        ts: new Date().toISOString(),
        tool: tool.name,
        input_hash: hashInput(rawInput),
        allowed: false,
        reason: "invalid_input",
        duration_ms: 0,
        result_bytes: 0,
        request_id: ctx.request_id,
        remote_addr: ctx.remote_addr,
      });
      throw new ToolInputError(tool.name, parsed.error.format());
    }

    // performance.now() (not Date.now) so sub-ms tools still report >= 1ms
    // after Math.ceil — Date.now's millisecond granularity rounds fast
    // operations to 0, which violates AC-5's "non-zero duration_ms" check.
    const startMs = performance.now();
    try {
      const output = await tool.handler(parsed.data, handlerCtx);
      const durationMs = Math.ceil(performance.now() - startMs);
      await this.tryAudit(ctx, {
        ts: new Date().toISOString(),
        tool: tool.name,
        input_hash: hashInput(parsed.data),
        allowed: true,
        duration_ms: durationMs,
        result_bytes: serializedLength(output),
        request_id: ctx.request_id,
        remote_addr: ctx.remote_addr,
        ...(captured.job_id !== undefined ? { job_id: captured.job_id } : {}),
        ...(captured.workspace_id !== undefined
          ? { workspace_id: captured.workspace_id }
          : {}),
      });
      return output;
    } catch (err) {
      const durationMs = Math.ceil(performance.now() - startMs);
      await this.tryAudit(ctx, {
        ts: new Date().toISOString(),
        tool: tool.name,
        input_hash: hashInput(parsed.data),
        // allowed:true reflects "the request was authenticated and
        // dispatched" — the failure is internal to the handler, not an
        // auth rejection.
        allowed: true,
        reason: errorReason(err),
        duration_ms: durationMs,
        result_bytes: 0,
        request_id: ctx.request_id,
        remote_addr: ctx.remote_addr,
        ...(captured.job_id !== undefined ? { job_id: captured.job_id } : {}),
        ...(captured.workspace_id !== undefined
          ? { workspace_id: captured.workspace_id }
          : {}),
      });
      throw err;
    }
  }

  private async tryAudit(
    ctx: Omit<ToolContext, "setAuditMetadata">,
    entry: Parameters<AuditLog["append"]>[0],
  ): Promise<void> {
    try {
      await ctx.auditLog.append(entry);
    } catch (err) {
      // AuditLog already surfaces internal failures to stderr via its queue
      // catch. This keeps the per-write Promise rejection from disrupting
      // the dispatch flow.
      ctx.logger.warn("audit-write failed during dispatch", {
        error: errorReason(err),
        tool: entry.tool,
        request_id: ctx.request_id,
      });
    }
  }
}

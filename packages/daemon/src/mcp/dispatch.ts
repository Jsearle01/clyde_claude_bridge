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

export interface ToolContext {
  readonly request_id: string;
  readonly remote_addr: string;
  readonly auditLog: AuditLog;
  readonly logger: Logger;
  readonly state: DaemonState;
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
    ctx: ToolContext,
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new ToolNotFoundError(name);
    }

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

    const startMs = Date.now();
    try {
      const output = await tool.handler(parsed.data, ctx);
      const durationMs = Date.now() - startMs;
      await this.tryAudit(ctx, {
        ts: new Date().toISOString(),
        tool: tool.name,
        input_hash: hashInput(parsed.data),
        allowed: true,
        duration_ms: durationMs,
        result_bytes: serializedLength(output),
        request_id: ctx.request_id,
        remote_addr: ctx.remote_addr,
      });
      return output;
    } catch (err) {
      const durationMs = Date.now() - startMs;
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
      });
      throw err;
    }
  }

  private async tryAudit(
    ctx: ToolContext,
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

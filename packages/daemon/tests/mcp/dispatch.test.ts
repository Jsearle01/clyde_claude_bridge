import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AuditEntry, Config } from "@claude-bridge/shared";
import {
  ToolRegistry,
  ToolNotFoundError,
  ToolInputError,
  DuplicateToolError,
  type ToolContext,
  type ToolDef,
} from "../../src/mcp/dispatch.js";
import { AuditLog } from "../../src/audit/log.js";
import type { Logger } from "../../src/log/logger.js";
import { makeInitialState } from "../../src/state.js";

const stubConfig: Config = {
  version: 1,
  daemon: {
    bind_host: "127.0.0.1",
    bind_port: 7423,
    ipc_socket: "/tmp/test.sock",
  },
  auth: { token: "cb_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
  tunnel: { provider: "cloudflared", binary: "cloudflared", args_extra: [] },
  audit: { path: "/tmp/audit.jsonl", retention_days: 30 },
  log: { path: "/tmp/daemon.log", level: "info" },
};

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};

interface EchoIn {
  text: string;
}
interface EchoOut {
  echoed: string;
}

const echoTool: ToolDef<EchoIn, EchoOut> = {
  name: "echo",
  description: "Echoes input back.",
  inputSchema: z.object({ text: z.string() }).strict(),
  handler(input) {
    return Promise.resolve({ echoed: input.text });
  },
};

const explodeTool: ToolDef<{ kind?: string }, never> = {
  name: "explode",
  description: "Always throws.",
  inputSchema: z.object({ kind: z.string().optional() }).strict(),
  handler() {
    return Promise.reject(new Error("kaboom"));
  },
};

describe("ToolRegistry", () => {
  let tempDir: string;
  let auditPath: string;
  let auditLog: AuditLog;
  let ctx: ToolContext;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-dispatch-"));
    auditPath = join(tempDir, "audit.jsonl");
    auditLog = new AuditLog(auditPath, 30);
    ctx = {
      request_id: "req_test0001",
      remote_addr: "127.0.0.1",
      auditLog,
      logger: silentLogger,
      state: makeInitialState(stubConfig),
    };
  });

  afterEach(async () => {
    await auditLog.stop().catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true });
  });

  async function readAuditEntries(): Promise<AuditEntry[]> {
    try {
      const content = await readFile(auditPath, "utf8");
      return content
        .trim()
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as AuditEntry);
    } catch {
      return [];
    }
  }

  it("register + list returns JSON-Schema descriptor (15.a)", () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("echo");
    expect(list[0]?.description).toBe("Echoes input back.");
    // inputSchema should be a JSON-Schema-shaped object, not a Zod schema.
    const schema = list[0]?.inputSchema as Record<string, unknown>;
    expect(schema).toBeDefined();
    expect(schema["type"]).toBe("object");
  });

  it("duplicate registration throws DuplicateToolError (15.b)", () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    expect(() => reg.register(echoTool)).toThrow(DuplicateToolError);
  });

  it("invoke with valid input runs the handler and returns output (15.c)", async () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    const out = (await reg.invoke("echo", { text: "hello" }, ctx)) as EchoOut;
    expect(out.echoed).toBe("hello");
  });

  it("invoke with unknown tool throws ToolNotFoundError (15.d)", async () => {
    const reg = new ToolRegistry();
    await expect(reg.invoke("nope", {}, ctx)).rejects.toBeInstanceOf(
      ToolNotFoundError,
    );
  });

  it("invoke with invalid input throws ToolInputError (15.e)", async () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    await expect(reg.invoke("echo", {}, ctx)).rejects.toBeInstanceOf(
      ToolInputError,
    );
  });

  it("invoke writes audit entry on success (15.f)", async () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    await reg.invoke("echo", { text: "hello" }, ctx);
    await auditLog.stop();
    const entries = await readAuditEntries();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.tool).toBe("echo");
    expect(entry?.allowed).toBe(true);
    expect(entry?.input_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(entry?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(entry?.result_bytes).toBeGreaterThan(0);
    expect(entry?.request_id).toBe("req_test0001");
    expect(entry?.remote_addr).toBe("127.0.0.1");
  });

  it("invoke writes audit entry then re-throws on handler exception (15.g)", async () => {
    const reg = new ToolRegistry();
    reg.register(explodeTool);
    await expect(reg.invoke("explode", {}, ctx)).rejects.toThrow("kaboom");
    await auditLog.stop();
    const entries = await readAuditEntries();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.tool).toBe("explode");
    expect(entry?.allowed).toBe(true); // request was authenticated; failure was internal
    expect(entry?.reason).toBe("kaboom");
    expect(entry?.result_bytes).toBe(0);
  });

  it("invoke writes audit entry on input validation failure (15.h)", async () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    await expect(reg.invoke("echo", {}, ctx)).rejects.toBeInstanceOf(
      ToolInputError,
    );
    await auditLog.stop();
    const entries = await readAuditEntries();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.tool).toBe("echo");
    expect(entry?.allowed).toBe(false);
    expect(entry?.reason).toBe("invalid_input");
  });
});

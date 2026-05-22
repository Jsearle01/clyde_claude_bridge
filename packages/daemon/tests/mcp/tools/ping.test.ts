import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PingOutput } from "@claude-bridge/shared";
import { ToolRegistry, ToolInputError, type ToolContext } from "../../../src/mcp/dispatch.js";
import { pingTool } from "../../../src/mcp/tools/ping.js";
import { AuditLog } from "../../../src/audit/log.js";
import type { Logger } from "../../../src/log/logger.js";
import type { DaemonState } from "../../../src/state.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};

function makeCtx(opts: {
  auditLog: AuditLog;
  state: DaemonState;
}): ToolContext {
  return {
    request_id: "req_ping0000",
    remote_addr: "127.0.0.1",
    auditLog: opts.auditLog,
    logger: silentLogger,
    state: opts.state,
  };
}

function makeState(opts: {
  version?: string;
  startedAt?: number;
  tunnelStatus?: "up" | "degraded" | "down";
}): DaemonState {
  return {
    version: opts.version ?? "0.1.0",
    startedAt: opts.startedAt ?? Date.now(),
    tunnelStatus: opts.tunnelStatus ?? "down",
    tunnelUrl: null,
  };
}

describe("pingTool", () => {
  let tempDir: string;
  let auditLog: AuditLog;
  let registry: ToolRegistry;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-ping-"));
    auditLog = new AuditLog(join(tempDir, "audit.jsonl"), 30);
    registry = new ToolRegistry();
    registry.register(pingTool);
  });

  afterEach(async () => {
    await auditLog.stop().catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true });
  });

  async function callPing(
    input: unknown,
    state: DaemonState,
  ): Promise<PingOutput> {
    const ctx = makeCtx({ auditLog, state });
    return (await registry.invoke("ping", input, ctx)) as PingOutput;
  }

  it("echoes the input message (16.a)", async () => {
    const out = await callPing({ message: "hello" }, makeState({}));
    expect(out.echo).toBe("hello");
  });

  it("echoes null when no message provided (16.b)", async () => {
    const out = await callPing({}, makeState({}));
    expect(out.echo).toBeNull();
  });

  it("rejects extra fields — .strict() schema (16.c)", async () => {
    await expect(
      callPing({ message: "hi", extra: "field" }, makeState({})),
    ).rejects.toBeInstanceOf(ToolInputError);
  });

  it("rejects message > 1024 chars (16.d)", async () => {
    const long = "x".repeat(1025);
    await expect(
      callPing({ message: long }, makeState({})),
    ).rejects.toBeInstanceOf(ToolInputError);
  });

  it("fills daemon_version from state (16.e)", async () => {
    const out = await callPing({}, makeState({ version: "9.9.9-test" }));
    expect(out.daemon_version).toBe("9.9.9-test");
  });

  it("fills uptime_s from state.startedAt (16.f)", async () => {
    const out = await callPing({}, makeState({ startedAt: Date.now() - 5000 }));
    // 5 seconds elapsed; allow 4 if Math.floor lands just under.
    expect(out.uptime_s).toBeGreaterThanOrEqual(4);
    expect(out.uptime_s).toBeLessThanOrEqual(6);
  });

  it("attached_workspaces is always 0 in P0 (16.g)", async () => {
    const out = await callPing({ message: "x" }, makeState({}));
    expect(out.attached_workspaces).toBe(0);
  });

  it("maps tunnelStatus 'down' to wire 'degraded'; passes 'up' and 'degraded' through (16.h)", async () => {
    const outUp = await callPing({}, makeState({ tunnelStatus: "up" }));
    expect(outUp.tunnel_status).toBe("up");

    const outDegraded = await callPing(
      {},
      makeState({ tunnelStatus: "degraded" }),
    );
    expect(outDegraded.tunnel_status).toBe("degraded");

    const outDown = await callPing({}, makeState({ tunnelStatus: "down" }));
    expect(outDown.tunnel_status).toBe("degraded");
  });
});

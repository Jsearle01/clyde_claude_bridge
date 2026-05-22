import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { request } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AuditEntry, Config, PingOutput } from "@claude-bridge/shared";
import { McpServer, McpBindError } from "../../src/mcp/server.js";
import { AuditLog } from "../../src/audit/log.js";
import { ToolRegistry } from "../../src/mcp/dispatch.js";
import { pingTool } from "../../src/mcp/tools/ping.js";
import { makeInitialState } from "../../src/state.js";
import type { Logger } from "../../src/log/logger.js";

const INERT_TOKEN = "cb_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const INERT_WRONG_TOKEN = "cb_live_WRONGWRONGWRONGWRONGWRONGWRONGWR";

const stubConfig: Config = {
  version: 1,
  daemon: {
    bind_host: "127.0.0.1",
    bind_port: 7423,
    ipc_socket: "/tmp/test.sock",
  },
  auth: { token: INERT_TOKEN },
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

// Plain HTTP GET — used by auth-layer tests (15.b, 15.g–15.j).
function getStatus(
  host: string,
  port: number,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: host, port, method: "GET", path: "/", headers },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("McpServer", () => {
  let tempDir: string;
  let servers: McpServer[] = [];
  let auditLogs: AuditLog[] = [];
  let clients: Client[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-mcp-"));
  });

  afterEach(async () => {
    for (const c of clients) {
      await c.close().catch(() => undefined);
    }
    for (const s of servers) {
      await s.stop().catch(() => undefined);
    }
    for (const a of auditLogs) {
      await a.stop().catch(() => undefined);
    }
    servers = [];
    auditLogs = [];
    clients = [];
    await rm(tempDir, { recursive: true, force: true });
  });

  function newServer(
    opts: {
      token?: string;
      bindHost?: string;
      bindPort?: number;
      withPing?: boolean;
    } = {},
  ): {
    server: McpServer;
    auditLog: AuditLog;
    auditPath: string;
    token: string;
    registry: ToolRegistry;
  } {
    const token = opts.token ?? INERT_TOKEN;
    const auditPath = join(tempDir, "audit.jsonl");
    const auditLog = new AuditLog(auditPath, 30);
    const registry = new ToolRegistry();
    if (opts.withPing !== false) {
      registry.register(pingTool);
    }
    const state = makeInitialState(stubConfig);
    const server = new McpServer({
      bindHost: opts.bindHost ?? "127.0.0.1",
      bindPort: opts.bindPort ?? 0,
      logger: silentLogger,
      getExpectedToken: () => token,
      auditLog,
      state,
      registry,
    });
    servers.push(server);
    auditLogs.push(auditLog);
    return { server, auditLog, auditPath, token, registry };
  }

  async function newConnectedClient(
    address: { host: string; port: number },
    token: string,
  ): Promise<Client> {
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${address.host}:${address.port}/`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    );
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  async function readAuditEntries(auditPath: string): Promise<AuditEntry[]> {
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

  it("starts and stops cleanly (15.a)", async () => {
    const { server } = newServer();
    await server.start();
    expect(server.address()).not.toBeNull();
    await server.stop();
    expect(server.address()).toBeNull();
  });

  it("HTTP endpoint responds with 401 when unauthenticated (15.b)", async () => {
    const { server } = newServer();
    await server.start();
    const addr = server.address();
    if (addr === null) throw new Error("expected bound address");
    expect(await getStatus(addr.host, addr.port)).toBe(401);
  });

  it("rejects with McpBindError on bind collision (15.c)", async () => {
    const { server: sA, auditLog, token, registry } = newServer();
    await sA.start();
    const addr = sA.address();
    if (addr === null) throw new Error("expected bound address");

    const sB = new McpServer({
      bindHost: "127.0.0.1",
      bindPort: addr.port,
      logger: silentLogger,
      getExpectedToken: () => token,
      auditLog,
      state: makeInitialState("0.1.0"),
      registry,
    });
    servers.push(sB);
    await expect(sB.start()).rejects.toBeInstanceOf(McpBindError);
  });

  it("stop is idempotent (15.d)", async () => {
    const { server } = newServer();
    await server.start();
    await server.stop();
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it("stop on a never-started server is a no-op (15.e)", async () => {
    const { server } = newServer();
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it("start fails on invalid bindHost (15.f)", async () => {
    const { server } = newServer({ bindHost: "999.999.999.999" });
    await expect(server.start()).rejects.toBeInstanceOf(Error);
  });

  it("missing Authorization returns 401 (15.g)", async () => {
    const { server } = newServer();
    await server.start();
    const addr = server.address();
    if (addr === null) throw new Error("expected bound address");
    expect(await getStatus(addr.host, addr.port)).toBe(401);
  });

  it("wrong token returns 401 + audit entry — AC-4 (15.h)", async () => {
    const { server, auditLog, auditPath } = newServer();
    await server.start();
    const addr = server.address();
    if (addr === null) throw new Error("expected bound address");

    expect(
      await getStatus(addr.host, addr.port, {
        Authorization: `Bearer ${INERT_WRONG_TOKEN}`,
      }),
    ).toBe(401);

    await server.stop();
    await auditLog.stop();

    const entries = await readAuditEntries(auditPath);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.tool).toBe("<auth>");
    expect(entry?.allowed).toBe(false);
    expect(entry?.reason).toBe("invalid_token");
    expect(entry?.input_hash).toBe("sha256:n/a");
    expect(entry?.request_id).toMatch(/^req_[a-f0-9]{8}$/);
  });

  it("correct token is not rejected at the auth layer (15.i)", async () => {
    const { server, token } = newServer();
    await server.start();
    const addr = server.address();
    if (addr === null) throw new Error("expected bound address");
    expect(
      await getStatus(addr.host, addr.port, {
        Authorization: `Bearer ${token}`,
      }),
    ).not.toBe(401);
  });

  it("correct token does not write an `<auth>` entry from T-0010 (15.j)", async () => {
    const { server, auditLog, auditPath, token } = newServer();
    await server.start();
    const addr = server.address();
    if (addr === null) throw new Error("expected bound address");

    await getStatus(addr.host, addr.port, {
      Authorization: `Bearer ${token}`,
    });

    await server.stop();
    await auditLog.stop();

    let content: string;
    try {
      content = await readFile(auditPath, "utf8");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
      content = "";
    }
    expect(content).not.toContain('"tool":"<auth>"');
  });

  it("tools/list returns the ping descriptor (17.a)", async () => {
    const { server, token } = newServer();
    await server.start();
    const addr = server.address();
    if (addr === null) throw new Error("expected bound address");

    const client = await newConnectedClient(addr, token);
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("ping");
    const ping = result.tools.find((t) => t.name === "ping");
    expect(ping?.description).toBe("Roundtrip test. Returns daemon liveness info.");
  });

  it("tools/call ping returns the expected response shape — AC-3 (17.b)", async () => {
    const { server, token } = newServer();
    await server.start();
    const addr = server.address();
    if (addr === null) throw new Error("expected bound address");

    const client = await newConnectedClient(addr, token);
    const result = await client.callTool({
      name: "ping",
      arguments: { message: "hello" },
    });
    expect(result.isError).toBeFalsy();
    // Prefer structuredContent if present; fall back to parsing text.
    let output: PingOutput;
    if (result.structuredContent !== undefined) {
      output = result.structuredContent as PingOutput;
    } else {
      const content = result.content as Array<{ type: string; text?: string }>;
      const text = content[0]?.text ?? "{}";
      output = JSON.parse(text) as PingOutput;
    }
    expect(output.echo).toBe("hello");
    expect(output.daemon_version).toBe("0.1.0");
    expect(output.attached_workspaces).toBe(0);
    expect(output.tunnel_status).toBe("degraded"); // initial state has tunnelStatus "down" → wire "degraded"
    expect(typeof output.uptime_s).toBe("number");
    expect(typeof output.server_time).toBe("string");
  });

  it("successful tools/call writes an audit entry — AC-5 (17.c)", async () => {
    const { server, auditLog, auditPath, token } = newServer();
    await server.start();
    const addr = server.address();
    if (addr === null) throw new Error("expected bound address");

    const client = await newConnectedClient(addr, token);
    await client.callTool({ name: "ping", arguments: { message: "hi" } });
    await client.close();

    await server.stop();
    await auditLog.stop();

    const entries = await readAuditEntries(auditPath);
    const pingEntries = entries.filter((e) => e.tool === "ping");
    expect(pingEntries.length).toBeGreaterThanOrEqual(1);
    const entry = pingEntries[0];
    expect(entry?.allowed).toBe(true);
    expect(entry?.input_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(entry?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(entry?.result_bytes).toBeGreaterThan(0);
    expect(entry?.request_id).toMatch(/^req_[a-f0-9]{8}$/);
  });

  it("ping shape plumbs daemon_version and uptime_s correctly (17.d)", async () => {
    const { server, token } = newServer();
    await server.start();
    const addr = server.address();
    if (addr === null) throw new Error("expected bound address");

    const client = await newConnectedClient(addr, token);
    const result = await client.callTool({
      name: "ping",
      arguments: {},
    });
    let output: PingOutput;
    if (result.structuredContent !== undefined) {
      output = result.structuredContent as PingOutput;
    } else {
      const content = result.content as Array<{ type: string; text?: string }>;
      output = JSON.parse(content[0]?.text ?? "{}") as PingOutput;
    }
    expect(output.daemon_version).toBe("0.1.0");
    expect(output.uptime_s).toBeGreaterThanOrEqual(0);
    expect(output.echo).toBeNull();
  });
});

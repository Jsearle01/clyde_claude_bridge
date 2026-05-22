import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { request } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer, McpBindError } from "../../src/mcp/server.js";
import { AuditLog } from "../../src/audit/log.js";
import type { Logger } from "../../src/log/logger.js";
import type { AuditEntry } from "@claude-bridge/shared";

const INERT_TOKEN = "cb_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const INERT_WRONG_TOKEN = "cb_live_WRONGWRONGWRONGWRONGWRONGWRONGWR";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};

// Send a GET to the bound address with optional headers; resolve with status.
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

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-mcp-"));
  });

  afterEach(async () => {
    for (const s of servers) {
      await s.stop().catch(() => undefined);
    }
    for (const a of auditLogs) {
      await a.stop().catch(() => undefined);
    }
    servers = [];
    auditLogs = [];
    await rm(tempDir, { recursive: true, force: true });
  });

  function newServer(
    opts: { token?: string; bindHost?: string; bindPort?: number } = {},
  ): { server: McpServer; auditLog: AuditLog; auditPath: string; token: string } {
    const token = opts.token ?? INERT_TOKEN;
    const auditPath = join(tempDir, "audit.jsonl");
    const auditLog = new AuditLog(auditPath, 30);
    const server = new McpServer({
      bindHost: opts.bindHost ?? "127.0.0.1",
      bindPort: opts.bindPort ?? 0,
      logger: silentLogger,
      getExpectedToken: () => token,
      auditLog,
    });
    servers.push(server);
    auditLogs.push(auditLog);
    return { server, auditLog, auditPath, token };
  }

  it("starts and stops cleanly (15.a)", async () => {
    const { server } = newServer();
    await server.start();
    expect(server.address()).not.toBeNull();
    await server.stop();
    expect(server.address()).toBeNull();
  });

  it("HTTP endpoint responds with 401 when unauthenticated (15.b)", async () => {
    // After T-0010, the auth layer rejects unauthenticated GET / at 401
    // before the SDK transport sees it. This tightens T-0009's loose
    // "any positive status" assertion to a deterministic 401.
    const { server } = newServer();
    await server.start();
    const addr = server.address();
    if (addr === null) throw new Error("expected bound address");
    const statusCode = await getStatus(addr.host, addr.port);
    expect(statusCode).toBe(401);
  });

  it("rejects with McpBindError on bind collision (15.c)", async () => {
    const { server: sA, auditLog, token } = newServer();
    await sA.start();
    const addr = sA.address();
    if (addr === null) throw new Error("expected bound address");

    const sB = new McpServer({
      bindHost: "127.0.0.1",
      bindPort: addr.port,
      logger: silentLogger,
      getExpectedToken: () => token,
      auditLog, // shared; sB never starts so no write conflict
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
    const status = await getStatus(addr.host, addr.port);
    expect(status).toBe(401);
  });

  it("wrong token returns 401 + audit entry — AC-4 (15.h)", async () => {
    const { server, auditLog, auditPath } = newServer();
    await server.start();
    const addr = server.address();
    if (addr === null) throw new Error("expected bound address");

    const status = await getStatus(addr.host, addr.port, {
      Authorization: `Bearer ${INERT_WRONG_TOKEN}`,
    });
    expect(status).toBe(401);

    // Drain the audit-log write queue before reading the file.
    await server.stop();
    await auditLog.stop();

    const content = await readFile(auditPath, "utf8");
    const lines = content
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "{}") as AuditEntry;
    expect(entry.tool).toBe("<auth>");
    expect(entry.allowed).toBe(false);
    expect(entry.reason).toBe("invalid_token");
    expect(entry.input_hash).toBe("sha256:n/a");
    expect(entry.result_bytes).toBe(0);
    expect(entry.request_id).toMatch(/^req_[a-f0-9]{8}$/);
  });

  it("correct token is not rejected at the auth layer (15.i)", async () => {
    const { server, token } = newServer();
    await server.start();
    const addr = server.address();
    if (addr === null) throw new Error("expected bound address");

    const status = await getStatus(addr.host, addr.port, {
      Authorization: `Bearer ${token}`,
    });
    // Whatever the SDK returns for an unhandled GET / is fine; the point is
    // that it's NOT 401 (auth passed).
    expect(status).not.toBe(401);
  });

  it("correct token does not write an audit entry from T-0010 (15.j)", async () => {
    const { server, auditLog, auditPath, token } = newServer();
    await server.start();
    const addr = server.address();
    if (addr === null) throw new Error("expected bound address");

    await getStatus(addr.host, addr.port, {
      Authorization: `Bearer ${token}`,
    });

    await server.stop();
    await auditLog.stop();

    // T-0010 only audits rejections. T-0011 will add per-tool audit on
    // success. Either the audit file doesn't exist (lazy open) or it
    // exists but contains no "<auth>" entries.
    let content = "";
    try {
      content = await readFile(auditPath, "utf8");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
    expect(content).not.toContain('"tool":"<auth>"');
  });
});

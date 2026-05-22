import { describe, it, expect, afterEach } from "vitest";
import { request } from "node:http";
import { McpServer, McpBindError } from "../../src/mcp/server.js";
import type { Logger } from "../../src/log/logger.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};

function newServer(bindHost = "127.0.0.1", bindPort = 0): McpServer {
  return new McpServer({ bindHost, bindPort, logger: silentLogger });
}

// Send a GET to the bound address and resolve with the HTTP status code.
function getStatus(host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: host, port, method: "GET", path: "/" },
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
  let servers: McpServer[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await s.stop().catch(() => undefined);
    }
    servers = [];
  });

  it("starts and stops cleanly (15.a)", async () => {
    const s = newServer();
    servers.push(s);
    await s.start();
    expect(s.address()).not.toBeNull();
    await s.stop();
    expect(s.address()).toBeNull();
  });

  it("HTTP endpoint responds to a request (15.b)", async () => {
    const s = newServer();
    servers.push(s);
    await s.start();
    const addr = s.address();
    if (addr === null) throw new Error("expected bound address");
    const statusCode = await getStatus(addr.host, addr.port);
    expect(typeof statusCode).toBe("number");
    expect(statusCode).toBeGreaterThan(0);
  });

  it("rejects with McpBindError on bind collision (15.c)", async () => {
    const sA = newServer();
    servers.push(sA);
    await sA.start();
    const addr = sA.address();
    if (addr === null) throw new Error("expected bound address");

    const sB = new McpServer({
      bindHost: "127.0.0.1",
      bindPort: addr.port,
      logger: silentLogger,
    });
    servers.push(sB);
    await expect(sB.start()).rejects.toBeInstanceOf(McpBindError);
  });

  it("stop is idempotent (15.d)", async () => {
    const s = newServer();
    servers.push(s);
    await s.start();
    await s.stop();
    await expect(s.stop()).resolves.toBeUndefined();
  });

  it("stop on a never-started server is a no-op (15.e)", async () => {
    const s = newServer();
    servers.push(s);
    await expect(s.stop()).resolves.toBeUndefined();
  });

  it("start fails on invalid bindHost (15.f)", async () => {
    const s = newServer("999.999.999.999", 0);
    servers.push(s);
    await expect(s.start()).rejects.toBeInstanceOf(Error);
  });
});

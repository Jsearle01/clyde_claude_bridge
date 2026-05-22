import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shutdown, type DaemonComponents } from "../src/main.js";
import type { IpcServer } from "../src/ipc/server.js";
import type { McpServer } from "../src/mcp/server.js";
import type { TunnelManager } from "../src/tunnel/manager.js";
import type { AuditLog } from "../src/audit/log.js";
import type { Logger } from "../src/log/logger.js";

// Stub builders. We test shutdown via structural stubs (each component only
// needs a stop method); cast through `unknown` to satisfy the typed
// DaemonComponents surface.

interface Stub {
  stop: () => Promise<void>;
}

function makeStubOk(name: string, order: string[]): Stub {
  return {
    stop: vi.fn(() => {
      order.push(name);
      return Promise.resolve();
    }),
  };
}

function makeStubFail(name: string, order: string[]): Stub {
  return {
    stop: vi.fn(() => {
      order.push(name);
      return Promise.reject(new Error(`${name} stop failed`));
    }),
  };
}

function makeStubLogger(order: string[]): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    close: () => {
      order.push("logger");
      return Promise.resolve();
    },
  };
}

function noWherePath(): string {
  // Path inside tmpdir that doesn't exist. removePidFile tolerates ENOENT.
  return join(tmpdir(), `claude-bridge-shutdown-test-pid-${process.pid}`);
}

describe("shutdown", () => {
  it("stops layers in reverse-instantiation order: ipc → mcp → tunnel → audit → logger", async () => {
    const order: string[] = [];
    const components: DaemonComponents = {
      ipcServer: makeStubOk("ipc", order) as unknown as IpcServer,
      mcpServer: makeStubOk("mcp", order) as unknown as McpServer,
      tunnelManager: makeStubOk("tunnel", order) as unknown as TunnelManager,
      auditLog: makeStubOk("audit", order) as unknown as AuditLog,
      logger: makeStubLogger(order),
      pidPath: noWherePath(),
    };
    await shutdown("test", components);
    expect(order).toEqual(["ipc", "mcp", "tunnel", "audit", "logger"]);
  });

  it("continues to the next layer if a stop rejects", async () => {
    const order: string[] = [];
    const components: DaemonComponents = {
      ipcServer: makeStubOk("ipc", order) as unknown as IpcServer,
      mcpServer: makeStubFail("mcp", order) as unknown as McpServer,
      tunnelManager: makeStubOk("tunnel", order) as unknown as TunnelManager,
      auditLog: makeStubOk("audit", order) as unknown as AuditLog,
      logger: makeStubLogger(order),
      pidPath: noWherePath(),
    };
    await shutdown("test", components);
    expect(order).toEqual(["ipc", "mcp", "tunnel", "audit", "logger"]);
  });
});

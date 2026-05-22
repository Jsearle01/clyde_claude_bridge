import { describe, it, expect } from "vitest";
import { ConfigSchema, type Config } from "../src/index.js";

// Inert conforming token: matches `^cb_live_[A-Z2-7]{32}$` but is obviously a
// placeholder, never logged anywhere. Per CC-4 we don't put realistic-looking
// secrets in test fixtures.
const TOKEN = "cb_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const fullConfig = {
  version: 1,
  daemon: {
    bind_host: "127.0.0.1",
    bind_port: 7423,
    ipc_socket: "/home/user/.claude-bridge/daemon.sock",
  },
  auth: { token: TOKEN },
  tunnel: {
    provider: "cloudflared",
    binary: "cloudflared",
    args_extra: ["--region", "us"],
  },
  audit: {
    path: "/home/user/.claude-bridge/audit.jsonl",
    retention_days: 14,
  },
  log: {
    path: "/home/user/.claude-bridge/daemon.log",
    level: "debug",
  },
};

const minimalConfig = {
  version: 1,
  daemon: { ipc_socket: "/home/user/.claude-bridge/daemon.sock" },
  auth: { token: TOKEN },
  tunnel: {},
  audit: { path: "/home/user/.claude-bridge/audit.jsonl" },
  log: { path: "/home/user/.claude-bridge/daemon.log" },
};

describe("ConfigSchema", () => {
  it("parses a fully-populated config successfully (3.a)", () => {
    const result: Config = ConfigSchema.parse(fullConfig);
    expect(result.version).toBe(1);
    expect(result.daemon.bind_port).toBe(7423);
    expect(result.auth.token).toBe(TOKEN);
    expect(result.tunnel.args_extra).toEqual(["--region", "us"]);
    expect(result.audit.retention_days).toBe(14);
    expect(result.log.level).toBe("debug");
  });

  it("applies defaults when optional fields are omitted (3.b)", () => {
    const result: Config = ConfigSchema.parse(minimalConfig);
    expect(result.daemon.bind_host).toBe("127.0.0.1");
    expect(result.daemon.bind_port).toBe(7423);
    expect(result.tunnel.provider).toBe("cloudflared");
    expect(result.tunnel.binary).toBe("cloudflared");
    expect(result.tunnel.args_extra).toEqual([]);
    expect(result.audit.retention_days).toBe(30);
    expect(result.log.level).toBe("info");
  });

  it("rejects a config missing auth.token (3.c)", () => {
    const input = { ...fullConfig, auth: {} };
    expect(ConfigSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a config with a malformed auth.token (3.d)", () => {
    const input = { ...fullConfig, auth: { token: "wrong-format" } };
    expect(ConfigSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a config with an extra unknown top-level key — .strict() (3.e)", () => {
    const input = { ...fullConfig, extra_field: "anything" };
    expect(ConfigSchema.safeParse(input).success).toBe(false);
  });
});

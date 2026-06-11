import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initConfig,
  ConfigAlreadyExistsError,
} from "../../src/config/init.js";
import {
  loadConfig,
  ConfigNotFoundError,
  ConfigPermissionError,
  ConfigValidationError,
} from "../../src/config/load.js";

const INERT_TOKEN = "cb_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("Config init + load", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-config-"));
    configPath = join(tempDir, "config.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("initConfig produces a valid Config (13.a)", async () => {
    const config = await initConfig(configPath);
    expect(config.version).toBe(1);
    // T-BEARER-1: no `auth` block is minted — the static Bearer was removed.
    expect(config.auth).toBeUndefined();
    expect(config.daemon.bind_host).toBe("127.0.0.1");
    expect(config.daemon.bind_port).toBe(7423);
    expect(config.tunnel.provider).toBe("cloudflared");
    expect(config.tunnel.binary).toBe("cloudflared");
    expect(config.tunnel.args_extra).toEqual([]);
    expect(config.audit.retention_days).toBe(30);
    expect(config.log.level).toBe("info");
  });

  it("init then load round-trips (13.b)", async () => {
    const initialized = await initConfig(configPath);
    const loaded = await loadConfig(configPath);
    expect(loaded).toEqual(initialized);
  });

  it("initConfig refuses to overwrite an existing file", async () => {
    await initConfig(configPath);
    await expect(initConfig(configPath)).rejects.toBeInstanceOf(
      ConfigAlreadyExistsError,
    );
  });

  it("loadConfig throws ConfigNotFoundError for a missing file (13.c)", async () => {
    await expect(
      loadConfig(join(tempDir, "nonexistent.json")),
    ).rejects.toBeInstanceOf(ConfigNotFoundError);
  });

  it("loadConfig throws ConfigValidationError for malformed JSON (13.d)", async () => {
    await writeFile(configPath, "not valid json", { mode: 0o600 });
    await expect(loadConfig(configPath)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it("loadConfig throws ConfigValidationError for schema-invalid config (13.e)", async () => {
    const bad = { version: 1, daemon: {} };
    await writeFile(configPath, JSON.stringify(bad), { mode: 0o600 });
    await expect(loadConfig(configPath)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it.skipIf(process.platform === "win32")(
    "loadConfig throws ConfigPermissionError for loose Unix perms (13.f)",
    async () => {
      await initConfig(configPath);
      await chmod(configPath, 0o644);
      await expect(loadConfig(configPath)).rejects.toBeInstanceOf(
        ConfigPermissionError,
      );
    },
  );

  it("loadConfig expands '~' in path-bearing fields (13.g)", async () => {
    const raw = {
      version: 1,
      daemon: { ipc_socket: "~/test.sock" },
      auth: { token: INERT_TOKEN },
      tunnel: {},
      audit: { path: "/tmp/audit.jsonl" },
      log: { path: "/tmp/daemon.log" },
    };
    await writeFile(configPath, JSON.stringify(raw), { mode: 0o600 });
    const loaded = await loadConfig(configPath);
    expect(loaded.daemon.ipc_socket.startsWith("~/")).toBe(false);
    expect(loaded.daemon.ipc_socket.endsWith("test.sock")).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCliConfig } from "../../src/util/config.js";

const INERT_TOKEN = "cb_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("util/config", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-cli-config-test-"));
    configPath = join(tempDir, "config.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loadCliConfig parses a valid config", async () => {
    const config = {
      version: 1,
      daemon: {
        bind_host: "127.0.0.1",
        bind_port: 7423,
        ipc_socket: "/tmp/daemon.sock",
      },
      auth: { token: INERT_TOKEN },
      tunnel: { provider: "cloudflared", binary: "cloudflared", args_extra: [] },
      audit: { path: "/tmp/audit.jsonl", retention_days: 30 },
      log: { path: "/tmp/daemon.log", level: "info" },
    };
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const loaded = await loadCliConfig(configPath);
    expect(loaded.auth.token).toBe(INERT_TOKEN);
    expect(loaded.daemon.bind_port).toBe(7423);
  });

  it("loadCliConfig throws on missing file", async () => {
    await expect(loadCliConfig(join(tempDir, "nope.json"))).rejects.toThrow();
  });

  it("loadCliConfig throws on schema violation (malformed auth.token)", async () => {
    // T-BEARER-1: a MISSING auth.token is now valid (optional/inert). A PRESENT
    // token must still match the regex — that's the remaining violation.
    const bad = {
      version: 1,
      daemon: { ipc_socket: "/tmp/daemon.sock" },
      auth: { token: "not-a-valid-token" },
      tunnel: {},
      audit: { path: "/tmp/audit.jsonl" },
      log: { path: "/tmp/daemon.log" },
    };
    await writeFile(configPath, JSON.stringify(bad), { mode: 0o600 });
    await expect(loadCliConfig(configPath)).rejects.toThrow();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { StatusPayload } from "@claude-bridge/shared";
import {
  IpcServer,
  type IpcHandlers,
} from "../../../daemon/src/ipc/server.js";
import type { Logger } from "../../../daemon/src/log/logger.js";
import {
  statusCommand,
  formatStatusPayload,
  formatUptime,
  formatBytes,
  collapsePath,
} from "../../src/commands/status.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};

function uniquePipeName(): string {
  return `\\\\.\\pipe\\claude-bridge-status-test-${randomBytes(6).toString("hex")}`;
}

function makeStatusPayload(overrides: Partial<StatusPayload> = {}): StatusPayload {
  return {
    daemon_pid: 84231,
    daemon_uptime_s: 8054, // 2h14m14s
    endpoint: "127.0.0.1:7423",
    tunnel_status: "up",
    tunnel_url: "https://plum-otter-7821.trycloudflare.com",
    token_suffix: "d219",
    audit_path: "/home/user/.claude-bridge/audit.jsonl",
    audit_size_bytes: 14336,
    attached_workspaces: 0,
    ...overrides,
  };
}

describe("formatUptime", () => {
  it("renders seconds for short uptime", () => {
    expect(formatUptime(45)).toBe("45s");
  });
  it("renders minutes+seconds under an hour", () => {
    expect(formatUptime(272)).toBe("4m32s");
  });
  it("renders hours+minutes for long uptime", () => {
    expect(formatUptime(8054)).toBe("2h14m");
  });
});

describe("formatBytes", () => {
  it("bytes under 1KB", () => {
    expect(formatBytes(512)).toBe("512 B");
  });
  it("KB for KB-scale values", () => {
    expect(formatBytes(14336)).toBe("14 KB");
  });
  it("MB for MB-scale values", () => {
    expect(formatBytes(2 * 1024 * 1024 + 512 * 1024)).toBe("2.5 MB");
  });
});

describe("collapsePath", () => {
  it("collapses paths that start with home", () => {
    expect(collapsePath("/home/user/.claude-bridge/audit.jsonl", "/home/user"))
      .toBe("~/.claude-bridge/audit.jsonl");
  });
  it("leaves paths outside home unchanged", () => {
    expect(collapsePath("/var/log/audit.jsonl", "/home/user"))
      .toBe("/var/log/audit.jsonl");
  });
  it("returns '~' for exact home match", () => {
    expect(collapsePath("/home/user", "/home/user")).toBe("~");
  });
});

describe("formatStatusPayload", () => {
  it("matches the spec block for an up daemon", () => {
    const payload = makeStatusPayload();
    const out = formatStatusPayload(payload, 84231, "/home/user");
    expect(out).toContain("Daemon:    up (pid 84231, uptime 2h14m)");
    expect(out).toContain("Endpoint:  127.0.0.1:7423");
    expect(out).toContain("Tunnel:    up");
    expect(out).toContain("URL:       https://plum-otter-7821.trycloudflare.com");
    // CB-SMOKE-READINESS-BATCH: relabeled from "Token:" so a stale Bearer line
    // is never misread as an OAuth binding.
    expect(out).toContain(
      "Bearer:    cb_live_…d219 (daemon Bearer token — not an OAuth binding)",
    );
    expect(out).not.toContain("Token:     cb_live_");
    expect(out).toContain("Audit:     ~/.claude-bridge/audit.jsonl (current size: 14 KB)");
  });

  it("renders '(not assigned)' when tunnel_url is null", () => {
    const payload = makeStatusPayload({
      tunnel_status: "degraded",
      tunnel_url: null,
    });
    const out = formatStatusPayload(payload, 84231, "/home/user");
    expect(out).toContain("Tunnel:    degraded");
    expect(out).toContain("URL:       (not assigned)");
  });

  // CB-DAEMON-LIFECYCLE-FIX (b): connected-session visibility — the
  // diagnostic lens for the doubled-daemon split.
  it("lists connected extension sessions (identifier, pid, workspace)", () => {
    const payload = makeStatusPayload({
      attached_workspaces: 1,
      connected_extensions: [
        { identifier: "myproj-aaaaaa", pid: 5544, abs_path: "/home/user/myproj" },
      ],
    });
    const out = formatStatusPayload(payload, 84231, "/home/user");
    expect(out).toContain("Sessions:  1 connected");
    expect(out).toContain("- myproj-aaaaaa (pid 5544) ~/myproj");
  });

  it("renders '0 connected' when the list is empty", () => {
    const payload = makeStatusPayload({ connected_extensions: [] });
    expect(formatStatusPayload(payload, 84231, "/home/user")).toContain(
      "Sessions:  0 connected",
    );
  });

  it("renders '(not reported)' when a pre-fix daemon omits the field", () => {
    const payload = makeStatusPayload(); // no connected_extensions
    expect(formatStatusPayload(payload, 84231, "/home/user")).toContain(
      "Sessions:  (not reported by this daemon)",
    );
  });

  // CB-SMOKE-READINESS-BATCH: OAuth bindings are surfaced so a real bind is
  // visible (the smoke's candidate 3 — a bind was invisible in status).
  it("lists active OAuth bindings (client → workspace, issued/expires)", () => {
    const payload = makeStatusPayload({
      oauth_bindings: [
        {
          client_id: "cb_client_0123456789abcdef",
          bound_workspace: "myproj-aaaaaa",
          issued_at: "2026-06-06T12:00:00.000Z",
          expires_at: Date.parse("2026-07-06T12:00:00.000Z"),
        },
      ],
    });
    const out = formatStatusPayload(payload, 84231, "/home/user");
    expect(out).toContain("Bindings:  1 active");
    expect(out).toContain("cb_client_01234567…"); // truncated client id (18-char prefix)
    expect(out).toContain("→ myproj-aaaaaa");
    expect(out).toContain("issued 2026-06-06T12:00:00.000Z");
    expect(out).toContain("expires 2026-07-06T12:00:00.000Z");
  });

  it("renders 'none' when the binding store is empty (status never implies a phantom bind)", () => {
    const payload = makeStatusPayload({ oauth_bindings: [] });
    expect(formatStatusPayload(payload, 84231, "/home/user")).toContain(
      "Bindings:  none (no active OAuth bindings)",
    );
  });

  it("renders '(not reported)' for bindings when a pre-fix daemon omits the field", () => {
    const payload = makeStatusPayload(); // no oauth_bindings
    expect(formatStatusPayload(payload, 84231, "/home/user")).toContain(
      "Bindings:  (not reported by this daemon)",
    );
  });
});

function makeHandlers(overrides: Partial<IpcHandlers> = {}): IpcHandlers {
  return {
    status: () => Promise.resolve(makeStatusPayload()),
    stop: () => Promise.reject(new Error("not used")),
    tokenRotate: () => Promise.reject(new Error("not used")),
    tunnelRestart: () => Promise.reject(new Error("not used")),
    ...overrides,
  };
}

describe("statusCommand", () => {
  let tempDir: string;
  let pidPath: string;
  let socketPath: string;
  let address: string;
  let server: IpcServer | null = null;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-status-test-"));
    pidPath = join(tempDir, "daemon.pid");
    socketPath = join(tempDir, "daemon.sock");
    address = process.platform === "win32" ? uniquePipeName() : socketPath;
    server = null;
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    if (server !== null) await server.stop().catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true });
  });

  async function startServer(handlers: IpcHandlers): Promise<void> {
    const override = process.platform === "win32" ? address : undefined;
    server = new IpcServer(socketPath, handlers, silentLogger, override);
    await server.start();
  }

  it("PID absent → 'Daemon: down' single line", async () => {
    await statusCommand({ pidPath });
    expect(stdoutSpy).toHaveBeenCalledWith("Daemon:    down\n");
  });

  it("PID stale → 'Daemon: down' single line", async () => {
    await writeFile(pidPath, "99999", { mode: 0o600 });
    await statusCommand({ pidPath });
    expect(stdoutSpy).toHaveBeenCalledWith("Daemon:    down\n");
  });

  it("PID alive + status_ok → formatted block printed", async () => {
    await startServer(makeHandlers());
    await writeFile(pidPath, String(process.pid), { mode: 0o600 });
    await statusCommand({
      pidPath,
      addressOverride: address,
      homeDir: "/home/user",
    });
    expect(stdoutSpy).toHaveBeenCalledOnce();
    const out = stdoutSpy.mock.calls[0]?.[0] as string;
    expect(out).toContain("Daemon:    up");
    expect(out).toContain("Endpoint:  127.0.0.1:7423");
    expect(out).toContain("Bearer:    cb_live_…d219");
  });
});

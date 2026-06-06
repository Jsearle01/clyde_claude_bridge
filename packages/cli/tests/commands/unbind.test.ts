// CB-SMOKE-READINESS-BATCH: tests for `claude-bridge unbind`. Covers the
// footgun guard (no-args ERRORS, never clears all), the single-target and
// --all forms over a real IpcServer, and the daemon-down / no-match paths.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  IpcServer,
  type IpcHandlers,
} from "../../../daemon/src/ipc/server.js";
import type { Logger } from "../../../daemon/src/log/logger.js";
import { DaemonNotRunningError } from "../../src/commands/token.js";
import {
  unbindCommand,
  formatUnbindOutput,
  UnbindTargetRequiredError,
  UnbindTargetAndAllError,
  type UnbindResultEntry,
} from "../../src/commands/unbind.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};

function uniquePipeName(): string {
  return `\\\\.\\pipe\\claude-bridge-unbind-test-${randomBytes(6).toString("hex")}`;
}

function makeHandlers(overrides: Partial<IpcHandlers> = {}): IpcHandlers {
  return {
    status: () => Promise.reject(new Error("not used")),
    stop: () => Promise.reject(new Error("not used")),
    tokenRotate: () => Promise.reject(new Error("not used")),
    tunnelRestart: () => Promise.reject(new Error("not used")),
    ...overrides,
  };
}

describe("formatUnbindOutput", () => {
  const entry: UnbindResultEntry = {
    client_id: "cb_client_abc",
    bound_workspace: "myproj-aaaaaa",
    tokens_revoked: 1,
  };

  it("lists each unbound binding", () => {
    const out = formatUnbindOutput([entry], "myproj-aaaaaa", false);
    expect(out).toContain("Unbound:");
    expect(out).toContain("cb_client_abc → myproj-aaaaaa (1 token revoked)");
  });

  it("a target that matched nothing prints a clear no-match line", () => {
    const out = formatUnbindOutput([], "nope", false);
    expect(out).toContain("No binding matched 'nope'");
  });

  it("--all with no bindings says so", () => {
    expect(formatUnbindOutput([], null, true)).toContain(
      "No active bindings to clear.",
    );
  });

  it("--all header reads 'all'", () => {
    expect(formatUnbindOutput([entry], null, true)).toContain(
      "Unbound all bindings:",
    );
  });
});

describe("unbindCommand — footgun guard (no IPC)", () => {
  it("no args (no target, no --all) ERRORS — never a silent clear-all", async () => {
    await expect(unbindCommand({})).rejects.toBeInstanceOf(
      UnbindTargetRequiredError,
    );
  });

  it("empty-string target ERRORS too", async () => {
    await expect(unbindCommand({ target: "" })).rejects.toBeInstanceOf(
      UnbindTargetRequiredError,
    );
  });

  it("both a target AND --all ERRORS (ambiguous)", async () => {
    await expect(
      unbindCommand({ target: "x", all: true }),
    ).rejects.toBeInstanceOf(UnbindTargetAndAllError);
  });
});

describe("unbindCommand — over IPC", () => {
  let tempDir: string;
  let pidPath: string;
  let socketPath: string;
  let address: string;
  let server: IpcServer | null = null;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-unbind-test-"));
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

  it("PID absent → DaemonNotRunningError, no IPC", async () => {
    await expect(
      unbindCommand({ target: "x", pidPath }),
    ).rejects.toBeInstanceOf(DaemonNotRunningError);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("unbind <target> forwards {target, all:false} and prints the result", async () => {
    const seen: Array<{ target: string | null; all: boolean }> = [];
    await startServer(
      makeHandlers({
        unbindBinding: (args) => {
          seen.push(args);
          return Promise.resolve({
            unbound: [
              {
                client_id: "cb_client_abc",
                bound_workspace: "myproj-aaaaaa",
                tokens_revoked: 1,
              },
            ],
          });
        },
      }),
    );
    await writeFile(pidPath, String(process.pid), { mode: 0o600 });
    await unbindCommand({
      target: "myproj-aaaaaa",
      pidPath,
      addressOverride: address,
    });
    expect(seen).toEqual([{ target: "myproj-aaaaaa", all: false }]);
    const out = stdoutSpy.mock.calls[0]?.[0] as string;
    expect(out).toContain("cb_client_abc → myproj-aaaaaa");
  });

  it("unbind --all forwards {target:null, all:true}", async () => {
    const seen: Array<{ target: string | null; all: boolean }> = [];
    await startServer(
      makeHandlers({
        unbindBinding: (args) => {
          seen.push(args);
          return Promise.resolve({ unbound: [] });
        },
      }),
    );
    await writeFile(pidPath, String(process.pid), { mode: 0o600 });
    await unbindCommand({ all: true, pidPath, addressOverride: address });
    expect(seen).toEqual([{ target: null, all: true }]);
    const out = stdoutSpy.mock.calls[0]?.[0] as string;
    expect(out).toContain("No active bindings to clear.");
  });

  it("a target that matched nothing prints the no-match line", async () => {
    await startServer(
      makeHandlers({
        unbindBinding: () => Promise.resolve({ unbound: [] }),
      }),
    );
    await writeFile(pidPath, String(process.pid), { mode: 0o600 });
    await unbindCommand({ target: "ghost", pidPath, addressOverride: address });
    const out = stdoutSpy.mock.calls[0]?.[0] as string;
    expect(out).toContain("No binding matched 'ghost'");
  });
});

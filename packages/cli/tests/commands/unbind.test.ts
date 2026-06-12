// CB-SMOKE-READINESS-BATCH: tests for `claude-bridge unbind`. Covers the
// footgun guard (no-args ERRORS, never clears all), the single-target and
// --all forms over a real IpcServer, and the daemon-down / no-match paths.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  IpcServer,
  type IpcHandlers,
} from "../../../daemon/src/ipc/server.js";
import type { Logger } from "../../../daemon/src/log/logger.js";
import type { OAuthBindingSummary, StatusPayload } from "@claude-bridge/shared";
import { DaemonNotRunningError } from "../../src/util/selector.js";
import type { ConfigDirEntry } from "../../src/util/config-dirs.js";
import {
  unbindCommand,
  formatUnbindOutput,
  formatBindingList,
  UnbindTargetAndAllError,
  AmbiguousBindingDaemonError,
  type UnbindResultEntry,
} from "../../src/commands/unbind.js";

function makeStatusPayload(overrides: Partial<StatusPayload> = {}): StatusPayload {
  return {
    daemon_pid: 84231,
    daemon_uptime_s: 8054,
    endpoint: "127.0.0.1:7423",
    tunnel_status: "up",
    tunnel_url: "https://plum-otter-7821.trycloudflare.com",
    audit_path: "/home/user/.claude-bridge/audit.jsonl",
    audit_size_bytes: 14336,
    attached_workspaces: 0,
    ...overrides,
  };
}

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
  it("both a target AND --all ERRORS (ambiguous) — before any IPC", async () => {
    await expect(
      unbindCommand({ target: "x", all: true }),
    ).rejects.toBeInstanceOf(UnbindTargetAndAllError);
  });
});

describe("formatBindingList (T-CLI-4b binding-list)", () => {
  const binding = {
    client_id: "cb_client_abcdef123456",
    bound_workspace: "c:\\Projects\\foo",
    issued_at: "2026-06-01T00:00:00.000Z",
    expires_at: 1780000000000,
  };

  it("AC-4b-1: renders client + workspace + issued date (the typeable target ids)", () => {
    const out = formatBindingList([binding]);
    expect(out).toContain("c:\\Projects\\foo"); // workspace (a typeable target)
    expect(out).toContain("cb_client_abcdef123456"); // client id (a typeable target)
    expect(out).toContain("2026-06-01"); // issued date
  });

  it("AC-4b-2: empty → 'No active bindings.' (not blank, not error)", () => {
    expect(formatBindingList([])).toContain("No active bindings.");
  });

  it("unbind revokes by typed target, never a numbered pick", () => {
    // mirrors delete-dir: a mis-picked number revokes the wrong binding.
    const out = formatBindingList([binding]);
    expect(out).toContain("type a workspace or client id"); // the typed-target instruction
    expect(out).not.toMatch(/\[\s*\d+\s*\]/); // NO numbered pick
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

  it("AC-4b-1/4b-4/4b-5: bare unbind LISTS the daemon's bindings (via status IPC), never revokes", async () => {
    const revokeCalls: unknown[] = [];
    await startServer(
      makeHandlers({
        status: () =>
          Promise.resolve(
            makeStatusPayload({
              oauth_bindings: [
                {
                  client_id: "cb_client_xyz789",
                  bound_workspace: "c:\\Projects\\bar",
                  issued_at: "2026-06-02T00:00:00.000Z",
                  expires_at: 1780000000000,
                },
              ],
            }),
          ),
        unbindBinding: (a) => {
          revokeCalls.push(a);
          return Promise.resolve({ unbound: [] });
        },
      }),
    );
    await writeFile(pidPath, String(process.pid), { mode: 0o600 });
    await unbindCommand({ pidPath, addressOverride: address });
    const out = stdoutSpy.mock.calls.map((c) => c[0] as string).join("");
    expect(out).toContain("cb_client_xyz789"); // listed (client id to type)
    expect(out).toContain("c:\\Projects\\bar"); // workspace to type
    expect(revokeCalls).toEqual([]); // bare LISTS, never clears — footgun preserved
  });

  it("AC-4b-2: bare unbind with no bindings shows the empty state (not blank/error)", async () => {
    await startServer(
      makeHandlers({
        status: () =>
          Promise.resolve(makeStatusPayload({ oauth_bindings: [] })),
      }),
    );
    await writeFile(pidPath, String(process.pid), { mode: 0o600 });
    await unbindCommand({ pidPath, addressOverride: address });
    const out = stdoutSpy.mock.calls.map((c) => c[0] as string).join("");
    expect(out).toContain("No active bindings");
  });
});

describe("unbindCommand — T-CLI-5 binding-presence-driven fan-out", () => {
  let root: string;
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cb-unbind-fanout-"));
    spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(async () => {
    spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  });
  async function makeDir(hash: string, name: string): Promise<void> {
    const d = join(root, hash);
    await mkdir(d, { recursive: true });
    await writeFile(
      join(d, "workspaces.json"),
      JSON.stringify({
        version: "1",
        entries: [{ abs_path: `c:\\ws\\${name}`, name }],
      }),
    );
  }
  function captured(): string {
    return spy.mock.calls.map((c) => c[0] as string).join("");
  }
  const live = (): Promise<boolean> => Promise.resolve(true);
  function binding(client: string, ws: string): OAuthBindingSummary {
    return {
      client_id: client,
      bound_workspace: ws,
      issued_at: "2026-06-01T00:00:00.000Z",
      expires_at: 1780000000000,
    };
  }

  it("AC-C5-1: 0 bindings on any daemon → 'No active bindings on any daemon', NO menu", async () => {
    await makeDir("a".repeat(16), "alpha");
    await makeDir("b".repeat(16), "beta");
    await unbindCommand({
      configRoot: root,
      probe: live,
      fetchBindingsFor: () => Promise.resolve([]),
    });
    const out = captured();
    expect(out).toContain("No active bindings on any daemon");
    expect(out).not.toMatch(/\[\s*\d+\s*\]/); // no daemon menu
  });

  it("AC-C5-2: bindings on exactly ONE daemon (of several) → skip the pick, list it", async () => {
    await makeDir("a".repeat(16), "alpha");
    await makeDir("b".repeat(16), "beta");
    await unbindCommand({
      configRoot: root,
      probe: live,
      fetchBindingsFor: (e: ConfigDirEntry) =>
        Promise.resolve(
          e.name === "alpha" ? [binding("cb_client_x", "c:\\ws\\alpha")] : [],
        ),
    });
    const out = captured();
    expect(out).toContain("cb_client_x"); // alpha's binding listed directly
    expect(out).toContain("type a workspace or client id"); // the revoke instruction
    expect(out).not.toMatch(/\[\s*\d+\s*\]/); // the daemon-pick was SKIPPED
  });

  it("AC-C5-3: bindings on SEVERAL daemons → pick among ONLY those (binding-less daemon excluded)", async () => {
    await makeDir("a".repeat(16), "alpha");
    await makeDir("b".repeat(16), "beta");
    await makeDir("c".repeat(16), "gamma"); // live but NO bindings
    let menu: { name: string | null; count: number }[] = [];
    await unbindCommand({
      configRoot: root,
      probe: live,
      fetchBindingsFor: (e: ConfigDirEntry) =>
        Promise.resolve(
          e.name === "alpha"
            ? [binding("cb_a", "c:\\ws\\alpha")]
            : e.name === "beta"
              ? [binding("cb_b1", "c:\\ws\\beta"), binding("cb_b2", "c:\\ws\\beta")]
              : [],
        ),
      interactive: true,
      pickNumber: (bearing) => {
        menu = bearing.map((d) => ({ name: d.entry.name, count: d.bindings.length }));
        return Promise.resolve(2); // pick beta (sorted alpha[1], beta[2])
      },
    });
    // the menu had ONLY the binding-bearing daemons (alpha, beta) — NOT gamma:
    expect(menu.map((m) => m.name)).toEqual(["alpha", "beta"]);
    expect(menu).toContainEqual({ name: "beta", count: 2 }); // count surfaced
    expect(captured()).toContain("cb_b1"); // beta's bindings listed after the pick
  });

  it("AC-C5-5: SEVERAL binding-bearing daemons + non-interactive → AmbiguousBindingDaemonError (error-and-list, no hang)", async () => {
    await makeDir("a".repeat(16), "alpha");
    await makeDir("b".repeat(16), "beta");
    await makeDir("c".repeat(16), "gamma"); // no bindings
    const fetchFor = (e: ConfigDirEntry) =>
      Promise.resolve(
        e.name === "gamma" ? [] : [binding("cb_x", `c:\\ws\\${e.name ?? "x"}`)],
      );
    let thrown: unknown;
    try {
      await unbindCommand({
        configRoot: root,
        probe: live,
        fetchBindingsFor: fetchFor,
        interactive: false,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AmbiguousBindingDaemonError);
    // the error message RENDERS only the binding-bearing daemons + counts, not gamma:
    const msg = (thrown as Error).message;
    expect(msg).toContain("alpha");
    expect(msg).toContain("beta");
    expect(msg).not.toContain("gamma");
    expect(msg).toMatch(/1 binding/);
  });
});

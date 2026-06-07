import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import {
  deriveResourceHash,
  daemonPipeName,
  daemonIpcAddress,
  computeDaemonResources,
  bindWithRetry,
  isIpcAddressLive,
  NoFreePortError,
} from "../../src/workspace/resources.js";

// Known SHA-256[:16] fixtures (verified out-of-band against node:crypto), so a
// derivation change is caught AND the CLI's duplicated derivation can assert
// the same constants (cli/tests/util/paths.test.ts) — the cross-package
// invariant that the CLI connects to the right daemon.
const ID_A = "c:\\projects\\clyde_claude_bridge";
const HASH_A = "135cfaa3d11a768c";
const ID_B = "c:\\projects\\other_workspace";
const HASH_B = "31e623eb2c4d4c9b";

describe("deriveResourceHash (P3'-1b)", () => {
  it("is deterministic and matches the known fixtures", () => {
    expect(deriveResourceHash(ID_A)).toBe(HASH_A);
    expect(deriveResourceHash(ID_A)).toBe(deriveResourceHash(ID_A)); // stable
    expect(deriveResourceHash(ID_B)).toBe(HASH_B);
  });
  it("is 16 lowercase hex chars (filesystem-safe)", () => {
    expect(deriveResourceHash(ID_A)).toMatch(/^[0-9a-f]{16}$/);
  });
  it("distinct identities → distinct hashes (collision resistance)", () => {
    expect(deriveResourceHash(ID_A)).not.toBe(deriveResourceHash(ID_B));
  });
});

describe("pipe / ipc address derivation (P3'-1b)", () => {
  it("daemonPipeName embeds the hash", () => {
    expect(daemonPipeName(HASH_A)).toBe(`\\\\.\\pipe\\claude-bridge-${HASH_A}`);
  });
  it("win32 → pipe; posix → sock path", () => {
    const sock = "/x/.claude-bridge/abc/daemon.sock";
    expect(daemonIpcAddress(HASH_A, sock, "win32")).toBe(daemonPipeName(HASH_A));
    expect(daemonIpcAddress(HASH_A, sock, "linux")).toBe(sock);
  });
});

describe("computeDaemonResources (P3'-1b)", () => {
  const ROOT = join("C:", "Users", "jay", "AppData", "Roaming", "claude-bridge");

  it("AC-1b-1/4: per-daemon config-dir + pipe under <root>/<hash>/", () => {
    const r = computeDaemonResources(
      "C:\\Projects\\clyde_claude_bridge",
      "clyde",
      ROOT,
      "win32",
    );
    expect(r.identity).toBe(ID_A);
    expect(r.hash).toBe(HASH_A);
    expect(r.configDir).toBe(join(ROOT, HASH_A));
    expect(r.ipcSocketPath).toBe(join(ROOT, HASH_A, "daemon.sock"));
    expect(r.ipcAddress).toBe(daemonPipeName(HASH_A)); // win32 pipe
    expect(r.name).toBe("clyde");
  });

  // AC-1b-5 (THE RISK AC, derivation half): two DIFFERENT workspaces resolve to
  // distinct config-dir + pipe — no shared paths. (The running-process half is
  // verified live in the report.)
  it("AC-1b-5: two different workspaces → distinct dir + pipe", () => {
    const a = computeDaemonResources("C:\\Projects\\clyde_claude_bridge", "a", ROOT, "win32");
    const b = computeDaemonResources("C:\\Projects\\other_workspace", "b", ROOT, "win32");
    expect(a.configDir).not.toBe(b.configDir);
    expect(a.ipcAddress).not.toBe(b.ipcAddress);
    expect(a.hash).toBe(HASH_A);
    expect(b.hash).toBe(HASH_B);
  });

  // AC-1b-6: the SAME workspace (any equivalent --workspace form) → the SAME
  // config-dir → tokens.json persists across restart. Determinism payoff.
  it("AC-1b-6: same workspace (variant forms) → identical config-dir", () => {
    const forms = [
      "C:\\Projects\\clyde_claude_bridge",
      "c:/projects/clyde_claude_bridge/",
      "C:\\PROJECTS\\CLYDE_CLAUDE_BRIDGE",
    ];
    const dirs = forms.map(
      (f) => computeDaemonResources(f, "x", ROOT, "win32").configDir,
    );
    expect(new Set(dirs).size).toBe(1);
    expect(dirs[0]).toBe(join(ROOT, HASH_A));
  });
});

// P3'-1c ITEM 2 — the DETERMINISTIC proof of the bind-with-retry mechanism
// (the §5 requirement: the race is timing-dependent, so a mocked tryBind is the
// reliable proof; the live concurrent test only corroborates).
function eaddrinuse(): Error {
  return Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
}

describe("bindWithRetry (P3'-1c, ITEM 2)", () => {
  it("AC-1c-4: advances past EADDRINUSE and binds the next free port", async () => {
    const attempted: number[] = [];
    // 7423, 7424 taken; 7425 binds.
    const tryBind = (port: number): Promise<void> => {
      attempted.push(port);
      if (port < 7425) return Promise.reject(eaddrinuse());
      return Promise.resolve();
    };
    expect(await bindWithRetry(tryBind, { startPort: 7423 })).toBe(7425);
    expect(attempted).toEqual([7423, 7424, 7425]); // it actually retried
  });

  it("binds the start port immediately when free", async () => {
    expect(await bindWithRetry(() => Promise.resolve(), { startPort: 7423 })).toBe(
      7423,
    );
  });

  it("AC-1c-6: bounded — all ports in range EADDRINUSE → NoFreePortError", async () => {
    await expect(
      bindWithRetry(() => Promise.reject(eaddrinuse()), {
        startPort: 7423,
        maxScan: 5,
      }),
    ).rejects.toBeInstanceOf(NoFreePortError);
  });

  it("non-EADDRINUSE errors propagate (no retry)", async () => {
    const attempted: number[] = [];
    const tryBind = (port: number): Promise<void> => {
      attempted.push(port);
      return Promise.reject(new Error("EACCES: permission denied"));
    };
    await expect(
      bindWithRetry(tryBind, { startPort: 7423 }),
    ).rejects.toThrow(/EACCES/);
    expect(attempted).toEqual([7423]); // did NOT retry a non-EADDRINUSE failure
  });
});

describe("isIpcAddressLive (P3'-1c, ITEM 1 lock probe)", () => {
  // Liveness probe: connect succeeds → live; ECONNREFUSED/ENOENT → not live.
  // Uses a real ephemeral pipe/socket server (deterministic, no mocking).
  const PIPE =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cb-test-${process.pid}`
      : join(process.env.TMPDIR ?? "/tmp", `cb-test-${process.pid}.sock`);

  it("returns true when a server is listening (live incumbent)", async () => {
    const server: Server = createServer();
    await new Promise<void>((r) => server.listen(PIPE, r));
    try {
      expect(await isIpcAddressLive(PIPE)).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("returns false when nothing is listening (stale/absent → reclaim)", async () => {
    const absent =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cb-test-absent-${process.pid}`
        : join(process.env.TMPDIR ?? "/tmp", `cb-test-absent-${process.pid}.sock`);
    expect(await isIpcAddressLive(absent, 500)).toBe(false);
  });
});

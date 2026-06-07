import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  deriveResourceHash,
  daemonPipeName,
  daemonIpcAddress,
  computeDaemonResources,
  allocatePort,
  ExplicitPortInUseError,
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

describe("allocatePort (P3'-1b)", () => {
  const HOST = "127.0.0.1";
  const never = (): Promise<boolean> => Promise.resolve(false); // nothing listening
  const always = (): Promise<boolean> => Promise.resolve(true); // all taken

  it("AC-1b-3: explicit --port free → uses it", async () => {
    expect(
      await allocatePort({ explicit: 9000, start: 9000, host: HOST }, never),
    ).toBe(9000);
  });

  it("AC-1b-3: explicit --port taken → ExplicitPortInUseError (no increment)", async () => {
    await expect(
      allocatePort({ explicit: 7423, start: 7423, host: HOST }, always),
    ).rejects.toBeInstanceOf(ExplicitPortInUseError);
  });

  it("auto: returns the configured start port when free", async () => {
    expect(
      await allocatePort({ explicit: undefined, start: 7423, host: HOST }, never),
    ).toBe(7423);
  });

  it("auto: increments to the next free port when lower ones are taken", async () => {
    // 7423, 7424 taken; 7425 free.
    const taken = new Set([7423, 7424]);
    const isListening = (_h: string, p: number): Promise<boolean> =>
      Promise.resolve(taken.has(p));
    expect(
      await allocatePort({ explicit: undefined, start: 7423, host: HOST }, isListening),
    ).toBe(7425);
  });

  it("auto: all scanned ports taken → NoFreePortError", async () => {
    await expect(
      allocatePort({ explicit: undefined, start: 7423, host: HOST }, always),
    ).rejects.toBeInstanceOf(NoFreePortError);
  });
});

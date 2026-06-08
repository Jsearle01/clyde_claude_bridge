import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import {
  getCliConfigDir,
  getCliConfigPath,
  getCliPidPath,
  addressFor,
  deriveResourceHash,
  perDaemonResources,
  resolveCliTarget,
} from "../../src/util/paths.js";

describe("util/paths", () => {
  let originalHome: string | undefined;
  let originalAppData: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalAppData = process.env.APPDATA;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
  });

  it.skipIf(process.platform === "win32")(
    "Unix: getCliConfigDir uses HOME + .claude-bridge",
    () => {
      process.env.HOME = "/tmp/fake-home";
      expect(getCliConfigDir()).toBe("/tmp/fake-home/.claude-bridge");
    },
  );

  it.skipIf(process.platform !== "win32")(
    "Windows: getCliConfigDir uses APPDATA + claude-bridge",
    () => {
      process.env.APPDATA = "C:\\fake-appdata";
      expect(getCliConfigDir()).toBe(join("C:\\fake-appdata", "claude-bridge"));
    },
  );

  it("getCliConfigPath appends config.json", () => {
    if (process.platform === "win32") {
      process.env.APPDATA = "C:\\fake-appdata";
    } else {
      process.env.HOME = "/tmp/fake-home";
    }
    expect(getCliConfigPath().endsWith("config.json")).toBe(true);
    expect(getCliConfigPath()).toBe(join(getCliConfigDir(), "config.json"));
  });

  it("getCliPidPath appends daemon.pid", () => {
    if (process.platform === "win32") {
      process.env.APPDATA = "C:\\fake-appdata";
    } else {
      process.env.HOME = "/tmp/fake-home";
    }
    expect(getCliPidPath()).toBe(join(getCliConfigDir(), "daemon.pid"));
  });

  it.skipIf(process.platform === "win32")(
    "Unix: addressFor returns the socket path unchanged",
    () => {
      expect(addressFor("/tmp/daemon.sock")).toBe("/tmp/daemon.sock");
    },
  );

  it.skipIf(process.platform !== "win32")(
    "Windows: addressFor returns the hardcoded pipe path",
    () => {
      expect(addressFor("anything")).toBe("\\\\.\\pipe\\claude-bridge");
    },
  );
});

describe("perDaemonResources / deriveResourceHash (P3'-1b)", () => {
  // CROSS-PACKAGE INVARIANT: these hashes MUST equal the daemon's
  // (packages/daemon/tests/workspace/resources.test.ts uses the same
  // constants). If they diverge, the CLI connects to the wrong daemon.
  const ID_A = "c:\\projects\\clyde_claude_bridge";
  const HASH_A = "135cfaa3d11a768c";
  const HASH_B = "31e623eb2c4d4c9b";

  it("deriveResourceHash matches the daemon's fixtures", () => {
    expect(deriveResourceHash(ID_A)).toBe(HASH_A);
    expect(deriveResourceHash("c:\\projects\\other_workspace")).toBe(HASH_B);
  });

  it("win32: per-daemon dir + pipe under <root>/<hash>/ (platform injected)", () => {
    const r = perDaemonResources("C:\\Projects\\clyde_claude_bridge", "win32");
    expect(r.hash).toBe(HASH_A);
    expect(r.configDir).toBe(join(getCliConfigDir(), HASH_A));
    expect(r.configPath).toBe(join(getCliConfigDir(), HASH_A, "config.json"));
    expect(r.pidPath).toBe(join(getCliConfigDir(), HASH_A, "daemon.pid"));
    expect(r.ipcAddress).toBe(`\\\\.\\pipe\\claude-bridge-${HASH_A}`);
  });

  it("equivalent --workspace forms → identical resources (same daemon)", () => {
    const a = perDaemonResources("C:\\Projects\\clyde_claude_bridge", "win32");
    const b = perDaemonResources("c:/projects/clyde_claude_bridge/", "win32");
    expect(a).toEqual(b);
  });

  it("posix: ipc address is the per-daemon sock path", () => {
    const r = perDaemonResources("/home/jay/Projects/x", "linux");
    expect(r.ipcAddress).toBe(join(r.configDir, "daemon.sock"));
  });
});

describe("resolveCliTarget (P3'-3-fix, finding B) — stop/status per-daemon targeting", () => {
  it("WITH --workspace → the per-daemon pid + ipc address (host platform)", () => {
    const ws = "C:\\Projects\\clyde_claude_bridge";
    const res = perDaemonResources(ws); // host platform
    const target = resolveCliTarget(ws);
    expect(target.pidPath).toBe(res.pidPath); // per-daemon <hash>/daemon.pid
    expect(target.addressOverride).toBe(res.ipcAddress); // per-daemon pipe/sock
    // crucially NOT the flat legacy pid path
    expect(target.pidPath).not.toBe(getCliPidPath());
  });

  it("WITHOUT --workspace → legacy flat pid + undefined address (back-compat)", () => {
    for (const ws of [undefined, ""]) {
      const target = resolveCliTarget(ws);
      expect(target.pidPath).toBe(getCliPidPath());
      expect(target.addressOverride).toBeUndefined();
    }
  });
});

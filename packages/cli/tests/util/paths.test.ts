import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import {
  getCliConfigDir,
  getCliConfigPath,
  getCliPidPath,
  addressFor,
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

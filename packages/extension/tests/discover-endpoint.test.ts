// CB-LINUX-LAUNCH-TESTS: platform-mocked coverage for discoverDaemonEndpoint's
// connect decision. This is the highest-value gap the CB-LAUNCH-PATH-RECON
// surfaced — the POSIX arm (Linux-native) had ZERO test coverage. These tests
// lock in the DECISION logic (win32 -> named pipe; linux/darwin -> the
// configured unix socket, else the daemon.sock fallback) by injecting the
// platform rather than mutating the global process.platform.
//
// CEILING (honest): this is correct-by-construction + mocked-platform-covered.
// It does NOT live-confirm a real unix-socket connect on Linux — that needs a
// real Linux runtime (cross-platform CI, P4). Do not read these as live proof.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

// Module-level mock so the config read is controllable per-test. Scoped to
// this file (kept out of ipc-client.test.ts, which uses real fs-free paths).
vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));
import { readFileSync } from "node:fs";
import { discoverDaemonEndpoint } from "../src/ipc/client.js";

const mockReadFileSync = vi.mocked(readFileSync);
const WINDOWS_PIPE = "\\\\.\\pipe\\claude-bridge";
const FALLBACK_SOCK = join(homedir(), ".claude-bridge", "daemon.sock");

describe("discoverDaemonEndpoint — platform connect decision (CB-LINUX-LAUNCH-TESTS)", () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
  });

  it("win32 -> Windows named pipe, without reading any config file", () => {
    expect(discoverDaemonEndpoint("win32")).toBe(WINDOWS_PIPE);
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("linux + config.json with a non-empty ipc_socket -> that unix socket (NOT the pipe)", () => {
    const configured = "/run/user/1000/claude-bridge.sock";
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ daemon: { ipc_socket: configured } }),
    );
    const endpoint = discoverDaemonEndpoint("linux");
    expect(endpoint).toBe(configured);
    expect(endpoint).not.toBe(WINDOWS_PIPE);
    // It consulted ~/.claude-bridge/config.json to make the decision.
    expect(mockReadFileSync).toHaveBeenCalledWith(
      join(homedir(), ".claude-bridge", "config.json"),
      "utf8",
    );
  });

  it("linux + config absent (read throws ENOENT) -> ~/.claude-bridge/daemon.sock fallback", () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const endpoint = discoverDaemonEndpoint("linux");
    expect(endpoint).toBe(FALLBACK_SOCK);
    expect(endpoint).not.toBe(WINDOWS_PIPE);
  });

  it("linux + config present but ipc_socket missing/empty -> daemon.sock fallback", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ daemon: { ipc_socket: "" } }));
    expect(discoverDaemonEndpoint("linux")).toBe(FALLBACK_SOCK);
    mockReadFileSync.mockReturnValue(JSON.stringify({ daemon: {} }));
    expect(discoverDaemonEndpoint("linux")).toBe(FALLBACK_SOCK);
  });

  it("linux + malformed config JSON -> daemon.sock fallback (no throw)", () => {
    mockReadFileSync.mockReturnValue("{ not valid json");
    expect(discoverDaemonEndpoint("linux")).toBe(FALLBACK_SOCK);
  });

  it("darwin takes the same generic-POSIX arm as linux (no win32 pipe)", () => {
    const configured = "/Users/dev/.claude-bridge/daemon.sock";
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ daemon: { ipc_socket: configured } }),
    );
    expect(discoverDaemonEndpoint("darwin")).toBe(configured);
    expect(discoverDaemonEndpoint("darwin")).not.toBe(WINDOWS_PIPE);
  });

  it("defaults to the host platform when no argument is passed (behavior-preserving)", () => {
    // No config read mocked to a value: on a non-win32 host this returns a
    // posix socket path; on win32 the pipe. Either way it must equal the
    // explicit-arg result for the host platform — proving the default arg is
    // process.platform.
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(discoverDaemonEndpoint()).toBe(discoverDaemonEndpoint(process.platform));
  });
});

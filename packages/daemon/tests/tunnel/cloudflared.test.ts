// T-TUNNEL-1 AC-T-2: cloudflared launches HIDDEN (windowsHide, no interactive
// console window) and owned-not-detached.

import { describe, it, expect, vi, beforeEach } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args) as unknown,
}));

// Minimal fake child: no stdout/stderr (skips the stream wiring), .on for
// error/exit, a pid.
function fakeChild(): unknown {
  return { on: vi.fn(), stdout: null, stderr: null, kill: vi.fn(), pid: 123 };
}

// Imported after the mock is registered.
const { CloudflaredProcess } = await import("../../src/tunnel/cloudflared.js");

describe("CloudflaredProcess launch options (T-TUNNEL-1 AC-T-2)", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockReturnValue(fakeChild());
  });

  it("AC-T-2: spawns with windowsHide:true and detached:false (hidden, owned)", () => {
    const proc = new CloudflaredProcess({
      binary: "cloudflared",
      localUrl: "http://localhost:1",
      argsExtra: [],
    });
    proc.start();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const call = spawnMock.mock.calls[0] as unknown[];
    const opts = call[2] as { windowsHide?: boolean; detached?: boolean };
    expect(opts.windowsHide).toBe(true); // no console window (the repro)
    expect(opts.detached).toBe(false); // owned: the daemon can kill it
  });
});

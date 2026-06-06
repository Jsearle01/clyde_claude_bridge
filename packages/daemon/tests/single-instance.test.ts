// CB-DAEMON-LIFECYCLE-FIX (a): the TCP bind port is the authoritative
// single-instance lock (the win32 named pipe permits multiple listeners and
// pid-file liveness is presence-only). isDaemonPortListening is the probe a
// starting daemon runs FIRST; a true result means another daemon owns the
// port → the new start refuses and the incumbent stays in force.

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { isDaemonPortListening } from "../src/main.js";

let server: Server | null = null;

afterEach(async () => {
  if (server !== null) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
});

describe("isDaemonPortListening (authoritative single-instance lock)", () => {
  it("returns false for a free port (no daemon → start proceeds)", async () => {
    // Port 1 is privileged/unused for our purpose; connect refuses fast.
    expect(await isDaemonPortListening("127.0.0.1", 1)).toBe(false);
  });

  it("returns true when something is listening (a daemon owns the port → refuse)", async () => {
    server = createServer();
    const port = await new Promise<number>((resolve) => {
      server?.listen(0, "127.0.0.1", () => {
        const addr = server?.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
      });
    });
    expect(await isDaemonPortListening("127.0.0.1", port)).toBe(true);
  });

  it("returns false again once the listener closes (incumbent gone → next start proceeds)", async () => {
    server = createServer();
    const port = await new Promise<number>((resolve) => {
      server?.listen(0, "127.0.0.1", () => {
        const addr = server?.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
      });
    });
    expect(await isDaemonPortListening("127.0.0.1", port)).toBe(true);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    expect(await isDaemonPortListening("127.0.0.1", port)).toBe(false);
  });
});

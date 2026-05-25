import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import * as vscode from "vscode";
import { IpcClient } from "../src/ipc/client.js";

// FakeSocket emulates the subset of net.Socket the IpcClient uses:
// setEncoding, on("connect"/"data"/"error"/"close"), write, destroy,
// removeAllListeners. Tests drive it directly to simulate the daemon side.
class FakeSocket extends EventEmitter {
  public written: string[] = [];
  public destroyed = false;

  setEncoding(): void {
    // noop — IpcClient calls this but tests don't observe encoding.
  }
  write(line: string): boolean {
    this.written.push(line);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
    queueMicrotask(() => this.emit("close"));
  }
  // Test helpers (not on real Socket — only invoked from tests).
  simulateConnect(): void {
    this.emit("connect");
  }
  simulateData(line: string): void {
    this.emit("data", line + "\n");
  }
}

describe("IpcClient (T-P2-002)", () => {
  let fakeSocket: FakeSocket;
  let client: IpcClient;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeSocket = new FakeSocket();
    client = new IpcClient("/fake/endpoint", {
      socketFactory: () => fakeSocket as unknown as Socket,
    });
  });

  afterEach(() => {
    client.disconnect();
  });

  it("starts disconnected", () => {
    expect(client.getConnectionState()).toBe("disconnected");
  });

  it("sends hello on connect with role=extension and version=1.0", async () => {
    const connectPromise = client.connect();
    fakeSocket.simulateConnect();
    fakeSocket.simulateData(
      JSON.stringify({
        kind: "hello_ok",
        daemon_version: "1.0",
        min_supported: "1.0",
      }),
    );
    await connectPromise;
    expect(fakeSocket.written).toHaveLength(1);
    const firstWrite = fakeSocket.written[0];
    if (firstWrite === undefined) throw new Error("expected written line");
    const sent = JSON.parse(firstWrite.trimEnd()) as {
      kind: string;
      version: string;
      role: string;
      pid: number;
    };
    expect(sent.kind).toBe("hello");
    expect(sent.version).toBe("1.0");
    expect(sent.role).toBe("extension");
    expect(typeof sent.pid).toBe("number");
  });

  it("resolves connect and reaches connected state on hello_ok", async () => {
    const connectPromise = client.connect();
    fakeSocket.simulateConnect();
    fakeSocket.simulateData(
      JSON.stringify({
        kind: "hello_ok",
        daemon_version: "1.0",
        min_supported: "1.0",
      }),
    );
    await connectPromise;
    expect(client.getConnectionState()).toBe("connected");
  });

  it("rejects connect, transitions to version_mismatch, and surfaces showErrorMessage on error reason=version_mismatch", async () => {
    const connectPromise = client.connect();
    fakeSocket.simulateConnect();
    fakeSocket.simulateData(
      JSON.stringify({
        kind: "error",
        message: "version mismatch: client 1.0, daemon 9.9, min supported 9.9",
        reason: "version_mismatch",
      }),
    );
    await expect(connectPromise).rejects.toThrow(/version mismatch/);
    expect(client.getConnectionState()).toBe("version_mismatch");
    const errorMock = vi.mocked(vscode.window.showErrorMessage);
    expect(errorMock).toHaveBeenCalledTimes(1);
    const callArg = errorMock.mock.calls[0]?.[0];
    expect(callArg).toContain("Claude Bridge");
    expect(callArg).toContain("version mismatch");
  });

  it("transitions to disconnected when socket closes after successful hello", async () => {
    const connectPromise = client.connect();
    fakeSocket.simulateConnect();
    fakeSocket.simulateData(
      JSON.stringify({
        kind: "hello_ok",
        daemon_version: "1.0",
        min_supported: "1.0",
      }),
    );
    await connectPromise;
    expect(client.getConnectionState()).toBe("connected");
    fakeSocket.emit("close");
    expect(client.getConnectionState()).toBe("disconnected");
    // Disconnect before the scheduled reconnect timer fires so the test
    // doesn't leave a pending socket connection attempt.
    client.disconnect();
  });

  it("does not auto-retry after version_mismatch (state stays version_mismatch)", async () => {
    const connectPromise = client.connect();
    fakeSocket.simulateConnect();
    fakeSocket.simulateData(
      JSON.stringify({
        kind: "error",
        message: "version mismatch",
        reason: "version_mismatch",
      }),
    );
    await expect(connectPromise).rejects.toThrow();
    expect(client.getConnectionState()).toBe("version_mismatch");
    // Emit close — handleDisconnect should NOT schedule a reconnect.
    fakeSocket.emit("close");
    expect(client.getConnectionState()).toBe("version_mismatch");
  });
});

// T-P2-005: onReconnectAttempt callback. Single-subscriber settable
// field; fires after each scheduleReconnect() counter increment;
// callback errors are swallowed.

describe("IpcClient.onReconnectAttempt callback (T-P2-005)", () => {
  it("fires with the incremented attempt count on each reconnect schedule", async () => {
    vi.useFakeTimers();
    try {
      // Each socketFactory invocation must yield a fresh FakeSocket; the
      // first one fails its hello to trigger handleDisconnect →
      // scheduleReconnect.
      const sockets: FakeSocket[] = [];
      const factory = (): Socket => {
        const sock = new FakeSocket();
        sockets.push(sock);
        return sock as unknown as Socket;
      };
      const client = new IpcClient("/fake", { socketFactory: factory });
      const attempts: number[] = [];
      client.onReconnectAttempt = (n: number) => attempts.push(n);
      const connectPromise = client.connect();
      // First socket: simulate close before hello completes → handleDisconnect.
      // Use queueMicrotask so the connect promise's listeners are wired first.
      queueMicrotask(() => {
        sockets[0]?.emit("close");
      });
      await expect(connectPromise).rejects.toThrow();
      // First reconnect already scheduled; counter == 1.
      expect(attempts).toEqual([1]);
      // Advance to the first scheduled reconnect (1s base).
      await vi.advanceTimersByTimeAsync(1100);
      // The doConnect() instantiates a 2nd socket; close it to trigger
      // the next handleDisconnect → scheduleReconnect.
      sockets[1]?.emit("close");
      // Wait for the microtask cycle that registers the next timer.
      await Promise.resolve();
      expect(attempts).toEqual([1, 2]);
      await vi.advanceTimersByTimeAsync(2100);
      sockets[2]?.emit("close");
      await Promise.resolve();
      expect(attempts).toEqual([1, 2, 3]);
      client.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire on successful connect (counter does not increment on hello_ok)", async () => {
    const fakeSocket = new FakeSocket();
    const client = new IpcClient("/fake", {
      socketFactory: () => fakeSocket as unknown as Socket,
    });
    const attempts: number[] = [];
    client.onReconnectAttempt = (n: number) => attempts.push(n);
    const connectPromise = client.connect();
    fakeSocket.simulateConnect();
    fakeSocket.simulateData(
      JSON.stringify({
        kind: "hello_ok",
        daemon_version: "1.0",
        min_supported: "1.0",
      }),
    );
    await connectPromise;
    expect(attempts).toEqual([]);
    client.disconnect();
  });

  it("swallows subscriber errors and keeps reconnect machinery alive", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const factory = (): Socket => {
        const sock = new FakeSocket();
        sockets.push(sock);
        return sock as unknown as Socket;
      };
      const client = new IpcClient("/fake", { socketFactory: factory });
      let callCount = 0;
      client.onReconnectAttempt = (): void => {
        callCount += 1;
        throw new Error("subscriber blew up");
      };
      const connectPromise = client.connect();
      queueMicrotask(() => sockets[0]?.emit("close"));
      await expect(connectPromise).rejects.toThrow();
      // First callback invocation threw — but reconnect must still
      // schedule the next attempt.
      expect(callCount).toBe(1);
      await vi.advanceTimersByTimeAsync(1100);
      sockets[1]?.emit("close");
      await Promise.resolve();
      // Subscriber threw again; counter still incremented.
      expect(callCount).toBe(2);
      client.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
});

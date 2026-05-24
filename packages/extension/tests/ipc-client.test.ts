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

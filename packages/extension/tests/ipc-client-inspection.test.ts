// T-P2-009 / T-P2-010: tests for IpcClient.onGetOpenEditorsRequest and
// onGetDiagnosticsRequest dispatch. Mirrors the approval-request
// dispatch test shape from ipc-client.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { IpcClient } from "../src/ipc/client.js";

class FakeSocket extends EventEmitter {
  public written: string[] = [];
  setEncoding(): void {
    /* noop */
  }
  write(line: string): boolean {
    this.written.push(line);
    return true;
  }
  destroy(): void {
    queueMicrotask(() => this.emit("close"));
  }
  simulateConnect(): void {
    this.emit("connect");
  }
  simulateData(line: string): void {
    this.emit("data", line + "\n");
  }
}

async function makeConnectedClient(): Promise<{
  client: IpcClient;
  sock: FakeSocket;
}> {
  const sock = new FakeSocket();
  const client = new IpcClient("/fake", {
    socketFactory: () => sock as unknown as Socket,
  });
  const p = client.connect();
  sock.simulateConnect();
  sock.simulateData(
    JSON.stringify({
      kind: "hello_ok",
      daemon_version: "1.0",
      min_supported: "1.0",
    }),
  );
  await p;
  return { client, sock };
}

describe("IpcClient.onGetOpenEditorsRequest dispatch (T-P2-009)", () => {
  let client: IpcClient;
  let sock: FakeSocket;
  beforeEach(async () => {
    const made = await makeConnectedClient();
    client = made.client;
    sock = made.sock;
  });
  afterEach(() => {
    client.disconnect();
  });

  it("fires onGetOpenEditorsRequest when get_open_editors_request arrives", async () => {
    const received: string[] = [];
    client.onGetOpenEditorsRequest = (req): Promise<void> => {
      received.push(req.request_id);
      return Promise.resolve();
    };
    sock.simulateData(
      JSON.stringify({
        kind: "get_open_editors_request",
        request_id: "rid_a",
      }),
    );
    // Allow microtask queue for void-promise dispatch.
    await Promise.resolve();
    expect(received).toEqual(["rid_a"]);
  });

  it("swallows subscriber rejections without disrupting subsequent messages", async () => {
    let count = 0;
    client.onGetOpenEditorsRequest = (): Promise<void> => {
      count += 1;
      return Promise.reject(new Error("boom"));
    };
    sock.simulateData(
      JSON.stringify({
        kind: "get_open_editors_request",
        request_id: "rid_1",
      }),
    );
    sock.simulateData(
      JSON.stringify({
        kind: "get_open_editors_request",
        request_id: "rid_2",
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(count).toBe(2);
  });
});

describe("IpcClient.onGetDiagnosticsRequest dispatch (T-P2-010)", () => {
  let client: IpcClient;
  let sock: FakeSocket;
  beforeEach(async () => {
    const made = await makeConnectedClient();
    client = made.client;
    sock = made.sock;
  });
  afterEach(() => {
    client.disconnect();
  });

  it("fires onGetDiagnosticsRequest with the parsed severities array", async () => {
    let captured: { request_id: string; severities: string[] } | null = null;
    client.onGetDiagnosticsRequest = (req): Promise<void> => {
      captured = { request_id: req.request_id, severities: [...req.severities] };
      return Promise.resolve();
    };
    sock.simulateData(
      JSON.stringify({
        kind: "get_diagnostics_request",
        request_id: "rid_d",
        severities: ["error", "warning"],
      }),
    );
    await Promise.resolve();
    expect(captured).toEqual({
      request_id: "rid_d",
      severities: ["error", "warning"],
    });
  });

  it("when no callback is attached, the message is silently dropped (no throw)", () => {
    expect(() => {
      sock.simulateData(
        JSON.stringify({
          kind: "get_diagnostics_request",
          request_id: "rid_drop",
          severities: ["error"],
        }),
      );
    }).not.toThrow();
  });
});

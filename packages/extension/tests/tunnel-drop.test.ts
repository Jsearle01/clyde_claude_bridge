// T-TUNNEL-1 (B): the extension drop-recovery modal.

import { describe, it, expect, vi } from "vitest";
import type { TunnelDropRequest } from "@claude-bridge/shared";
import {
  composeTunnelDropModalText,
  makeTunnelDropHandler,
  BTN_ADOPT,
  BTN_DENY,
} from "../src/tunnel-drop.js";
import type { IpcClient } from "../src/ipc/client.js";

const NEW_URL = "https://new-xyz.trycloudflare.com";

function req(): TunnelDropRequest {
  return {
    kind: "tunnel_drop_request",
    request_id: "r1",
    new_url: NEW_URL,
  };
}

function fakeClient(): IpcClient & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn() } as unknown as IpcClient & {
    send: ReturnType<typeof vi.fn>;
  };
}

describe("tunnel-drop modal (T-TUNNEL-1 B)", () => {
  it("AC-T-5: the modal text shows the new URL", () => {
    const t = composeTunnelDropModalText(req());
    expect(t).toContain(NEW_URL);
    expect(t.toLowerCase()).toContain("tunnel dropped");
  });

  it("AC-T-6: Adopt → tunnel_drop_response confirm", async () => {
    const client = fakeClient();
    const handler = makeTunnelDropHandler(client, {
      showWarningMessage: vi.fn(() => Promise.resolve(BTN_ADOPT)),
    });
    await handler(req());
    expect(client.send).toHaveBeenCalledWith({
      kind: "tunnel_drop_response",
      request_id: "r1",
      decision: "confirm",
    });
  });

  it("AC-T-6: Disconnect → tunnel_drop_response deny", async () => {
    const client = fakeClient();
    const handler = makeTunnelDropHandler(client, {
      showWarningMessage: vi.fn(() => Promise.resolve(BTN_DENY)),
    });
    await handler(req());
    expect(client.send).toHaveBeenCalledWith({
      kind: "tunnel_drop_response",
      request_id: "r1",
      decision: "deny",
    });
  });

  it("dismiss (no choice) → NO response (the daemon keeps it pending)", async () => {
    const client = fakeClient();
    const handler = makeTunnelDropHandler(client, {
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
    });
    await handler(req());
    expect(client.send).not.toHaveBeenCalled();
  });
});

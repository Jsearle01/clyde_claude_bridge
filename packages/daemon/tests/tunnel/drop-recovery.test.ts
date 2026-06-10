// T-TUNNEL-1 (B): operator-gated drop recovery — the never-silent-adopt core.

import { describe, it, expect, vi } from "vitest";
import {
  DropRecovery,
  type DropRecoveryDeps,
} from "../../src/tunnel/drop-recovery.js";
import type { Logger } from "../../src/log/logger.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};

const NEW_URL = "https://new-xyz.trycloudflare.com";

function makeDeps(sendImpl: () => boolean = () => true) {
  const adopt = vi.fn<(url: string) => void>();
  const teardown = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const sendRequest =
    vi.fn<(r: { request_id: string; new_url: string }) => boolean>(sendImpl);
  const genRequestId = vi.fn<() => string>(() => "req-1");
  const deps: DropRecoveryDeps = {
    adopt,
    teardown,
    sendRequest,
    genRequestId,
    logger: silentLogger,
  };
  return { deps, adopt, teardown, sendRequest };
}

describe("DropRecovery (T-TUNNEL-1 B)", () => {
  it("AC-T-7 (never silent-adopt): a drop-respawn HOLDS the url — only asks, never adopts", () => {
    const { deps, adopt } = makeDeps();
    const dr = new DropRecovery(deps);
    dr.onDropRespawn(NEW_URL);
    // The structural guarantee: no adopt without a confirm.
    expect(adopt).not.toHaveBeenCalled();
    expect(dr.pendingUrl()).toBe(NEW_URL);
  });

  it("AC-T-5: the modal request carries the new URL", () => {
    const { deps, sendRequest } = makeDeps();
    new DropRecovery(deps).onDropRespawn(NEW_URL);
    expect(sendRequest).toHaveBeenCalledWith({
      request_id: "req-1",
      new_url: NEW_URL,
    });
  });

  it("AC-T-6 confirm → adopts the new URL, clears pending, never tears down", async () => {
    const { deps, adopt, teardown } = makeDeps();
    const dr = new DropRecovery(deps);
    dr.onDropRespawn(NEW_URL);
    await dr.onDecision("req-1", "confirm");
    expect(adopt).toHaveBeenCalledWith(NEW_URL);
    expect(teardown).not.toHaveBeenCalled();
    expect(dr.pendingUrl()).toBeNull();
  });

  it("AC-T-6 deny → tears down (tunnel-less), never adopts", async () => {
    const { deps, adopt, teardown } = makeDeps();
    const dr = new DropRecovery(deps);
    dr.onDropRespawn(NEW_URL);
    await dr.onDecision("req-1", "deny");
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(adopt).not.toHaveBeenCalled();
    expect(dr.pendingUrl()).toBeNull();
  });

  it("a stale/unknown request_id is ignored (still pending, no adopt)", async () => {
    const { deps, adopt } = makeDeps();
    const dr = new DropRecovery(deps);
    dr.onDropRespawn(NEW_URL);
    await dr.onDecision("wrong-id", "confirm");
    expect(adopt).not.toHaveBeenCalled();
    expect(dr.pendingUrl()).toBe(NEW_URL);
  });

  it("AC-T-8 no extension at drop → stays pending, re-fires on next connect", () => {
    const { deps, adopt, sendRequest } = makeDeps(() => false); // not delivered
    const dr = new DropRecovery(deps);
    dr.onDropRespawn(NEW_URL);
    expect(dr.pendingUrl()).toBe(NEW_URL); // held, not decided
    expect(sendRequest).toHaveBeenCalledTimes(1);
    dr.fireIfPending(); // an extension connects
    expect(sendRequest).toHaveBeenCalledTimes(2); // modal re-fired
    expect(adopt).not.toHaveBeenCalled(); // still never silently adopted
  });
});

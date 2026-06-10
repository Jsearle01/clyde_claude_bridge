// T-TUNNEL-1 (B): operator-gated drop recovery. A dropped quick-tunnel respawns
// to a NEW url (the TunnelManager handles the respawn + emits url_pending). This
// holds that url PENDING and drives the operator's confirm/deny through the
// daemon-initiated modal channel — never silently adopting a rotated url (which
// would strand the claude.ai connector at the dead one).
//
// The structural never-silent-adopt guarantee (AC-T-7) lives here: onDropRespawn
// only records the pending url and asks; ONLY onDecision("confirm") calls
// deps.adopt. There is no path from a respawn to adoption without a confirm.

import type { Logger } from "../log/logger.js";

export interface DropRecoveryDeps {
  // Promote the pending url to the live tunnel (state.tunnelUrl = url). Called
  // ONLY on confirm.
  adopt: (url: string) => void;
  // Tear the respawned tunnel down (deny → daemon sits tunnel-less).
  teardown: () => Promise<void>;
  // Surface the modal to a connected extension. Returns true if it was
  // delivered to at least one extension, false if none is connected (then it
  // stays pending and is re-fired on the next connect via fireIfPending).
  sendRequest: (request: { request_id: string; new_url: string }) => boolean;
  genRequestId: () => string;
  logger: Logger;
}

export class DropRecovery {
  private pending: { request_id: string; new_url: string } | null = null;

  constructor(private readonly deps: DropRecoveryDeps) {}

  /** A drop-respawn produced `newUrl`. Record it PENDING and ask the operator.
   *  Never adopts here. */
  onDropRespawn(newUrl: string): void {
    const request_id = this.deps.genRequestId();
    this.pending = { request_id, new_url: newUrl };
    const delivered = this.deps.sendRequest(this.pending);
    this.deps.logger.warn(
      "tunnel dropped — new url pending operator confirmation",
      { new_url: newUrl, modal_delivered: delivered },
    );
  }

  /** An extension just connected — re-surface any pending decision (the
   *  no-extension-at-drop-time fallback fires here). */
  fireIfPending(): void {
    if (this.pending !== null) this.deps.sendRequest(this.pending);
  }

  /** The operator's decision arrived. confirm → adopt; deny → teardown.
   *  Stale/unknown request_ids are ignored (daemon-authoritative). */
  async onDecision(
    request_id: string,
    decision: "confirm" | "deny",
  ): Promise<void> {
    if (this.pending === null || this.pending.request_id !== request_id) return;
    const { new_url } = this.pending;
    this.pending = null;
    if (decision === "confirm") {
      this.deps.adopt(new_url);
      this.deps.logger.info("tunnel drop: operator adopted the new url", {
        new_url,
      });
    } else {
      await this.deps.teardown();
      this.deps.logger.info(
        "tunnel drop: operator declined; tunnel torn down (tunnel-less)",
        {},
      );
    }
  }

  /** The pending (unconfirmed) url, or null — surfaced in CLI `status`. */
  pendingUrl(): string | null {
    return this.pending?.new_url ?? null;
  }
}

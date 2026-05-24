// Tests for the acceptance-harness-only stub_behavior config gating
// (T-P1-005; retained through P1 close and through P2 until the
// StubJobRunner path is retired).
// We exercise the schema directly here; the runtime gating in main.ts is
// trivially correct by construction (if config.stub_behavior !== undefined
// && !flag → throw). The acceptance harness's daemon-lifecycle path
// exercises both gating arms in practice.

import { describe, it, expect } from "vitest";
import { ConfigSchema, StubBehaviorSchema } from "@claude-bridge/shared";

const baseConfig = {
  version: 1,
  daemon: { ipc_socket: "/tmp/d.sock" },
  auth: { token: "cb_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
  tunnel: {},
  audit: { path: "/tmp/audit.jsonl" },
  log: { path: "/tmp/daemon.log" },
};

describe("StubBehaviorSchema (acceptance-harness only)", () => {
  it("accepts a minimal behavior", () => {
    expect(StubBehaviorSchema.parse({ outcome: "complete" })).toEqual({
      outcome: "complete",
    });
  });

  it("accepts the full shape", () => {
    const r = StubBehaviorSchema.parse({
      outcome: "failed",
      delay_ms: 100,
      partial_updates: [
        { turns_so_far: 1, last_tool: "Bash", elapsed_ms: 50 },
      ],
      report: { summary: "override" },
      error: {
        category: "sdk_runtime",
        message: "boom",
        details: null,
      },
    });
    expect(r.outcome).toBe("failed");
    expect(r.delay_ms).toBe(100);
    expect(r.partial_updates).toHaveLength(1);
    expect(r.report?.summary).toBe("override");
  });

  it("rejects unknown outcome values", () => {
    expect(
      StubBehaviorSchema.safeParse({ outcome: "weird" }).success,
    ).toBe(false);
  });

  it("rejects extra fields (.strict())", () => {
    expect(
      StubBehaviorSchema.safeParse({
        outcome: "complete",
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe("ConfigSchema.stub_behavior (acceptance-harness only)", () => {
  it("accepts a config WITHOUT stub_behavior", () => {
    const r = ConfigSchema.parse(baseConfig);
    expect(r.stub_behavior).toBeUndefined();
  });

  it("accepts a config WITH stub_behavior", () => {
    const r = ConfigSchema.parse({
      ...baseConfig,
      stub_behavior: { outcome: "complete" },
    });
    expect(r.stub_behavior?.outcome).toBe("complete");
  });

  it("rejects an invalid stub_behavior", () => {
    expect(
      ConfigSchema.safeParse({
        ...baseConfig,
        stub_behavior: { outcome: "weird" },
      }).success,
    ).toBe(false);
  });
});

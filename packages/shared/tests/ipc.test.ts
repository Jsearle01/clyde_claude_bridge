import { describe, it, expect } from "vitest";
import {
  IpcRequestSchema,
  IpcResponseSchema,
  StatusPayloadSchema,
  type StatusPayload,
} from "../src/index.js";

const validStatusPayload: StatusPayload = {
  daemon_pid: 12345,
  daemon_uptime_s: 3600,
  endpoint: "127.0.0.1:7423",
  tunnel_status: "up",
  tunnel_url: "https://plum-otter-7821.trycloudflare.com",
  audit_path: "/home/user/.claude-bridge/audit.jsonl",
  audit_size_bytes: 14336,
  attached_workspaces: 0,
};

describe("IpcRequestSchema", () => {
  it.each([
    { kind: "status" as const },
    { kind: "stop" as const },
    // T-BEARER-1: token_rotate removed.
    { kind: "tunnel_restart" as const },
  ])("parses valid request variant: $kind (5.a)", (input) => {
    expect(IpcRequestSchema.safeParse(input).success).toBe(true);
  });

  it("rejects an unknown kind (5.b)", () => {
    expect(IpcRequestSchema.safeParse({ kind: "explode" }).success).toBe(false);
  });

  it("rejects a valid variant with an extra field — .strict() (5.c)", () => {
    expect(
      IpcRequestSchema.safeParse({ kind: "status", extra: 1 }).success,
    ).toBe(false);
  });
});

describe("IpcResponseSchema", () => {
  it.each([
    { kind: "status_ok" as const, payload: validStatusPayload },
    { kind: "stop_ok" as const },
    // T-BEARER-1: token_rotate_ok removed.
    {
      kind: "tunnel_restart_ok" as const,
      new_url: "https://plum-otter-7821.trycloudflare.com",
    },
    { kind: "error" as const, message: "something went wrong" },
  ])("parses valid response variant: $kind (5.d)", (input) => {
    expect(IpcResponseSchema.safeParse(input).success).toBe(true);
  });

  it("rejects an unknown kind (5.e)", () => {
    expect(IpcResponseSchema.safeParse({ kind: "explode" }).success).toBe(false);
  });

  it("rejects a valid variant with an extra field — .strict() (5.f)", () => {
    expect(
      IpcResponseSchema.safeParse({ kind: "stop_ok", extra: 1 }).success,
    ).toBe(false);
  });
});

describe("StatusPayloadSchema", () => {
  it("parses a complete, well-formed payload (5.g)", () => {
    const result = StatusPayloadSchema.parse(validStatusPayload);
    expect(result.daemon_pid).toBe(12345);
    expect(result.tunnel_status).toBe("up");
    expect(result.attached_workspaces).toBe(0);
  });
  // T-BEARER-1: the token_suffix field (and its length check, 5.h) was removed.
});

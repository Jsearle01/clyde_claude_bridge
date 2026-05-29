// T-P2-009 / T-P2-010: schema regression tests for the new IPC
// request/response/server-message variants and the tool I/O schemas.

import { describe, it, expect } from "vitest";
import {
  IpcRequestSchema,
  IpcServerMessageSchema,
  GetOpenEditorsInputSchema,
  GetDiagnosticsInputSchema,
  expandSeverityThreshold,
} from "../src/index.js";

describe("IpcServerMessageSchema — daemon→extension inspection requests", () => {
  it("parses get_open_editors_request", () => {
    const ok = IpcServerMessageSchema.safeParse({
      kind: "get_open_editors_request",
      request_id: "etr_abc",
    });
    expect(ok.success).toBe(true);
  });

  it("parses get_diagnostics_request with severities array", () => {
    const ok = IpcServerMessageSchema.safeParse({
      kind: "get_diagnostics_request",
      request_id: "etr_def",
      severities: ["error", "warning"],
    });
    expect(ok.success).toBe(true);
  });

  it("rejects get_diagnostics_request without severities", () => {
    const bad = IpcServerMessageSchema.safeParse({
      kind: "get_diagnostics_request",
      request_id: "etr_def",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects unknown severity strings", () => {
    const bad = IpcServerMessageSchema.safeParse({
      kind: "get_diagnostics_request",
      request_id: "etr_def",
      severities: ["fatal"],
    });
    expect(bad.success).toBe(false);
  });
});

describe("IpcRequestSchema — extension→daemon inspection responses", () => {
  it("parses get_open_editors_response", () => {
    const ok = IpcRequestSchema.safeParse({
      kind: "get_open_editors_response",
      request_id: "r",
      editors: [
        {
          uri: "file:///c:/a.ts",
          fs_path: "c:\\a.ts",
          is_active: true,
          is_dirty: false,
        },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it("parses get_diagnostics_response", () => {
    const ok = IpcRequestSchema.safeParse({
      kind: "get_diagnostics_response",
      request_id: "r",
      diagnostics: [
        {
          uri: "file:///c:/a.ts",
          fs_path: "c:\\a.ts",
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 4 },
          },
          severity: "error",
          message: "bad",
          source: "tsc",
        },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it("parses get_diagnostics_response with source omitted", () => {
    const ok = IpcRequestSchema.safeParse({
      kind: "get_diagnostics_response",
      request_id: "r",
      diagnostics: [
        {
          uri: "u",
          fs_path: "p",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          severity: "warning",
          message: "m",
        },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it("parses extension_tool_error envelope", () => {
    const ok = IpcRequestSchema.safeParse({
      kind: "extension_tool_error",
      request_id: "r",
      message: "boom",
    });
    expect(ok.success).toBe(true);
  });
});

describe("GetOpenEditorsInputSchema", () => {
  it("accepts an empty object", () => {
    expect(GetOpenEditorsInputSchema.safeParse({}).success).toBe(true);
  });
  it("accepts {workspace}", () => {
    expect(
      GetOpenEditorsInputSchema.safeParse({ workspace: "a" }).success,
    ).toBe(true);
  });
  it("rejects extra fields (.strict)", () => {
    expect(
      GetOpenEditorsInputSchema.safeParse({ workspace: "a", extra: 1 }).success,
    ).toBe(false);
  });
});

describe("GetDiagnosticsInputSchema", () => {
  it("accepts an empty object (severity defaults to all)", () => {
    expect(GetDiagnosticsInputSchema.safeParse({}).success).toBe(true);
  });
  it.each(["error", "warning", "all"] as const)(
    "accepts severity %s",
    (sev) => {
      expect(
        GetDiagnosticsInputSchema.safeParse({ severity: sev }).success,
      ).toBe(true);
    },
  );
  it("rejects severity='fatal'", () => {
    expect(
      GetDiagnosticsInputSchema.safeParse({ severity: "fatal" }).success,
    ).toBe(false);
  });
  it("rejects extra fields", () => {
    expect(
      GetDiagnosticsInputSchema.safeParse({ severity: "all", extra: 1 })
        .success,
    ).toBe(false);
  });
});

describe("expandSeverityThreshold (T-P2-010)", () => {
  it.each([
    ["error", ["error"]],
    ["warning", ["error", "warning"]],
    ["all", ["error", "warning", "info", "hint"]],
  ] as const)("%s → %j", (input, expected) => {
    expect(expandSeverityThreshold(input)).toEqual(expected);
  });
});

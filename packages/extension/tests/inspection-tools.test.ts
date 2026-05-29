import { describe, it, expect, vi } from "vitest";
import {
  makeGetOpenEditorsHandler,
  makeGetDiagnosticsHandler,
  mapVsCodeSeverity,
  type VsCodeTabsApi,
  type VsCodeDiagnosticsApi,
  type InspectionIpcSender,
} from "../src/inspection-tools.js";
import type {
  GetOpenEditorsRequest,
  GetDiagnosticsRequest,
} from "@claude-bridge/shared";

interface FakeSender extends InspectionIpcSender {
  sent: unknown[];
  failNext: boolean;
}

function makeFakeSender(): FakeSender {
  const sent: unknown[] = [];
  const fake: FakeSender = {
    sent,
    failNext: false,
    send(message: unknown): void {
      if (fake.failNext) throw new Error("socket closed");
      sent.push(message);
    },
  };
  return fake;
}

function makeUri(path: string): { toString(): string; fsPath: string } {
  return {
    toString: () => `file://${path}`,
    fsPath: path,
  };
}

describe("mapVsCodeSeverity", () => {
  it.each([
    [0, "error"],
    [1, "warning"],
    [2, "info"],
    [3, "hint"],
  ] as const)("maps %i → %s", (input, expected) => {
    expect(mapVsCodeSeverity(input)).toBe(expected);
  });
  it("maps unknown to 'info' (defensive)", () => {
    expect(mapVsCodeSeverity(99)).toBe("info");
  });
});

describe("makeGetOpenEditorsHandler (T-P2-009)", () => {
  it("collects text tabs from all groups with is_active/is_dirty per tab", async () => {
    const uri1 = makeUri("/c/a.ts");
    const uri2 = makeUri("/c/b.ts");
    const uri3 = makeUri("/c/c.ts");
    const groupA = {
      tabs: [
        { input: { uri: uri1 }, isActive: true, isDirty: false },
        { input: { uri: uri2 }, isActive: false, isDirty: true },
      ],
    };
    const groupB = {
      tabs: [{ input: { uri: uri3 }, isActive: true, isDirty: false }],
    };
    const tabsApi: VsCodeTabsApi = {
      tabGroups: {
        all: [groupA, groupB],
        activeTabGroup: groupA,
      },
    };
    const sender = makeFakeSender();
    const handler = makeGetOpenEditorsHandler(sender, { tabsApi });
    const req: GetOpenEditorsRequest = {
      kind: "get_open_editors_request",
      request_id: "rid_1",
    };
    await handler(req);
    expect(sender.sent).toHaveLength(1);
    const sent = sender.sent[0] as {
      kind: string;
      request_id: string;
      editors: Array<{ fs_path: string; is_active: boolean; is_dirty: boolean }>;
    };
    expect(sent.kind).toBe("get_open_editors_response");
    expect(sent.request_id).toBe("rid_1");
    expect(sent.editors).toHaveLength(3);
    // Tab in active group + isActive=true → is_active: true
    expect(sent.editors[0]).toMatchObject({
      fs_path: "/c/a.ts",
      is_active: true,
      is_dirty: false,
    });
    expect(sent.editors[1]).toMatchObject({
      fs_path: "/c/b.ts",
      is_active: false,
      is_dirty: true,
    });
    // Tab in non-active group, even if isActive=true within its group, is_active=false
    expect(sent.editors[2]).toMatchObject({
      fs_path: "/c/c.ts",
      is_active: false,
    });
  });

  it("filters out non-text tabs (no uri on input)", async () => {
    const tabsApi: VsCodeTabsApi = {
      tabGroups: {
        all: [
          {
            tabs: [
              { input: null, isActive: false, isDirty: false },
              { input: { notUri: true }, isActive: false, isDirty: false },
              {
                input: { uri: makeUri("/c/real.ts") },
                isActive: true,
                isDirty: false,
              },
            ],
          },
        ],
        activeTabGroup: undefined,
      },
    };
    const sender = makeFakeSender();
    const handler = makeGetOpenEditorsHandler(sender, { tabsApi });
    await handler({ kind: "get_open_editors_request", request_id: "r" });
    const sent = sender.sent[0] as { editors: { fs_path: string }[] };
    expect(sent.editors).toHaveLength(1);
    expect(sent.editors[0]?.fs_path).toBe("/c/real.ts");
  });

  it("sends extension_tool_error envelope when the tabs API throws", async () => {
    const tabsApi = {
      get tabGroups(): never {
        throw new Error("vscode is on fire");
      },
    } as unknown as VsCodeTabsApi;
    const sender = makeFakeSender();
    const handler = makeGetOpenEditorsHandler(sender, { tabsApi });
    await handler({ kind: "get_open_editors_request", request_id: "rid_x" });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toMatchObject({
      kind: "extension_tool_error",
      request_id: "rid_x",
      message: "vscode is on fire",
    });
  });

  it("swallows ipcClient.send failure mid-response (socket closed)", async () => {
    const tabsApi: VsCodeTabsApi = {
      tabGroups: { all: [], activeTabGroup: undefined },
    };
    const sender = makeFakeSender();
    sender.failNext = true;
    const handler = makeGetOpenEditorsHandler(sender, { tabsApi });
    await expect(
      handler({ kind: "get_open_editors_request", request_id: "rid" }),
    ).resolves.toBeUndefined();
  });
});

describe("makeGetDiagnosticsHandler (T-P2-010)", () => {
  it("returns diagnostics filtered by severities, maps shape, and sends a response", async () => {
    const uri = makeUri("/c/foo.ts");
    const diagnosticsApi: VsCodeDiagnosticsApi = {
      getDiagnostics: () => [
        [
          uri,
          [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
              severity: 0,
              message: "err1",
              source: "tsc",
            },
            {
              range: {
                start: { line: 3, character: 1 },
                end: { line: 3, character: 4 },
              },
              severity: 1,
              message: "warn1",
            },
            {
              range: {
                start: { line: 5, character: 0 },
                end: { line: 5, character: 0 },
              },
              severity: 2,
              message: "info1",
            },
          ],
        ],
      ],
    };
    const sender = makeFakeSender();
    const handler = makeGetDiagnosticsHandler(sender, { diagnosticsApi });
    const req: GetDiagnosticsRequest = {
      kind: "get_diagnostics_request",
      request_id: "r",
      severities: ["error", "warning"],
    };
    await handler(req);
    const sent = sender.sent[0] as {
      kind: string;
      diagnostics: Array<{ severity: string; message: string; source?: string }>;
    };
    expect(sent.kind).toBe("get_diagnostics_response");
    expect(sent.diagnostics).toHaveLength(2);
    expect(sent.diagnostics[0]).toMatchObject({
      severity: "error",
      message: "err1",
      source: "tsc",
    });
    expect(sent.diagnostics[1]).toMatchObject({
      severity: "warning",
      message: "warn1",
    });
    // Optional source field omitted when not present in source diagnostic.
    expect(sent.diagnostics[1]?.source).toBeUndefined();
  });

  it("respects the severities set — empty set returns empty list even with diagnostics present", async () => {
    const diagnosticsApi: VsCodeDiagnosticsApi = {
      getDiagnostics: () => [
        [
          makeUri("/a"),
          [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
              },
              severity: 0,
              message: "x",
            },
          ],
        ],
      ],
    };
    const sender = makeFakeSender();
    const handler = makeGetDiagnosticsHandler(sender, { diagnosticsApi });
    await handler({
      kind: "get_diagnostics_request",
      request_id: "r",
      severities: [],
    });
    const sent = sender.sent[0] as { diagnostics: unknown[] };
    expect(sent.diagnostics).toHaveLength(0);
  });

  it("sends extension_tool_error when getDiagnostics throws", async () => {
    const diagnosticsApi = {
      getDiagnostics: () => {
        throw new Error("lsp dead");
      },
    } as unknown as VsCodeDiagnosticsApi;
    const sender = makeFakeSender();
    const handler = makeGetDiagnosticsHandler(sender, { diagnosticsApi });
    await handler({
      kind: "get_diagnostics_request",
      request_id: "rrr",
      severities: ["error"],
    });
    expect(sender.sent[0]).toMatchObject({
      kind: "extension_tool_error",
      request_id: "rrr",
      message: "lsp dead",
    });
  });
});

// Suppress unused vi import warning by making at least one assertion via mock.
void vi;

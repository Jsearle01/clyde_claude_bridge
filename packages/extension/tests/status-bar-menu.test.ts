import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as vscode from "vscode";
import type { WorkspaceFolder } from "./mocks/vscode.js";
import {
  composeMenuItems,
  makeStatusBarMenu,
  STOP_HINT_TEXT,
  TRUST_DENIED_HINT,
  type MenuItem,
} from "../src/status-bar-menu.js";
import type { StatusBarSources, DaemonInfo } from "../src/status-bar.js";

function makeSources(overrides: Partial<{
  conn: ReturnType<StatusBarSources["getConnectionState"]>;
  reg: ReturnType<StatusBarSources["getRegistrationState"]>;
  identifier: string | null;
  existingPid: number | null;
  folder: WorkspaceFolder | undefined;
  daemonInfo: DaemonInfo | undefined;
}>): StatusBarSources {
  const opts = {
    conn: "connected" as const,
    reg: "registered" as const,
    identifier: "myproject-aaaaaa",
    existingPid: null,
    folder: { uri: { fsPath: "/projects/myproject" }, name: "myproject" } as
      | WorkspaceFolder
      | undefined,
    daemonInfo: undefined as DaemonInfo | undefined,
    ...overrides,
  };
  return {
    getConnectionState: () => opts.conn,
    getRegistrationState: () => opts.reg,
    getRegistrationIdentifier: () => opts.identifier,
    getRegistrationExistingPid: () => opts.existingPid,
    getWorkspaceFolder: () => opts.folder,
    getDaemonInfo: () => opts.daemonInfo,
  };
}

describe("composeMenuItems (T-P2-006)", () => {
  it("connected + registered + daemon info: includes Show Status, Open URL, Copy Identifier, Stop hint", () => {
    const items = composeMenuItems(
      makeSources({
        daemonInfo: { pid: 1, url: "https://x.trycloudflare.com", uptime_s: 0 },
      }),
    );
    const kinds = items.map((i) => i.action.kind);
    expect(kinds).toContain("show_status");
    expect(kinds).toContain("open_daemon_url");
    expect(kinds).toContain("copy_identifier");
    expect(kinds).toContain("stop_daemon_hint");
  });

  it("connected + registered + no daemon info: omits Open URL", () => {
    const items = composeMenuItems(
      makeSources({ daemonInfo: undefined }),
    );
    const kinds = items.map((i) => i.action.kind);
    expect(kinds).not.toContain("open_daemon_url");
    expect(kinds).toContain("copy_identifier");
  });

  it("disconnected: shows Start Daemon; omits Stop hint and Open URL", () => {
    const items = composeMenuItems(
      makeSources({ conn: "disconnected" }),
    );
    const kinds = items.map((i) => i.action.kind);
    expect(kinds).toContain("start_daemon");
    expect(kinds).not.toContain("stop_daemon_hint");
    expect(kinds).not.toContain("open_daemon_url");
  });

  it("connecting: only Show Status (no actionable items during transient)", () => {
    const items = composeMenuItems(
      makeSources({ conn: "connecting" }),
    );
    const kinds = items.map((i) => i.action.kind);
    expect(kinds).toEqual(["show_status"]);
  });

  it("trust_denied: surfaces descriptive Trust denied item with hint", () => {
    const items = composeMenuItems(
      makeSources({ conn: "disconnected", reg: "trust_denied", identifier: null }),
    );
    const trustItem = items.find(
      (i) => i.action.kind === "info_only" && /denied/i.test(i.label),
    );
    expect(trustItem).toBeDefined();
    expect(trustItem?.description).toBe(TRUST_DENIED_HINT);
  });

  it("duplicate: surfaces descriptive Path conflict item with pid", () => {
    const items = composeMenuItems(
      makeSources({ reg: "duplicate", identifier: null, existingPid: 12345 }),
    );
    const dupItem = items.find(
      (i) => i.action.kind === "info_only" && /conflict/i.test(i.label),
    );
    expect(dupItem).toBeDefined();
    expect(dupItem?.description).toContain("12345");
  });
});

describe("makeStatusBarMenu dispatch (T-P2-006)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeHarness(
    sources: StatusBarSources,
    selectedKind: MenuItem["action"]["kind"] | undefined,
  ): {
    handler: () => Promise<void>;
    showInfo: ReturnType<typeof vi.fn>;
    executeCommand: ReturnType<typeof vi.fn>;
    clipboardWriteText: ReturnType<typeof vi.fn>;
    runStart: ReturnType<typeof vi.fn>;
  } {
    const showInfo = vi.fn(() => Promise.resolve(undefined));
    const executeCommand = vi.fn(() => Promise.resolve(undefined));
    const clipboardWriteText = vi.fn(() => Promise.resolve());
    const runStart = vi.fn(() => Promise.resolve());
    const showQuickPick = vi.fn((items: unknown[]) => {
      if (selectedKind === undefined) return Promise.resolve(undefined);
      const arr = items as MenuItem[];
      const sel = arr.find((i) => i.action.kind === selectedKind);
      return Promise.resolve(sel);
    });
    const fakeContext = {
      subscriptions: [],
      secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() },
    } as unknown as vscode.ExtensionContext;
    const handler = makeStatusBarMenu(sources, fakeContext, {
      showQuickPick: showQuickPick as never,
      showInformationMessage: showInfo as never,
      executeCommand: executeCommand as never,
      clipboardWriteText,
      runStartDaemon: runStart as never,
    });
    return { handler, showInfo, executeCommand, clipboardWriteText, runStart };
  }

  it("returns silently on dismissal (no selection)", async () => {
    const { handler, showInfo, executeCommand, runStart } = makeHarness(
      makeSources({}),
      undefined,
    );
    await handler();
    expect(showInfo).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
    expect(runStart).not.toHaveBeenCalled();
  });

  it("start_daemon → calls runStartDaemon", async () => {
    const { handler, runStart } = makeHarness(
      makeSources({ conn: "disconnected" }),
      "start_daemon",
    );
    await handler();
    expect(runStart).toHaveBeenCalledTimes(1);
  });

  it("copy_identifier → writes to clipboard + shows info message", async () => {
    const { handler, clipboardWriteText, showInfo } = makeHarness(
      makeSources({ identifier: "myproject-aaaaaa" }),
      "copy_identifier",
    );
    await handler();
    expect(clipboardWriteText).toHaveBeenCalledWith("myproject-aaaaaa");
    expect(showInfo).toHaveBeenCalledWith(
      expect.stringContaining("myproject-aaaaaa"),
    );
  });

  it("open_daemon_url → executes vscode.open with parsed URI", async () => {
    const { handler, executeCommand } = makeHarness(
      makeSources({
        daemonInfo: { pid: 1, url: "https://x.trycloudflare.com", uptime_s: 0 },
      }),
      "open_daemon_url",
    );
    await handler();
    expect(executeCommand).toHaveBeenCalledWith(
      "vscode.open",
      expect.anything(),
    );
  });

  it("show_status → executes claudeBridge.showStatus command", async () => {
    const { handler, executeCommand } = makeHarness(
      makeSources({}),
      "show_status",
    );
    await handler();
    expect(executeCommand).toHaveBeenCalledWith("claudeBridge.showStatus");
  });

  it("stop_daemon_hint → shows info message; never spawns anything", async () => {
    const { handler, showInfo, runStart } = makeHarness(
      makeSources({}),
      "stop_daemon_hint",
    );
    await handler();
    expect(showInfo).toHaveBeenCalledWith(STOP_HINT_TEXT);
    expect(runStart).not.toHaveBeenCalled();
  });
});

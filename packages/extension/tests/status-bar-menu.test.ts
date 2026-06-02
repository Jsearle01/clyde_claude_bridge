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
  currentMode: ReturnType<StatusBarSources["getCurrentMode"]>;
  binding: { client_id: string; client_name: string } | null;
}>): StatusBarSources {
  const opts = {
    conn: "connected" as const,
    reg: "registered" as const,
    identifier: "myproject-aaaaaa",
    existingPid: null,
    folder: { uri: { fsPath: "/projects/myproject" }, name: "myproject" },
    daemonInfo: undefined as DaemonInfo | undefined,
    currentMode: "per_call" as const,
    binding: null as { client_id: string; client_name: string } | null,
    ...overrides,
  };
  return {
    getConnectionState: () => opts.conn,
    getRegistrationState: () => opts.reg,
    getRegistrationIdentifier: () => opts.identifier,
    getRegistrationExistingPid: () => opts.existingPid,
    getWorkspaceFolder: () => opts.folder,
    getDaemonInfo: () => opts.daemonInfo,
    getCurrentMode: () => opts.currentMode,
    getRetryCount: () => 0,
    getBinding: () => opts.binding,
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
      executeCommand,
      clipboardWriteText,
      runStartDaemon: runStart,
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

describe("composeMenuItems — change_approval_mode (T-P2-008)", () => {
  it("includes Change approval mode when registered + connected", () => {
    const items = composeMenuItems(
      makeSources({ currentMode: "per_call" }),
    );
    const changeMode = items.find(
      (i) => i.action.kind === "change_approval_mode",
    );
    expect(changeMode).toBeDefined();
    expect(changeMode?.description).toContain("per_call");
  });

  it("description reflects current mode", () => {
    const items = composeMenuItems(
      makeSources({ currentMode: "auto" }),
    );
    const changeMode = items.find(
      (i) => i.action.kind === "change_approval_mode",
    );
    expect(changeMode?.description).toContain("auto");
  });

  it("omits Change approval mode when unregistered", () => {
    const items = composeMenuItems(
      makeSources({ reg: "unregistered", identifier: null }),
    );
    const kinds = items.map((i) => i.action.kind);
    expect(kinds).not.toContain("change_approval_mode");
  });

  it("omits Change approval mode when disconnected", () => {
    const items = composeMenuItems(
      makeSources({ conn: "disconnected" }),
    );
    const kinds = items.map((i) => i.action.kind);
    expect(kinds).not.toContain("change_approval_mode");
  });
});

describe("makeStatusBarMenu dispatch — change_approval_mode (T-P2-008)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeChangeModeHarness(opts: {
    currentMode: "auto" | "per_call" | "session_bypass";
    pickResult: { mode: "auto" | "per_call" | "session_bypass" } | undefined;
    applyMode?: ReturnType<typeof vi.fn>;
  }) {
    const showInfo = vi.fn(() => Promise.resolve(undefined));
    const showError = vi.fn(() => Promise.resolve(undefined));
    const executeCommand = vi.fn(() => Promise.resolve(undefined));
    const clipboardWriteText = vi.fn(() => Promise.resolve());
    const runStart = vi.fn(() => Promise.resolve());
    let pickCallCount = 0;
    const showQuickPick = vi.fn((items: unknown[]) => {
      pickCallCount += 1;
      if (pickCallCount === 1) {
        const arr = items as MenuItem[];
        const sel = arr.find((i) => i.action.kind === "change_approval_mode");
        return Promise.resolve(sel);
      }
      // Second call: the mode-selection QuickPick.
      return Promise.resolve(opts.pickResult);
    });
    const applyMode = opts.applyMode ?? vi.fn(() => Promise.resolve());
    const fakeContext = {
      subscriptions: [],
      secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() },
    } as unknown as vscode.ExtensionContext;
    const handler = makeStatusBarMenu(
      makeSources({ currentMode: opts.currentMode }),
      fakeContext,
      {
        showQuickPick: showQuickPick as never,
        showInformationMessage: showInfo as never,
        showErrorMessage: showError as never,
        executeCommand,
        clipboardWriteText,
        runStartDaemon: runStart,
        applyMode,
      },
    );
    return { handler, showInfo, showError, applyMode };
  }

  it("selecting a different mode calls applyMode + shows confirmation", async () => {
    const applyMode = vi.fn(() => Promise.resolve());
    const { handler, showInfo } = makeChangeModeHarness({
      currentMode: "per_call",
      pickResult: { mode: "auto" },
      applyMode,
    });
    await handler();
    expect(applyMode).toHaveBeenCalledWith("myproject-aaaaaa", "auto");
    expect(showInfo).toHaveBeenCalledWith(expect.stringContaining("auto"));
  });

  it("selecting the current mode is a no-op (shows 'already X')", async () => {
    const applyMode = vi.fn(() => Promise.resolve());
    const { handler, showInfo } = makeChangeModeHarness({
      currentMode: "per_call",
      pickResult: { mode: "per_call" },
      applyMode,
    });
    await handler();
    expect(applyMode).not.toHaveBeenCalled();
    expect(showInfo).toHaveBeenCalledWith(expect.stringContaining("already"));
  });

  it("dismissing the secondary QuickPick is silent", async () => {
    const applyMode = vi.fn(() => Promise.resolve());
    const { handler, showInfo, showError } = makeChangeModeHarness({
      currentMode: "per_call",
      pickResult: undefined,
      applyMode,
    });
    await handler();
    expect(applyMode).not.toHaveBeenCalled();
    expect(showInfo).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it("applyMode failure surfaces via showErrorMessage", async () => {
    const applyMode = vi.fn(() => Promise.reject(new Error("daemon refused")));
    const { handler, showError } = makeChangeModeHarness({
      currentMode: "per_call",
      pickResult: { mode: "auto" },
      applyMode,
    });
    await handler();
    expect(showError).toHaveBeenCalledWith(
      expect.stringContaining("daemon refused"),
    );
  });
});

// Re-export TRUST_DENIED_HINT for any downstream test consumers (matches
// the existing pattern of exporting menu text constants).
void TRUST_DENIED_HINT;

describe("T-P3-004b — unbind menu item + dispatch", () => {
  it("shows an Unbind item only when the workspace is bound", () => {
    const bound = composeMenuItems(
      makeSources({ binding: { client_id: "cb_client_abcdef0123", client_name: "Proj" } }),
    );
    expect(bound.map((i) => i.action.kind)).toContain("unbind_workspace");

    const unbound = composeMenuItems(makeSources({ binding: null }));
    expect(unbound.map((i) => i.action.kind)).not.toContain("unbind_workspace");
  });

  it("confirming the modal calls the unbind adapter with the identifier", async () => {
    const unbind = vi.fn(() => Promise.resolve(1));
    const showWarning = vi.fn(() => Promise.resolve("Unbind"));
    const showInfo = vi.fn(() => Promise.resolve(undefined));
    const showQuickPick = vi.fn((items: unknown[]) => {
      const arr = items as MenuItem[];
      return Promise.resolve(arr.find((i) => i.action.kind === "unbind_workspace"));
    });
    const ctx = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const handler = makeStatusBarMenu(
      makeSources({
        identifier: "ws-alpha-1234",
        binding: { client_id: "cb_client_abcdef0123", client_name: "Proj" },
      }),
      ctx,
      {
        showQuickPick: showQuickPick as never,
        showInformationMessage: showInfo as never,
        showWarningMessage: showWarning,
        unbind,
      },
    );
    await handler();
    expect(showWarning).toHaveBeenCalledWith(
      expect.stringContaining("Unbind this workspace"),
      { modal: true },
      "Unbind",
    );
    expect(unbind).toHaveBeenCalledWith("ws-alpha-1234");
    expect(showInfo).toHaveBeenCalled();
  });

  it("cancelling the modal does NOT call the unbind adapter", async () => {
    const unbind = vi.fn(() => Promise.resolve(0));
    const showWarning = vi.fn(() => Promise.resolve(undefined)); // dismissed
    const showQuickPick = vi.fn((items: unknown[]) => {
      const arr = items as MenuItem[];
      return Promise.resolve(arr.find((i) => i.action.kind === "unbind_workspace"));
    });
    const ctx = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const handler = makeStatusBarMenu(
      makeSources({ binding: { client_id: "cb_client_abcdef0123", client_name: "Proj" } }),
      ctx,
      {
        showQuickPick: showQuickPick as never,
        showWarningMessage: showWarning as never,
        unbind,
      },
    );
    await handler();
    expect(unbind).not.toHaveBeenCalled();
  });
});

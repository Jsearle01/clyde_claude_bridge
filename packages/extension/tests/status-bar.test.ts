import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { makeStatusBarItemMock, type WorkspaceFolder } from "./mocks/vscode.js";
import {
  composeStatusBarText,
  composeStatusBarTooltip,
  makeStatusBar,
  type StatusBarSources,
  type DaemonInfo,
} from "../src/status-bar.js";

function makeSources(overrides: Partial<{
  conn: ReturnType<StatusBarSources["getConnectionState"]>;
  reg: ReturnType<StatusBarSources["getRegistrationState"]>;
  identifier: string | null;
  existingPid: number | null;
  folder: WorkspaceFolder | undefined;
  daemonInfo: DaemonInfo | undefined;
  retryCount: number;
}>): StatusBarSources {
  const opts = {
    conn: "connected" as const,
    reg: "registered" as const,
    identifier: "myproject-aaaaaa",
    existingPid: null,
    folder: { uri: { fsPath: "/projects/myproject" }, name: "myproject" },
    daemonInfo: undefined as DaemonInfo | undefined,
    retryCount: 0,
    ...overrides,
  };
  return {
    getConnectionState: () => opts.conn,
    getRegistrationState: () => opts.reg,
    getRegistrationIdentifier: () => opts.identifier,
    getRegistrationExistingPid: () => opts.existingPid,
    getWorkspaceFolder: () => opts.folder,
    getDaemonInfo: () => opts.daemonInfo,
    getCurrentMode: () => "per_call",
    getRetryCount: () => opts.retryCount,
  };
}

describe("composeStatusBarText (T-P2-006)", () => {
  it("connected + registered → $(plug) <identifier>", () => {
    expect(composeStatusBarText("connected", "registered", "x-aaaaaa", null, 0)).toBe(
      "$(plug) x-aaaaaa",
    );
  });

  it("connected + registered + null identifier → falls back to '(no identifier)'", () => {
    expect(composeStatusBarText("connected", "registered", null, null, 0)).toBe(
      "$(plug) (no identifier)",
    );
  });

  it("connected + trust_denied → $(warning) (trust denied)", () => {
    expect(composeStatusBarText("connected", "trust_denied", null, null, 0)).toBe(
      "$(warning) (trust denied)",
    );
  });

  it("connected + duplicate (with pid) → $(warning) (path conflict, pid N)", () => {
    expect(composeStatusBarText("connected", "duplicate", null, 12345, 0)).toBe(
      "$(warning) (path conflict, pid 12345)",
    );
  });

  it("connected + duplicate (null pid) → $(warning) (path conflict)", () => {
    expect(composeStatusBarText("connected", "duplicate", null, null, 0)).toBe(
      "$(warning) (path conflict)",
    );
  });

  it("connected + needs_trust → $(question) (trust pending)", () => {
    expect(composeStatusBarText("connected", "needs_trust", null, null, 0)).toBe(
      "$(question) (trust pending)",
    );
  });

  it("connected + registering or unregistered → $(question) (registering)", () => {
    expect(
      composeStatusBarText("connected", "registering", null, null, 0),
    ).toBe("$(question) (registering)");
    expect(
      composeStatusBarText("connected", "unregistered", null, null, 0),
    ).toBe("$(question) (registering)");
  });

  it("connecting → $(sync~spin) connecting (regardless of registration)", () => {
    expect(
      composeStatusBarText("connecting", "registered", "x-aaaaaa", null, 0),
    ).toBe("$(sync~spin) connecting");
    expect(
      composeStatusBarText("connecting", "unregistered", null, null, 0),
    ).toBe("$(sync~spin) connecting");
  });

  it("disconnected → $(circle-slash) daemon down", () => {
    expect(
      composeStatusBarText("disconnected", "registered", "x-aaaaaa", null, 0),
    ).toBe("$(circle-slash) daemon down");
  });

  it("version_mismatch → $(alert) version mismatch", () => {
    expect(
      composeStatusBarText("version_mismatch", "registered", "x-aaaaaa", null, 0),
    ).toBe("$(alert) version mismatch");
  });

  // T-P2-008.8 (C-29 UX): retry-N indicator during the registering window.
  it("registering + retryCount=1 → '$(sync~spin) connecting (retry 1)'", () => {
    expect(
      composeStatusBarText("disconnected", "registering", null, null, 1),
    ).toBe("$(sync~spin) connecting (retry 1)");
  });

  it("registering + retryCount=7 → '$(sync~spin) connecting (retry 7)'", () => {
    expect(
      composeStatusBarText("connecting", "registering", null, null, 7),
    ).toBe("$(sync~spin) connecting (retry 7)");
  });

  it("registering + retryCount=0 → falls back to base '(registering)' display", () => {
    expect(
      composeStatusBarText("disconnected", "registering", null, null, 0),
    ).toBe("$(circle-slash) daemon down");
    expect(
      composeStatusBarText("connected", "registering", null, null, 0),
    ).toBe("$(question) (registering)");
  });

  it("registered + retryCount=N → returns $(plug) display (retry indicator inactive)", () => {
    expect(
      composeStatusBarText("connected", "registered", "x-aaaaaa", null, 5),
    ).toBe("$(plug) x-aaaaaa");
  });
});

describe("composeStatusBarTooltip (T-P2-006)", () => {
  it("connected + registered: tooltip contains workspace path, identifier, trust, daemon", () => {
    const md = composeStatusBarTooltip(
      makeSources({
        conn: "connected",
        reg: "registered",
        identifier: "myproject-aaaaaa",
        daemonInfo: { pid: 12345, url: "https://x.trycloudflare.com", uptime_s: 60 },
      }),
    );
    expect(md.value).toContain("/projects/myproject");
    expect(md.value).toContain("myproject-aaaaaa");
    expect(md.value).toContain("trusted");
    expect(md.value).toContain("connected (pid 12345)");
    expect(md.value).toContain("https://x.trycloudflare.com");
    expect(md.value).toContain("Click for actions.");
  });

  it("disconnected: tooltip shows 'not running' daemon label; no URL line", () => {
    const md = composeStatusBarTooltip(
      makeSources({ conn: "disconnected", reg: "registered" }),
    );
    expect(md.value).toContain("not running");
    expect(md.value).not.toContain("URL");
  });

  it("duplicate: tooltip surfaces the conflicting window pid", () => {
    const md = composeStatusBarTooltip(
      makeSources({ conn: "connected", reg: "duplicate", existingPid: 99999 }),
    );
    expect(md.value).toContain("path conflict");
    expect(md.value).toContain("99999");
  });

  it("trust_denied: tooltip shows 'denied' trust label", () => {
    const md = composeStatusBarTooltip(
      makeSources({ conn: "connected", reg: "trust_denied", identifier: null }),
    );
    expect(md.value).toContain("denied");
  });

  // T-P2-008.8: tooltip explains the retry indicator when it's showing.
  it("registering + retryCount≥1: tooltip explains the retry indicator", () => {
    const md = composeStatusBarTooltip(
      makeSources({
        conn: "disconnected",
        reg: "registering",
        identifier: null,
        retryCount: 4,
      }),
    );
    expect(md.value).toContain("Retrying");
    expect(md.value).toContain("attempt 4");
    expect(md.value).toContain("automatically");
  });

  it("registering + retryCount=0: tooltip does NOT include the Retrying section", () => {
    const md = composeStatusBarTooltip(
      makeSources({ conn: "disconnected", reg: "registering", retryCount: 0 }),
    );
    expect(md.value).not.toContain("Retrying");
  });
});

describe("makeStatusBar (T-P2-006)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates the item with Right alignment + sets the menu command", () => {
    const itemMock = makeStatusBarItemMock();
    const createSpy = vi.fn(() => itemMock);
    const handle = makeStatusBar(makeSources({}), {
      createStatusBarItem: createSpy as never,
    });
    expect(createSpy).toHaveBeenCalledWith(vscode.StatusBarAlignment.Right, 100);
    expect(itemMock.command).toBe("claudeBridge.openStatusBarMenu");
    handle.dispose();
    expect(itemMock.dispose).toHaveBeenCalled();
  });

  it("refresh() updates item.text from current sources", () => {
    const itemMock = makeStatusBarItemMock();
    const handle = makeStatusBar(
      makeSources({ conn: "disconnected", reg: "registered" }),
      { createStatusBarItem: vi.fn(() => itemMock) as never },
    );
    handle.refresh();
    expect(itemMock.text).toBe("$(circle-slash) daemon down");
    expect(itemMock.show).toHaveBeenCalled();
  });

  it("refresh() hides the item when no workspace folder is open", () => {
    const itemMock = makeStatusBarItemMock();
    const handle = makeStatusBar(
      makeSources({ folder: undefined }),
      { createStatusBarItem: vi.fn(() => itemMock) as never },
    );
    handle.refresh();
    expect(itemMock.hide).toHaveBeenCalled();
    expect(itemMock.show).not.toHaveBeenCalled();
  });
});

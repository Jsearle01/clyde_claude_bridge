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

describe("composeStatusBarText (T-P2-006)", () => {
  it("connected + registered → $(plug) <identifier>", () => {
    expect(composeStatusBarText("connected", "registered", "x-aaaaaa", null)).toBe(
      "$(plug) x-aaaaaa",
    );
  });

  it("connected + registered + null identifier → falls back to '(no identifier)'", () => {
    expect(composeStatusBarText("connected", "registered", null, null)).toBe(
      "$(plug) (no identifier)",
    );
  });

  it("connected + trust_denied → $(warning) (trust denied)", () => {
    expect(composeStatusBarText("connected", "trust_denied", null, null)).toBe(
      "$(warning) (trust denied)",
    );
  });

  it("connected + duplicate (with pid) → $(warning) (path conflict, pid N)", () => {
    expect(composeStatusBarText("connected", "duplicate", null, 12345)).toBe(
      "$(warning) (path conflict, pid 12345)",
    );
  });

  it("connected + duplicate (null pid) → $(warning) (path conflict)", () => {
    expect(composeStatusBarText("connected", "duplicate", null, null)).toBe(
      "$(warning) (path conflict)",
    );
  });

  it("connected + needs_trust → $(question) (trust pending)", () => {
    expect(composeStatusBarText("connected", "needs_trust", null, null)).toBe(
      "$(question) (trust pending)",
    );
  });

  it("connected + registering or unregistered → $(question) (registering)", () => {
    expect(
      composeStatusBarText("connected", "registering", null, null),
    ).toBe("$(question) (registering)");
    expect(
      composeStatusBarText("connected", "unregistered", null, null),
    ).toBe("$(question) (registering)");
  });

  it("connecting → $(sync~spin) connecting (regardless of registration)", () => {
    expect(
      composeStatusBarText("connecting", "registered", "x-aaaaaa", null),
    ).toBe("$(sync~spin) connecting");
    expect(
      composeStatusBarText("connecting", "unregistered", null, null),
    ).toBe("$(sync~spin) connecting");
  });

  it("disconnected → $(circle-slash) daemon down", () => {
    expect(
      composeStatusBarText("disconnected", "registered", "x-aaaaaa", null),
    ).toBe("$(circle-slash) daemon down");
  });

  it("version_mismatch → $(alert) version mismatch", () => {
    expect(
      composeStatusBarText("version_mismatch", "registered", "x-aaaaaa", null),
    ).toBe("$(alert) version mismatch");
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

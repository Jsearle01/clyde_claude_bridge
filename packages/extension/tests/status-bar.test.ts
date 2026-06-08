import { describe, it, expect } from "vitest";
import * as vscode from "vscode";
import { makeStatusBarItemMock } from "./mocks/vscode.js";
import {
  composeStatusBarText,
  daemonSegment,
  claudeSegment,
  makeStatusBar,
  type StatusBarSources,
  type BindingInfo,
} from "../src/status-bar.js";
import type { ConnectionStateKind } from "../src/ipc/client.js";

const FOLDER = {
  uri: { fsPath: "C:\\Projects\\demo" },
  name: "demo",
} as unknown as vscode.WorkspaceFolder;

function sources(over: Partial<StatusBarSources> = {}): StatusBarSources {
  return {
    getConnectionState: () => "disconnected",
    getWorkspaceFolder: () => FOLDER,
    getPairedDaemonName: () => null,
    getDaemonPid: () => null,
    getDiscoveryTotal: () => 0,
    getBinding: () => null,
    ...over,
  };
}

describe("daemonSegment (P3'-3, AC-3-1/3-2)", () => {
  it("connected → '<name> (pid <pid>) · live'", () => {
    const s = daemonSegment(
      sources({
        getConnectionState: () => "connected",
        getPairedDaemonName: () => "clyde-dev",
        getDaemonPid: () => 12016,
      }),
    );
    expect(s).toContain("clyde-dev");
    expect(s).toContain("pid 12016");
    expect(s).toContain("live");
  });

  it("connecting → spinner connecting", () => {
    expect(
      daemonSegment(sources({ getConnectionState: () => "connecting" })),
    ).toContain("connecting");
  });

  it("version_mismatch → version mismatch", () => {
    expect(
      daemonSegment(sources({ getConnectionState: () => "version_mismatch" })),
    ).toContain("version mismatch");
  });

  it("AC-3-4: disconnected + NO adverts (total 0) → 'not running — start from command palette'", () => {
    const s = daemonSegment(
      sources({ getConnectionState: () => "disconnected", getDiscoveryTotal: () => 0 }),
    );
    expect(s).toContain("not running");
    expect(s).toContain("command palette");
  });

  it("AC-3-4 near-miss: disconnected + adverts present (total>0) → 'found but workspace mismatch'", () => {
    const s = daemonSegment(
      sources({ getConnectionState: () => "disconnected", getDiscoveryTotal: () => 2 }),
    );
    expect(s).toContain("workspace mismatch");
    expect(s).not.toContain("not running");
  });

  it("AC-3-2: no 'stale' or 'waiting' state exists in any rendering", () => {
    const conns: ConnectionStateKind[] = [
      "connected",
      "connecting",
      "disconnected",
      "version_mismatch",
    ];
    for (const conn of conns) {
      for (const total of [0, 3]) {
        const s = daemonSegment(
          sources({
            getConnectionState: () => conn,
            getDiscoveryTotal: () => total,
            getPairedDaemonName: () => "d",
            getDaemonPid: () => 1,
          }),
        );
        expect(s.toLowerCase()).not.toContain("stale");
        expect(s.toLowerCase()).not.toContain("waiting");
      }
    }
  });
});

describe("claudeSegment (P3'-3, AC-3-1 scope c)", () => {
  it("bound → shows the binding", () => {
    const binding: BindingInfo = { client_id: "abc12345", client_name: "Claude" };
    expect(claudeSegment(sources({ getBinding: () => binding }))).toContain("bound");
  });
  it("not bound → 'claude.ai: not bound'", () => {
    expect(claudeSegment(sources())).toContain("not bound");
  });
});

describe("composeStatusBarText — two segments (P3'-3, AC-3-1)", () => {
  it("renders [daemon] <arrow> [claude.ai] — both connections visibly distinct", () => {
    const text = composeStatusBarText(
      sources({
        getConnectionState: () => "connected",
        getPairedDaemonName: () => "clyde-dev",
        getDaemonPid: () => 7,
      }),
    );
    expect(text).toContain("clyde-dev");
    expect(text).toContain("claude.ai");
    expect(text).toContain("$(arrow-both)"); // the <--> separator
  });
});

describe("makeStatusBar (P3'-3)", () => {
  it("refresh() sets the two-segment text + 'click for commands' tooltip", () => {
    const item = makeStatusBarItemMock();
    const bar = makeStatusBar(
      sources({
        getConnectionState: () => "connected",
        getPairedDaemonName: () => "d",
        getDaemonPid: () => 1,
      }),
      { createStatusBarItem: () => item },
    );
    bar.refresh();
    expect(item.text).toContain("· live");
    expect(item.text).toContain("claude.ai");
    expect(item.tooltip as string).toContain("click for commands");
    expect(item.show).toHaveBeenCalled();
  });

  it("hides when no workspace folder is open", () => {
    const item = makeStatusBarItemMock();
    const bar = makeStatusBar(sources({ getWorkspaceFolder: () => undefined }), {
      createStatusBarItem: () => item,
    });
    bar.refresh();
    expect(item.hide).toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  composeMenuItems,
  makeStatusBarMenu,
  type MenuSources,
  type MenuItem,
} from "../src/status-bar-menu.js";
import type { BindingInfo } from "../src/status-bar.js";

function sources(over: Partial<MenuSources> = {}): MenuSources {
  return {
    getRegistrationIdentifier: () => "demo-aaaaaa",
    getBinding: () => null,
    ...over,
  };
}

const BINDING: BindingInfo = {
  client_id: "abc12345",
  client_name: "Claude",
  granularity: "per_call",
};

describe("composeMenuItems (P3'-3, AC-3-3/3-4) — Start daemon + Unbind only", () => {
  it("always offers Start daemon (the spawn affordance)", () => {
    const items = composeMenuItems(sources());
    expect(items.map((i) => i.action.kind)).toContain("start_daemon");
  });

  it("offers Unbind ONLY when bound", () => {
    const notBound = composeMenuItems(sources({ getBinding: () => null }));
    expect(notBound.map((i) => i.action.kind)).not.toContain("unbind_workspace");
    const bound = composeMenuItems(sources({ getBinding: () => BINDING }));
    expect(bound.map((i) => i.action.kind)).toContain("unbind_workspace");
  });

  it("P3'-5: when-bound menu = Start + Stop + Set approval mode + Unbind; OLD obsolete options stay gone", () => {
    const kinds = composeMenuItems(sources({ getBinding: () => BINDING })).map(
      (i: MenuItem) => i.action.kind,
    );
    expect(kinds).toEqual([
      "start_daemon",
      "stop_daemon",
      "set_granularity",
      "unbind_workspace",
    ]);
    // The OLD stripped options stay gone (set_granularity is the binding-default
    // ceiling, NOT the old per-workspace "change_approval_mode").
    expect(kinds).not.toContain("change_approval_mode");
    expect(kinds).not.toContain("copy_identifier");
  });

  it("AC-5-1: Stop daemon is ALWAYS shown (bound or not)", () => {
    expect(
      composeMenuItems(sources({ getBinding: () => null })).map((i) => i.action.kind),
    ).toContain("stop_daemon");
    expect(
      composeMenuItems(sources({ getBinding: () => BINDING })).map((i) => i.action.kind),
    ).toContain("stop_daemon");
  });

  it("AC-5-3: Set approval mode appears ONLY when bound, with the current value shown", () => {
    expect(
      composeMenuItems(sources({ getBinding: () => null })).map((i) => i.action.kind),
    ).not.toContain("set_granularity");
    const bound = composeMenuItems(
      sources({ getBinding: () => ({ ...BINDING, granularity: "task" }) }),
    );
    const item = bound.find((i) => i.action.kind === "set_granularity");
    expect(item).toBeDefined();
    expect(item?.description).toContain("task"); // current value surfaced
  });

  it("no Unbind when bound but identifier is null", () => {
    const items = composeMenuItems(
      sources({ getBinding: () => BINDING, getRegistrationIdentifier: () => null }),
    );
    expect(items.map((i) => i.action.kind)).not.toContain("unbind_workspace");
  });
});

describe("makeStatusBarMenu dispatch (P3'-3)", () => {
  const ctx = { secrets: {} } as never;

  it("start_daemon → runs the spawn command", async () => {
    const runStart = vi.fn(() => Promise.resolve());
    const handler = makeStatusBarMenu(sources(), ctx, {
      runStartDaemon: runStart,
      showQuickPick: vi.fn(() =>
        Promise.resolve({ action: { kind: "start_daemon" } }),
      ) as never,
    });
    await handler();
    expect(runStart).toHaveBeenCalledTimes(1);
  });

  it("unbind → confirms (modal) then calls unbind + info toast", async () => {
    const unbind = vi.fn(() => Promise.resolve(2));
    const showWarning = vi.fn(() => Promise.resolve("Unbind"));
    const showInfo = vi.fn(() => Promise.resolve(undefined));
    const handler = makeStatusBarMenu(sources({ getBinding: () => BINDING }), ctx, {
      unbind,
      showWarningMessage: showWarning,
      showInformationMessage: showInfo as never,
      showQuickPick: vi.fn(() =>
        Promise.resolve({
          action: {
            kind: "unbind_workspace",
            identifier: "demo-aaaaaa",
            client_label: "Claude",
          },
        }),
      ) as never,
    });
    await handler();
    expect(showWarning).toHaveBeenCalledTimes(1); // modal confirm
    expect(unbind).toHaveBeenCalledWith("demo-aaaaaa");
    expect(showInfo).toHaveBeenCalledTimes(1);
  });

  it("unbind cancelled (modal dismissed) → does NOT call unbind", async () => {
    const unbind = vi.fn(() => Promise.resolve(0));
    const handler = makeStatusBarMenu(sources({ getBinding: () => BINDING }), ctx, {
      unbind,
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)) as never, // dismissed
      showQuickPick: vi.fn(() =>
        Promise.resolve({
          action: {
            kind: "unbind_workspace",
            identifier: "demo-aaaaaa",
            client_label: "Claude",
          },
        }),
      ) as never,
    });
    await handler();
    expect(unbind).not.toHaveBeenCalled();
  });

  it("nothing selected (menu dismissed) → no-op", async () => {
    const runStart = vi.fn(() => Promise.resolve());
    const handler = makeStatusBarMenu(sources(), ctx, {
      runStartDaemon: runStart,
      showQuickPick: vi.fn(() => Promise.resolve(undefined)) as never,
    });
    await handler();
    expect(runStart).not.toHaveBeenCalled();
  });

  it("AC-5-1/5-2: stop_daemon → confirms (modal) then stops", async () => {
    const stop = vi.fn(() => Promise.resolve());
    const showWarning = vi.fn(() => Promise.resolve("Stop"));
    const handler = makeStatusBarMenu(sources(), ctx, {
      stop,
      showWarningMessage: showWarning,
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)) as never,
      showQuickPick: vi.fn(() =>
        Promise.resolve({ action: { kind: "stop_daemon" } }),
      ) as never,
    });
    await handler();
    expect(showWarning).toHaveBeenCalledTimes(1); // modal confirm (live disruption)
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("AC-5-2: stop cancelled (modal dismissed) → does NOT stop", async () => {
    const stop = vi.fn(() => Promise.resolve());
    const handler = makeStatusBarMenu(sources(), ctx, {
      stop,
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)) as never, // dismissed
      showQuickPick: vi.fn(() =>
        Promise.resolve({ action: { kind: "stop_daemon" } }),
      ) as never,
    });
    await handler();
    expect(stop).not.toHaveBeenCalled();
  });

  it("AC-5-3: set approval mode → QuickPick → setGranularity(identifier, picked)", async () => {
    const setGranularity = vi.fn(() => Promise.resolve(1));
    const showQuickPick = vi
      .fn()
      .mockResolvedValueOnce({
        action: { kind: "set_granularity", identifier: "demo-aaaaaa", current: "per_call" },
      })
      .mockResolvedValueOnce({ value: "task" });
    const handler = makeStatusBarMenu(sources({ getBinding: () => BINDING }), ctx, {
      setGranularity,
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)) as never,
      showQuickPick: showQuickPick as never,
    });
    await handler();
    expect(setGranularity).toHaveBeenCalledWith("demo-aaaaaa", "task");
  });

  it("AC-5-3: set approval mode cancelled (pick dismissed) → does NOT set", async () => {
    const setGranularity = vi.fn(() => Promise.resolve(1));
    const showQuickPick = vi
      .fn()
      .mockResolvedValueOnce({
        action: { kind: "set_granularity", identifier: "demo-aaaaaa", current: "per_call" },
      })
      .mockResolvedValueOnce(undefined); // pick dismissed
    const handler = makeStatusBarMenu(sources({ getBinding: () => BINDING }), ctx, {
      setGranularity,
      showQuickPick: showQuickPick as never,
    });
    await handler();
    expect(setGranularity).not.toHaveBeenCalled();
  });
});

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

const BINDING: BindingInfo = { client_id: "abc12345", client_name: "Claude" };

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

  it("AC-3-3: no obsolete options (mode / trust / retry / open-url / copy-id / re-scan)", () => {
    const kinds = composeMenuItems(sources({ getBinding: () => BINDING })).map(
      (i: MenuItem) => i.action.kind,
    );
    expect(kinds).toEqual(["start_daemon", "unbind_workspace"]);
    expect(kinds).not.toContain("change_approval_mode");
    expect(kinds).not.toContain("copy_identifier");
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
});

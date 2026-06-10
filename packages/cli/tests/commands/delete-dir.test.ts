// T-CLI-2: delete-dir safety stack — typed-name-no-number, live-target typed
// confirm → graceful-stop-then-delete, cancel touches nothing.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteDirCommand,
  DeleteDirNameRequiredError,
  DeleteDirNameNotFoundError,
} from "../../src/commands/delete-dir.js";

const HASH_A = "aaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbb";

describe("deleteDirCommand (T-CLI-2 safety stack)", () => {
  let root: string;
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cb-deldir-"));
    spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(async () => {
    spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  });

  async function makeDir(hash: string, name: string, ws: string): Promise<string> {
    const dir = join(root, hash);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "workspaces.json"),
      JSON.stringify({
        version: "1",
        workspaces: [{ abs_path: ws, identifier: name, name, trusted_at: "x" }],
      }),
    );
    return dir;
  }
  function captured(): string {
    return spy.mock.calls.map((c) => c[0] as string).join("");
  }
  const dead = (): Promise<boolean> => Promise.resolve(false);
  const live = (): Promise<boolean> => Promise.resolve(true);

  it("AC-C2-2: bare (no --name) LISTS + requires a typed name, NEVER deletes, no number", async () => {
    await makeDir(HASH_A, "alpha", "c:\\ws\\a");
    const removeDir = vi.fn(() => Promise.resolve());
    await expect(
      deleteDirCommand({ configRoot: root, probe: dead, removeDir }),
    ).rejects.toBeInstanceOf(DeleteDirNameRequiredError);
    expect(removeDir).not.toHaveBeenCalled(); // never deletes bare
    const out = captured();
    expect(out).toContain("alpha"); // listed (name + workspace)
    expect(out).toContain("c:\\ws\\a");
    expect(out).not.toMatch(/^\s*\d+[).]/m); // no numbered pick
  });

  it("AC-C2-3: --name against a DEAD dir → deletes it (the typed name is the act)", async () => {
    const dir = await makeDir(HASH_A, "alpha", "c:\\ws\\a");
    const removeDir = vi.fn(() => Promise.resolve());
    await deleteDirCommand({
      configRoot: root,
      name: "alpha",
      probe: dead,
      removeDir,
    });
    expect(removeDir).toHaveBeenCalledWith(dir);
  });

  it("AC-C2-4: LIVE target → typed 'confirm' → graceful STOP **then** delete (ordered, no yank)", async () => {
    await makeDir(HASH_A, "alpha", "c:\\ws\\a");
    const order: string[] = [];
    const gracefulStop = vi.fn(() => {
      order.push("stop");
      return Promise.resolve();
    });
    const removeDir = vi.fn(() => {
      order.push("delete");
      return Promise.resolve();
    });
    await deleteDirCommand({
      configRoot: root,
      name: "alpha",
      probe: live,
      readConfirm: () => Promise.resolve("confirm"),
      gracefulStop,
      removeDir,
    });
    expect(order).toEqual(["stop", "delete"]); // stop BEFORE delete
  });

  it("AC-C2-4: LIVE target → typed 'cancel' → touches NOTHING", async () => {
    await makeDir(HASH_A, "alpha", "c:\\ws\\a");
    const gracefulStop = vi.fn(() => Promise.resolve());
    const removeDir = vi.fn(() => Promise.resolve());
    await deleteDirCommand({
      configRoot: root,
      name: "alpha",
      probe: live,
      readConfirm: () => Promise.resolve("cancel"),
      gracefulStop,
      removeDir,
    });
    expect(gracefulStop).not.toHaveBeenCalled();
    expect(removeDir).not.toHaveBeenCalled();
    expect(captured()).toContain("Cancelled");
  });

  it("--name not found → error, lists, deletes nothing", async () => {
    await makeDir(HASH_A, "alpha", "c:\\ws\\a");
    const removeDir = vi.fn(() => Promise.resolve());
    await expect(
      deleteDirCommand({ configRoot: root, name: "ghost", probe: dead, removeDir }),
    ).rejects.toBeInstanceOf(DeleteDirNameNotFoundError);
    expect(removeDir).not.toHaveBeenCalled();
  });

  it("AC-C2-5: always-name — bare with MANY dirs still lists + requires name (never acts-on-sole/all)", async () => {
    await makeDir(HASH_A, "alpha", "c:\\ws\\a");
    await makeDir(HASH_B, "beta", "c:\\ws\\b");
    const removeDir = vi.fn(() => Promise.resolve());
    await expect(
      deleteDirCommand({ configRoot: root, probe: dead, removeDir }),
    ).rejects.toBeInstanceOf(DeleteDirNameRequiredError);
    expect(removeDir).not.toHaveBeenCalled();
  });
});

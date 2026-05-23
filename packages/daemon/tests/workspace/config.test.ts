import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceConfig } from "@claude-bridge/shared";
import {
  validateWorkspaceConfig,
  WorkspaceConfigError,
} from "../../src/workspace/config.js";

function makeCfg(abs_path: string): WorkspaceConfig {
  return { id: "test#ws", abs_path, default_mode: "agentic" };
}

// Probe whether the OS lets us create symlinks at all. Windows without
// developer-mode-or-admin returns EPERM; we skip the symlink-specific
// cases in that environment.
function canCreateSymlinks(): boolean {
  const probeDir = mkdtempSync(join(tmpdir(), "cb-ws-symprobe-"));
  const target = join(probeDir, "real");
  const link = join(probeDir, "link");
  writeFileSync(target, "");
  try {
    symlinkSync(target, link, "file");
    rmSync(probeDir, { recursive: true, force: true });
    return true;
  } catch {
    rmSync(probeDir, { recursive: true, force: true });
    return false;
  }
}

const SYMLINKS_OK = canCreateSymlinks();

describe("validateWorkspaceConfig — accept cases", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-ws-accept-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a valid absolute path to an existing directory", () => {
    expect(() => validateWorkspaceConfig(makeCfg(dir))).not.toThrow();
  });

  it.skipIf(!SYMLINKS_OK)(
    "accepts a path that resolves through a symlink",
    () => {
      const real = mkdtempSync(join(tmpdir(), "cb-ws-symreal-"));
      const link = join(tmpdir(), `cb-ws-symlink-${Date.now()}`);
      symlinkSync(real, link, "dir");
      try {
        expect(() => validateWorkspaceConfig(makeCfg(link))).not.toThrow();
      } finally {
        rmSync(link, { force: true });
        rmSync(real, { recursive: true, force: true });
      }
    },
  );
});

describe("validateWorkspaceConfig — reject cases", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-ws-reject-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a relative path (./foo)", () => {
    try {
      validateWorkspaceConfig(makeCfg("./foo"));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceConfigError);
      expect((err as Error).message).toMatch(/must be absolute/i);
    }
  });

  it("rejects a tilde-prefixed path (~/projects/x)", () => {
    try {
      validateWorkspaceConfig(makeCfg("~/projects/x"));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceConfigError);
      expect((err as Error).message).toMatch(/must be absolute/i);
    }
  });

  it("rejects a non-existent absolute path", () => {
    const ghost = join(dir, "does-not-exist");
    try {
      validateWorkspaceConfig(makeCfg(ghost));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceConfigError);
      expect((err as Error).message).toMatch(/does not exist/i);
    }
  });

  it("rejects a path that points to a regular file", () => {
    const file = join(dir, "regular.txt");
    writeFileSync(file, "");
    try {
      validateWorkspaceConfig(makeCfg(file));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceConfigError);
      expect((err as Error).message).toMatch(/is not a directory/i);
    }
  });

  it.skipIf(!SYMLINKS_OK)(
    "rejects a dangling symlink (target missing)",
    () => {
      const link = join(dir, "dangling-link");
      const phantomTarget = join(dir, "phantom-target");
      symlinkSync(phantomTarget, link, "dir");
      try {
        validateWorkspaceConfig(makeCfg(link));
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceConfigError);
        // Dangling symlink can fail at stat (ENOENT) or at realpath; either
        // is acceptable — both produce a clear error mentioning the path.
        expect((err as Error).message).toContain(link);
      }
    },
  );
});

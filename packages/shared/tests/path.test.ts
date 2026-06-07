import { describe, it, expect, afterEach } from "vitest";
import {
  normalizeAbsPath,
  canonicalizeWorkspacePath,
  workspaceIdentityKey,
} from "../src/path.js";

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, "platform", {
    value: ORIGINAL_PLATFORM,
    configurable: true,
  });
});

describe("normalizeAbsPath (T-P2-007.5)", () => {
  it("returns identity on Unix (linux)", () => {
    setPlatform("linux");
    expect(normalizeAbsPath("/Foo/Bar")).toBe("/Foo/Bar");
    expect(normalizeAbsPath("/foo/bar")).toBe("/foo/bar");
  });

  it("returns identity on Unix (darwin)", () => {
    setPlatform("darwin");
    expect(normalizeAbsPath("/Users/Name/Project")).toBe(
      "/Users/Name/Project",
    );
  });

  it("returns lowercase on Windows", () => {
    setPlatform("win32");
    expect(normalizeAbsPath("C:\\Projects\\Clyde")).toBe(
      "c:\\projects\\clyde",
    );
    expect(normalizeAbsPath("c:\\projects\\clyde")).toBe(
      "c:\\projects\\clyde",
    );
  });

  it("is idempotent on Windows and Unix", () => {
    setPlatform("win32");
    const w = "C:\\X\\Y";
    expect(normalizeAbsPath(normalizeAbsPath(w))).toBe(normalizeAbsPath(w));
    setPlatform("linux");
    const u = "/X/Y";
    expect(normalizeAbsPath(normalizeAbsPath(u))).toBe(normalizeAbsPath(u));
  });

  it("handles UNC-style paths on Windows (full-string lowercase)", () => {
    setPlatform("win32");
    expect(normalizeAbsPath("\\\\Server\\Share\\Path")).toBe(
      "\\\\server\\share\\path",
    );
  });

  it("UNC-style paths on Unix return identity", () => {
    setPlatform("linux");
    expect(normalizeAbsPath("\\\\Server\\Share\\Path")).toBe(
      "\\\\Server\\Share\\Path",
    );
  });

  // P3'-1a: platform is now injectable (default = process.platform). The
  // injected arg overrides the host so the identity composition is testable
  // on any CI host. Behavior-preserving for the existing single-arg callers.
  describe("injected platform arg (P3'-1a)", () => {
    it("win32 arg lowercases regardless of host", () => {
      setPlatform("linux"); // host says linux...
      expect(normalizeAbsPath("C:\\Projects\\X", "win32")).toBe(
        "c:\\projects\\x", // ...but the injected win32 arg wins
      );
    });
    it("posix arg returns identity regardless of host", () => {
      setPlatform("win32"); // host says win32...
      expect(normalizeAbsPath("/Projects/X", "linux")).toBe("/Projects/X");
    });
    it("default arg still follows process.platform (behavior-preserving)", () => {
      setPlatform("win32");
      expect(normalizeAbsPath("C:\\X")).toBe("c:\\x");
      setPlatform("linux");
      expect(normalizeAbsPath("/X/Y")).toBe("/X/Y");
    });
  });
});

describe("workspaceIdentityKey (P3'-1b)", () => {
  // The single identity-composition both daemon + CLI key on:
  // normalizeAbsPath(canonicalizeWorkspacePath(input)). Platform-injected, so
  // independent of the host (these run on any CI host).
  it("win32: equivalent forms → the same case-folded key", () => {
    const expected = "c:\\projects\\clyde_claude_bridge";
    for (const form of [
      "C:\\Projects\\clyde_claude_bridge",
      "c:/projects/clyde_claude_bridge/",
      "C:\\PROJECTS\\CLYDE_CLAUDE_BRIDGE",
    ]) {
      expect(workspaceIdentityKey(form, "win32")).toBe(expected);
    }
  });
  it("posix: case-preserving (case-sensitive FS)", () => {
    expect(workspaceIdentityKey("/home/jay/Projects/x", "linux")).toBe(
      "/home/jay/Projects/x",
    );
  });
});

describe("canonicalizeWorkspacePath (T-P3'-0)", () => {
  // LIVE-CAPTURED ground truth — NOT a hand-written guess.
  // Captured 2026-06-07 from a real VS Code window (engine ^1.85) opened on
  // the folder "C:\Projects\clyde_claude_bridge" via the
  // "Claude Bridge: Probe Workspace Path" command:
  //   workspaceFolders[0].uri.fsPath = "c:\Projects\clyde_claude_bridge"
  // (path = "/c:/Projects/clyde_claude_bridge",
  //  toString = "file:///c%3A/Projects/clyde_claude_bridge")
  // See docs/recon/P3PRIME-0-path-normalization.md.
  const CAPTURED_FSPATH = "c:\\Projects\\clyde_claude_bridge";

  // AC-P3'-0c/0d: every equivalent input variant of the SAME folder
  // canonicalizes to the captured fsPath byte-for-byte. Variants differ only
  // in what VS Code legitimately normalizes — drive-letter case, separator
  // style, trailing/duplicate separators — while keeping the real segment
  // casing ("Projects"), which fsPath preserves.
  const equivalentVariants: Array<[string, string]> = [
    ["raw operator-typed form", "C:\\Projects\\clyde_claude_bridge"],
    ["forward-slash form", "C:/Projects/clyde_claude_bridge"],
    ["uppercase drive", "C:\\Projects\\clyde_claude_bridge"],
    ["already-lowercase drive", "c:\\Projects\\clyde_claude_bridge"],
    ["trailing backslash", "C:\\Projects\\clyde_claude_bridge\\"],
    ["trailing forward slash", "C:/Projects/clyde_claude_bridge/"],
    ["duplicate separators", "C:\\\\Projects\\\\clyde_claude_bridge"],
    [
      "mixed separators, mixed-case drive",
      "c:\\Projects/clyde_claude_bridge",
    ],
  ];

  for (const [label, variant] of equivalentVariants) {
    it(`win32: ${label} -> captured fsPath byte-for-byte`, () => {
      expect(canonicalizeWorkspacePath(variant, "win32")).toBe(CAPTURED_FSPATH);
    });
  }

  // GROUND-TRUTH GUARD: fsPath PRESERVES segment case (captured "Projects"
  // stayed capital-P). Canonicalization must therefore NOT fold segment case
  // — a case-different segment is a genuinely different folder identity here.
  // Case-insensitive matching is normalizeAbsPath's job (lookup key, Phase 2b),
  // deliberately not this function's.
  it("win32: does NOT fold path-segment case (only the drive letter)", () => {
    expect(canonicalizeWorkspacePath("c:\\projects\\clyde_claude_bridge", "win32")).toBe(
      "c:\\projects\\clyde_claude_bridge",
    );
    expect(
      canonicalizeWorkspacePath("c:\\projects\\clyde_claude_bridge", "win32"),
    ).not.toBe(CAPTURED_FSPATH);
  });

  it("win32: keeps a bare drive root as 'x:\\'", () => {
    expect(canonicalizeWorkspacePath("C:\\", "win32")).toBe("c:\\");
    expect(canonicalizeWorkspacePath("C:/", "win32")).toBe("c:\\");
    expect(canonicalizeWorkspacePath("c:", "win32")).toBe("c:\\");
  });

  // UNC arm is a hypothesis — NOT exercised by the live capture (drive path
  // only). Documents current behavior; flagged LIVE-UNCONFIRMED in the recon
  // note. The drive letter is lowercased only when present, so a UNC host is
  // left untouched.
  it("win32: UNC prefix preserved, no drive-letter folding (LIVE-UNCONFIRMED)", () => {
    expect(canonicalizeWorkspacePath("\\\\Server\\Share\\Proj", "win32")).toBe(
      "\\\\Server\\Share\\Proj",
    );
    expect(canonicalizeWorkspacePath("//Server/Share/Proj/", "win32")).toBe(
      "\\\\Server\\Share\\Proj",
    );
  });

  // posix arm: construction + mocked-platform coverage only. No Linux host
  // this spike — LIVE-UNCONFIRMED; the real closer is the P4 cross-platform-CI
  // item. Platform is injected, so no process.platform mutation is needed.
  describe("posix (DERIVED, LIVE-UNCONFIRMED)", () => {
    it("forward slashes, case-preserving, no drive letter", () => {
      expect(
        canonicalizeWorkspacePath("/home/jay/Projects/clyde", "posix"),
      ).toBe("/home/jay/Projects/clyde");
    });
    it("collapses duplicate separators", () => {
      expect(
        canonicalizeWorkspacePath("/home//jay///Projects/clyde", "posix"),
      ).toBe("/home/jay/Projects/clyde");
    });
    it("strips a trailing slash but preserves the filesystem root '/'", () => {
      expect(canonicalizeWorkspacePath("/home/jay/clyde/", "posix")).toBe(
        "/home/jay/clyde",
      );
      expect(canonicalizeWorkspacePath("/", "posix")).toBe("/");
    });
    it("leaves backslashes intact (ordinary chars on posix, not separators)", () => {
      expect(canonicalizeWorkspacePath("/home/jay/a\\b", "posix")).toBe(
        "/home/jay/a\\b",
      );
    });
  });

  // Both branches assert from the SAME call site with platform injected —
  // mirrors the candidatesFor(platform) dual-branch pattern (CB-LINUX-LAUNCH-TESTS).
  it("selects the branch from the injected platform arg, not the host", () => {
    expect(canonicalizeWorkspacePath("C:/Projects/clyde_claude_bridge", "win32")).toBe(
      "c:\\Projects\\clyde_claude_bridge",
    );
    expect(canonicalizeWorkspacePath("/Projects/clyde_claude_bridge", "posix")).toBe(
      "/Projects/clyde_claude_bridge",
    );
  });
});

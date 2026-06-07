import { describe, it, expect } from "vitest";
import { computeDaemonIdentity } from "../../src/workspace/identity.js";

describe("computeDaemonIdentity (P3'-1a)", () => {
  // AC-1a-3 / AC-1a-4: the exact composition wired —
  // identity = normalizeAbsPath(canonicalizeWorkspacePath(input)) (case-folded
  // key); display_path = canonicalizeWorkspacePath(input) (case-preserving);
  // name = the operator label, passed through verbatim.
  it("win32: composes case-folded identity + case-preserving display + name", () => {
    const id = computeDaemonIdentity(
      "C:\\Projects\\clyde_claude_bridge",
      "clyde-dev",
      "win32",
    );
    expect(id).toEqual({
      identity: "c:\\projects\\clyde_claude_bridge", // case-FOLDED key
      display_path: "c:\\Projects\\clyde_claude_bridge", // case-PRESERVING
      name: "clyde-dev",
    });
  });

  // AC-1a-7 — THE HEADLINE PROOF (the Phase 2b case-folded-key contract,
  // proven early): every case / separator / trailing-slash variant of the
  // SAME folder, passed as --workspace, produces the SAME identity.
  describe("AC-1a-7: identity stability across equivalent --workspace forms", () => {
    const EXPECTED_IDENTITY = "c:\\projects\\clyde_claude_bridge";
    const variants: Array<[string, string]> = [
      ["raw operator-typed form", "C:\\Projects\\clyde_claude_bridge"],
      ["uppercase drive", "C:\\Projects\\clyde_claude_bridge"],
      ["forward slashes", "C:/Projects/clyde_claude_bridge"],
      ["trailing backslash", "C:\\Projects\\clyde_claude_bridge\\"],
      ["trailing forward slash", "C:/Projects/clyde_claude_bridge/"],
      ["ALL-CAPS path segments", "C:\\PROJECTS\\CLYDE_CLAUDE_BRIDGE"],
      ["all-lowercase", "c:\\projects\\clyde_claude_bridge"],
      ["mixed case + mixed sep + trailing", "c:\\Projects/CLYDE_claude_bridge/"],
      ["duplicate separators", "C:\\\\Projects\\\\clyde_claude_bridge"],
    ];
    for (const [label, variant] of variants) {
      it(`${label} -> ${EXPECTED_IDENTITY}`, () => {
        expect(computeDaemonIdentity(variant, "n", "win32").identity).toBe(
          EXPECTED_IDENTITY,
        );
      });
    }
  });

  // posix arm (DERIVED, LIVE-UNCONFIRMED per T-P3'-0): case-PRESERVING all the
  // way through — no drive letter, no case folding. Variants that differ only
  // in case are DISTINCT identities on posix (the FS is case-sensitive).
  describe("posix (LIVE-UNCONFIRMED)", () => {
    it("preserves case in both identity and display (no folding)", () => {
      const id = computeDaemonIdentity("/home/jay/Projects/clyde", "clyde", "posix");
      expect(id).toEqual({
        identity: "/home/jay/Projects/clyde",
        display_path: "/home/jay/Projects/clyde",
        name: "clyde",
      });
    });
    it("normalizes separators + trailing slash but NOT case", () => {
      expect(
        computeDaemonIdentity("/home/jay//Projects/clyde/", "n", "posix").identity,
      ).toBe("/home/jay/Projects/clyde");
      // case difference => different identity on posix (case-sensitive FS)
      expect(
        computeDaemonIdentity("/home/jay/projects/clyde", "n", "posix").identity,
      ).not.toBe("/home/jay/Projects/clyde");
    });
  });

  it("selects the branch from the injected platform, not the host", () => {
    expect(
      computeDaemonIdentity("C:/Projects/X", "n", "win32").identity,
    ).toBe("c:\\projects\\x");
    expect(computeDaemonIdentity("/Projects/X", "n", "posix").identity).toBe(
      "/Projects/X",
    );
  });
});

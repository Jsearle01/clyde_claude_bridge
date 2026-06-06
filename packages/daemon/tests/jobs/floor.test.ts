// T-P3-006: the always-gate hard-deny floor. Tests each §2 floor item (denied)
// and each §3 authorization-governed op (NOT floored — must not over-block),
// plus adversarial evasions with honest coverage notes.

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve, sep } from "node:path";
import {
  checkToolFloor,
  checkBashFloor,
  checkWritePathFloor,
} from "../../src/jobs/floor.js";
import { getConfigDir } from "../../src/config/paths.js";

// A real, platform-correct absolute workspace root, disjoint from the config
// dir (~/.claude-bridge), so isUnder() checks are deterministic cross-platform.
const WS = pathResolve(tmpdir(), "cb-floor-ws");
const CFG = getConfigDir();
const OUTSIDE = pathResolve(WS, "..", "elsewhere");

function bash(cmd: string) {
  return checkToolFloor("Bash", { command: cmd }, WS, CFG);
}
function write(path: string) {
  return checkToolFloor("Write", { file_path: path }, WS, CFG);
}

describe("floor §2 — hard-denied (un-overridable by any dispatch)", () => {
  it("§2.1 force-push: --force / -f / --force-with-lease / +refspec", () => {
    expect(bash("git push --force origin main").denied).toBe(true);
    expect(bash("git push -f origin main").denied).toBe(true);
    expect(bash("git push --force-with-lease").denied).toBe(true);
    expect(bash("git push origin +main").denied).toBe(true);
  });

  it("§2.2 history-destroying: filter-branch / filter-repo", () => {
    expect(bash("git filter-branch --tree-filter 'rm x' HEAD").denied).toBe(true);
    expect(bash("git filter-repo --path secret --invert-paths").denied).toBe(true);
  });

  it("§2.3 rm -rf of a path OUTSIDE the workspace", () => {
    expect(bash(`rm -rf ${OUTSIDE}`).denied).toBe(true);
    expect(bash("rm -rf ../other").denied).toBe(true);
    expect(bash("rm -rf /usr/local/x").denied).toBe(true);
  });

  it("§2.4 rm -rf of a .git directory (relative + absolute)", () => {
    expect(bash("rm -rf .git").denied).toBe(true);
    expect(bash(`rm -rf ${join(WS, ".git")}`).denied).toBe(true);
    expect(bash("rm -fr .git").denied).toBe(true); // flag-order variant
  });

  it("§2.5 remote-ref deletion: --delete / -d / :refspec", () => {
    expect(bash("git push --delete origin feature").denied).toBe(true);
    expect(bash("git push -d origin feature").denied).toBe(true);
    expect(bash("git push origin :feature").denied).toBe(true);
  });

  it("§2.6 rm -rf of the workspace ROOT itself", () => {
    expect(bash("rm -rf .").denied).toBe(true); // cwd === workspace root
    expect(bash(`rm -rf ${WS}`).denied).toBe(true);
  });

  it("§2.7 self-protection: any touch of ~/.claude-bridge (Bash + Write)", () => {
    expect(bash("cat ~/.claude-bridge/tokens.json").denied).toBe(true);
    expect(bash("echo x > ~/.claude-bridge/tokens.json").denied).toBe(true);
    expect(bash(`cat ${join(CFG, "tokens.json")}`).denied).toBe(true);
    // Write/Edit path inspection (the NEW non-Bash surface):
    expect(write(join(CFG, "tokens.json")).denied).toBe(true);
    expect(write(join(CFG, "workspaces.json")).denied).toBe(true);
  });

  it("base deny-list still enforced (carried into the floor)", () => {
    expect(bash("sudo rm x").denied).toBe(true);
    expect(bash("rm -rf /").denied).toBe(true);
    expect(bash("npm install left-pad").denied).toBe(true);
    expect(bash("cat ~/.ssh/id_rsa").denied).toBe(true);
    expect(bash("cat ~/.aws/credentials").denied).toBe(true);
  });

  it("denial reasons are legible (Clyde can explain the block)", () => {
    expect(bash("git push --force").reason).toMatch(/force-push/);
    expect(bash("rm -rf .git").reason).toMatch(/\.git/);
    expect(write(join(CFG, "tokens.json")).reason).toMatch(/claude-bridge/);
  });
});

describe("floor §3 — NOT floored (authorization-governed; must not over-block)", () => {
  it("non-force git push to a normal branch is allowed", () => {
    expect(bash("git push origin main").denied).toBe(false);
    expect(bash("git push -u origin feature").denied).toBe(false);
  });

  it("in-workspace rm (incl. recursive of subpaths) is allowed", () => {
    expect(bash("rm -rf node_modules").denied).toBe(false);
    expect(bash("rm -rf dist build").denied).toBe(false);
    expect(bash("rm file.txt").denied).toBe(false); // non-recursive
    expect(bash("rm -f stale.log").denied).toBe(false);
  });

  it("local-only history rewrite (unpushed) is allowed", () => {
    expect(bash("git reset --hard HEAD~1").denied).toBe(false);
    expect(bash("git commit --amend -m fix").denied).toBe(false);
    expect(bash("git rebase -i HEAD~3").denied).toBe(false);
  });

  it("in-workspace Write/Edit is allowed", () => {
    expect(write(join(WS, "src", "index.ts")).denied).toBe(false);
    expect(write("src/relative.ts").denied).toBe(false); // resolves under WS
    expect(checkToolFloor("Edit", { file_path: join(WS, "a.ts") }, WS, CFG).denied).toBe(false);
  });

  it("read-only tools (no path) are allowed", () => {
    expect(checkToolFloor("Read", { file_path: join(CFG, "tokens.json") }, WS, CFG).denied).toBe(false);
    // ^ Read is not a write tool — the floor does not inspect it (read of the
    //   config via Read tool would still be caught only if it were Bash `cat`).
    expect(checkToolFloor("Grep", { pattern: "x" }, WS, CFG).denied).toBe(false);
  });
});

describe("floor — adversarial evasion coverage (honest)", () => {
  it("COVERED: absolute outside-paths are caught even when chained after cd", () => {
    // An ABSOLUTE destructive target is caught regardless of cd state.
    expect(bash(`cd /tmp && rm -rf ${OUTSIDE}`).denied).toBe(true);
    expect(bash(`cd /tmp && rm -rf ${join(CFG, "x")}`).denied).toBe(true);
  });

  it("COVERED: config-dir reach via Write tool (not just Bash)", () => {
    expect(write(join(CFG, "clients.json")).denied).toBe(true);
  });

  it("NOT COVERED (executor-discipline gap): cd-then-relative-rm", () => {
    // `cd /other && rm -rf stuff` — the relative `stuff` is statically resolved
    // against the workspace root (→ in-workspace → allowed), but the real cwd
    // is /other. Static inspection cannot model the cd; this remains an
    // executor-discipline concern, documented honestly. Asserting the CURRENT
    // (allowed) behavior so the gap is visible, not silently assumed-closed.
    expect(bash("cd /other && rm -rf stuff").denied).toBe(false);
  });

  it("NOT COVERED (executor-discipline gap): env-var / indirection that resolves in-workspace-looking", () => {
    // A path built via an env var is opaque to static inspection — the token
    // `$TARGET` resolves against the workspace root (→ looks in-workspace →
    // allowed), but at runtime could expand anywhere. Remains discipline.
    expect(bash("rm -rf $TARGET").denied).toBe(false);
    // (Conservative bonus: a substitution whose literal text embeds an
    // absolute outside path IS denied — over-denial is safe. e.g.:)
    expect(bash("rm -rf $(cat /tmp/target)").denied).toBe(true);
  });
});

describe("checkBashFloor / checkWritePathFloor direct units", () => {
  it("workspace-root equality is exact (a sibling with the same prefix is NOT the root)", () => {
    // `${WS}-sibling` shares a string prefix but is NOT under WS.
    const sibling = WS + "-sibling" + sep + "x";
    expect(checkBashFloor(`rm -rf ${sibling}`, WS, CFG).denied).toBe(true); // outside
    expect(checkWritePathFloor(join(WS, "ok.ts"), WS, CFG).denied).toBe(false);
  });

  // T-P3-008 parity finding: path comparison must follow the host FS case
  // semantics. On win32 (case-insensitive FS) a case-variant of the auth dir
  // names the SAME dir and MUST be floored; on POSIX it is a distinct dir.
  it("auth-dir self-protection follows host FS case semantics (win32 case-fold)", () => {
    const variant = join(CFG.toUpperCase(), "tokens.json");
    if (process.platform === "win32") {
      expect(checkWritePathFloor(variant, WS, CFG).denied).toBe(true);
      expect(checkBashFloor(`cat ${variant}`, WS, CFG).denied).toBe(true);
    } else {
      expect(checkWritePathFloor(variant, WS, CFG).denied).toBe(false);
    }
  });
});

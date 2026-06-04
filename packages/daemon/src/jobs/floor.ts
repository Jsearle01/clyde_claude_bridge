// T-P3-006: the always-gate floor — a HARD-DENY set of catastrophic /
// never-delegate operations that the daemon blocks at `canUseTool`,
// un-overridable by any dispatch (a dispatch that authorizes one of these is
// the human's job by hand). There is NO mid-run "ask the human" channel; the
// floor BLOCKS and the delegated Clyde abort-reports the legible reason.
//
// GOVERNING PRINCIPLE (operator-decided): this is an AUTHORIZATION-SCOPE
// floor, not an operation blacklist. Only the catastrophic + never-delegate
// set lives here. Everything else dangerous (non-force push, in-workspace rm,
// local-only history rewrite) is authorization-governed DISCIPLINE — the
// dispatch's grant authorizes it; acting beyond the grant → abort-and-report.
// Do NOT over-block §3-class operations; flooring them would break legitimate
// authorized work.
//
// SCOPE HONESTY: this is a static check over freeform Bash command text +
// Write/Edit target paths. It catches the DIRECT forms of each floor item.
// Obfuscated forms (cd-then-operate so a relative path resolves elsewhere,
// command substitution, here-doc-built paths, env-var indirection) are NOT
// fully catchable by static inspection and remain executor-discipline. The
// pattern-match floor is a backstop against the catastrophic direct case, not
// a complete sandbox.

import { isAbsolute, resolve as pathResolve, normalize, sep, basename } from "node:path";
import { homedir } from "node:os";

export interface FloorDecision {
  denied: boolean;
  reason?: string;
}
const ALLOW: FloorDecision = { denied: false };
function deny(reason: string): FloorDecision {
  return { denied: true, reason };
}

// Tool names whose target path we inspect (the write surface).
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// ---- existing P1 base deny-list (carried verbatim; floor layers on top) ----
const BASE_BASH_DENY: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[rRf]+\s+)*\/(?:\s|$)/, reason: "rm of root filesystem" },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: "dd to device file" },
  { pattern: /\bsudo\b/, reason: "sudo invocation" },
  { pattern: /\bnpm\s+install\b/, reason: "npm install" },
  { pattern: /\bpip\s+install\b/, reason: "pip install" },
  { pattern: /\bapt(-get)?\s+install\b/, reason: "apt install" },
  { pattern: /\bbrew\s+install\b/, reason: "brew install" },
  { pattern: /(\$HOME|~|\/)\/?\.ssh(\/|\b)/, reason: "~/.ssh access" },
  { pattern: /(\$HOME|~|\/)\/?\.aws(\/|\b)/, reason: "~/.aws access" },
];

function stripQuotes(t: string): string {
  return t.replace(/^['"]/, "").replace(/['"]$/, "");
}

// Expand a leading ~ to the home dir; otherwise leave as-is.
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return pathResolve(homedir(), p.slice(2));
  }
  return p;
}

/** Resolve a path token against the SDK cwd (the workspace root). */
export function resolvePath(token: string, workspaceRoot: string): string {
  const p = expandHome(stripQuotes(token));
  return normalize(isAbsolute(p) ? p : pathResolve(workspaceRoot, p));
}

/** True when `child` is `parent` itself or nested under it. */
export function isUnder(child: string, parent: string): boolean {
  const c = normalize(child);
  const pa = normalize(parent);
  if (c === pa) return true;
  const prefix = pa.endsWith(sep) ? pa : pa + sep;
  return c.startsWith(prefix);
}

// Split a compound command on shell separators so each segment is analyzed
// in isolation (best-effort; does not model cd state — see SCOPE HONESTY).
function segments(command: string): string[] {
  return command.split(/&&|\|\||;|\n|\|/g);
}

// Tokenize a single command segment into whitespace-separated tokens.
function tokens(segment: string): string[] {
  return segment.trim().split(/\s+/).filter((t) => t.length > 0);
}

function checkConfigDirReference(
  command: string,
  configDir: string,
): FloorDecision {
  // §2.7 recursive auth-floor: the autonomy system may not touch its own
  // auth/gate/binding dir at all during a delegation. Mirrors the wholesale
  // ~/.ssh / ~/.aws block. Match the tilde/HOME shorthand AND the resolved
  // absolute config dir (so it can't be reached by the literal path either).
  if (/(\$HOME|~)[/\\]\.?claude-bridge([/\\]|\b)/.test(command)) {
    return deny("write/read of the claude-bridge auth dir (~/.claude-bridge)");
  }
  // Absolute config-dir path appearing literally in the command.
  const normConfig = normalize(configDir);
  if (command.includes(normConfig) || command.includes(configDir)) {
    return deny("write/read of the claude-bridge auth dir (config path)");
  }
  return ALLOW;
}

function checkGitFloor(segment: string): FloorDecision {
  if (!/\bgit\b/.test(segment)) return ALLOW;
  // §2.2 categorically history-destroying.
  if (/\bgit\s+filter-(branch|repo)\b/.test(segment)) {
    return deny("git filter-branch/filter-repo (history-destroying)");
  }
  if (/\bgit\s+push\b/.test(segment)) {
    // §2.1 force-push (publishes a rewrite of shared history).
    if (/--force(-with-lease)?\b/.test(segment)) {
      return deny("git force-push (--force/--force-with-lease)");
    }
    // short -f, possibly combined (e.g. -fv); avoid matching --foo.
    if (/(?:^|\s)-[a-zA-Z]*f[a-zA-Z]*\b/.test(segment) && !/--\S*f/.test(segment)) {
      return deny("git force-push (-f)");
    }
    // §2.5 remote-ref deletion.
    if (/--delete\b/.test(segment) || /(?:^|\s)-[a-zA-Z]*d[a-zA-Z]*\b/.test(segment)) {
      return deny("git push --delete (remote-ref deletion)");
    }
    // colon-prefixed refspec (`:branch`) deletes a remote ref; `+ref` forces.
    if (/\s:\S/.test(segment)) {
      return deny("git push :ref (remote-ref deletion via refspec)");
    }
    if (/\s\+\S/.test(segment)) {
      return deny("git force-push (+refspec)");
    }
  }
  return ALLOW;
}

function checkRmFloor(
  segment: string,
  workspaceRoot: string,
): FloorDecision {
  const toks = tokens(segment);
  const rmIdx = toks.findIndex((t) => t === "rm");
  if (rmIdx === -1) return ALLOW;
  const args = toks.slice(rmIdx + 1);
  // Only recursive deletes are catastrophic; plain `rm file` / `rm -f file`
  // (non-recursive, in-workspace) is authorization-governed, not floored.
  const flags = args.filter((a) => a.startsWith("-"));
  const recursive = flags.some(
    (f) => f === "--recursive" || (/^-[a-zA-Z]*[rR]/.test(f)),
  );
  if (!recursive) return ALLOW;
  const paths = args.filter((a) => !a.startsWith("-"));
  for (const raw of paths) {
    const resolved = resolvePath(raw, workspaceRoot);
    if (resolved === normalize(workspaceRoot)) {
      return deny("rm -rf of the workspace root (the sandbox root is inviolable)");
    }
    if (basename(resolved) === ".git") {
      return deny("rm -rf of a .git directory (repository destruction)");
    }
    if (!isUnder(resolved, workspaceRoot)) {
      return deny(`rm -rf of a path outside the workspace (${raw})`);
    }
    // else: under the workspace, not .git, not the root → allowed (§3).
  }
  return ALLOW;
}

/** Bash command floor — §2 items + the carried base deny-list. */
export function checkBashFloor(
  command: string,
  workspaceRoot: string,
  configDir: string,
): FloorDecision {
  for (const { pattern, reason } of BASE_BASH_DENY) {
    if (pattern.test(command)) return deny(reason);
  }
  const cfg = checkConfigDirReference(command, configDir);
  if (cfg.denied) return cfg;
  for (const seg of segments(command)) {
    const git = checkGitFloor(seg);
    if (git.denied) return git;
    const rm = checkRmFloor(seg, workspaceRoot);
    if (rm.denied) return rm;
  }
  return ALLOW;
}

/** Extract the target path from a Write/Edit/MultiEdit/NotebookEdit input. */
function writeTargetPath(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as { file_path?: unknown; notebook_path?: unknown };
  if (typeof o.file_path === "string") return o.file_path;
  if (typeof o.notebook_path === "string") return o.notebook_path;
  return null;
}

/** Write/Edit path floor — §2.7 (the only write-surface floor item). */
export function checkWritePathFloor(
  path: string,
  workspaceRoot: string,
  configDir: string,
): FloorDecision {
  const resolved = resolvePath(path, workspaceRoot);
  if (isUnder(resolved, configDir)) {
    return deny("write/edit of the claude-bridge auth dir (~/.claude-bridge)");
  }
  return ALLOW;
}

/**
 * The always-gate floor for a single tool call. Returns a hard-deny decision
 * for any §2 catastrophic/never-delegate operation, else allow. Used by
 * sdk-runner's canUseTool. `workspaceRoot` is the SDK cwd (the bound
 * workspace); `configDir` is the daemon's auth dir (~/.claude-bridge).
 */
export function checkToolFloor(
  toolName: string,
  input: unknown,
  workspaceRoot: string,
  configDir: string,
): FloorDecision {
  if (toolName === "Bash") {
    const command =
      typeof (input as { command?: unknown })?.command === "string"
        ? ((input as { command: string }).command)
        : "";
    return checkBashFloor(command, workspaceRoot, configDir);
  }
  if (WRITE_TOOLS.has(toolName)) {
    const p = writeTargetPath(input);
    if (p !== null) return checkWritePathFloor(p, workspaceRoot, configDir);
  }
  return ALLOW;
}

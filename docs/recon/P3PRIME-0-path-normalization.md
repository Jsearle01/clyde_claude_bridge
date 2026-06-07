# Recon: P3′-0 — Path normalization, daemon canonical == VS Code fsPath

**Task:** T-P3′-0 (SPIKE) · **Date:** 2026-06-07 · **Refs:** ADR-001 Addendum 4,
`P3PRIME-BUILD-SEQUENCE` Phase 0 · **Status:** win32 GROUND-TRUTH confirmed;
posix DERIVED / LIVE-UNCONFIRMED.

This note is the input to the Phase 2b re-verification. It records the **exact
observed** rules — not the documented or assumed ones. The whole daemon↔workspace
auto-pairing mechanism (Phases 2a/2b) depends on the daemon's canonical form of a
workspace path being **byte-identical** to the extension's
`workspaceFolders[0].uri.fsPath` for the same folder.

---

## Ground-truth capture (operator-gated)

Captured from a **real VS Code window** (engine `^1.85`, Windows 11) by the
operator running the `Claude Bridge: Probe Workspace Path` command (added by this
spike) against a known folder. Verbatim, untransformed:

- **Folder opened:** `C:\Projects\clyde_claude_bridge`

```
[cb-path-probe] workspaceFolders[0].uri — verbatim, untransformed:
  fsPath      = <c:\Projects\clyde_claude_bridge>
  path        = </c:/Projects/clyde_claude_bridge>
  toString()  = <file:///c%3A/Projects/clyde_claude_bridge>
```

(The `<…>` delimiters are probe-added so trailing whitespace / trailing
separators would be visible. None were present.)

---

## Observed win32 rules — GROUND TRUTH

| rule | observed | evidence |
|---|---|---|
| **Drive letter** | **lowercased** | opened `C:` → fsPath `c:`; corroborated by `path` (`/c:/…`) and `toString` (`%3A` after `c`) |
| **Separators** | **backslash** (`\`) in fsPath | `c:\Projects\clyde_claude_bridge` |
| **Trailing separator** | **none** | folder root carries no trailing `\` |
| **Path-segment case** | **PRESERVED as-opened** | `Projects` kept its capital `P` — fsPath does **not** fold segment case |
| **UNC** | **NOT OBSERVED** | the captured folder is a drive path, not a UNC share |
| **Symlink / realpath** | **NOT OBSERVED** | typed path == fsPath; no evidence VS Code realpath-resolves |

### The load-bearing nuance (segment case)
`fsPath` lowercases **only the drive letter**; it preserves the case of every
path segment. Therefore `canonicalizeWorkspacePath` must **not** fold segment
case either — `c:\projects\…` and `c:\Projects\…` are genuinely different
canonical identities under this function. Case-**insensitive** matching (NTFS is
case-insensitive) is a separate concern handled by the pre-existing
`normalizeAbsPath` (full-string lowercase → lookup key). The two functions are
**not** interchangeable; conflating them would silently collapse distinct
identities or fail exact matches. Phase 2b must decide which layer each
comparison uses.

### Hypothesis outcome
The dispatch's starting hypothesis (lowercase drive · backslash · no trailing
slash) **held exactly** for the drive-path case. No correction to the win32 arm
was needed beyond the segment-case clarification above. Drive-letter lowercasing
is a real surprise-candidate vs. the common assumption that fsPath upper-cases or
preserves the drive — captured, not assumed (see candidate note below).

---

## Derived posix rules — ASSUMED / LIVE-UNCONFIRMED

No Linux/macOS host available this spike. The posix arm is **constructed +
mock-platform tested only**; the real closer is the P4 cross-platform-CI item.

- forward slashes; runs of `/` collapsed
- trailing `/` stripped, **except** the filesystem root `/`
- case-**preserving**; no drive letter
- backslashes left intact (ordinary filename chars on posix, never separators)

These are the natural mirror of the win32 rules + POSIX path conventions, **not**
a live capture. Do not treat as verified.

---

## Pre-existing state found during recon (so we don't duplicate)

- **`--workspace` is NOT parsed by the CLI today.** `claude-bridge start`
  (`packages/cli/src/commands/start.ts`) takes no args and Commander declares no
  `--workspace` option (`packages/cli/src/index.ts`). The new function therefore
  has **no current production call site** — correct for a spike; Phase 2a wires it.
- **Partial normalization already exists:** `normalizeAbsPath(p)` in
  `packages/shared/src/path.ts`. It is **case-only** (full-string `.toLowerCase()`
  on win32), reads `process.platform` directly (not injected), and does **no**
  separator / trailing-slash handling. Used by `WorkspacesStore` for
  case-insensitive lookup **keys** — a different purpose from this function's
  fsPath-identity canonical form.
- Extension reads `vscode.workspace.workspaceFolders?.[0]` and uses
  `folder.uri.fsPath` (`packages/extension/src/extension.ts`).

---

## What was built (spike scope only — NO production wiring)

- `canonicalizeWorkspacePath(input, platform: 'win32'|'posix')` —
  `packages/shared/src/path.ts`. Placed beside its sibling `normalizeAbsPath`
  (the daemon already imports path helpers from `@claude-bridge/shared`); it is
  "daemon-side" in that the daemon is the consumer (operator `--workspace` input,
  Phase 2a). Platform is **injected** (defaulted nowhere — caller passes it),
  mirroring `candidatesFor(platform)` from CB-LINUX-LAUNCH-TESTS.
- Extension diagnostic probe — `packages/extension/src/workspace-path-probe.ts`,
  command `claudeBridge.probeWorkspacePath`. Logs the three URI fields verbatim
  to an always-visible OutputChannel (not the debug-gated diag console).
- Test — `packages/shared/tests/path.test.ts`: equivalence table asserts every
  input variant → the **live-captured** `fsPath` byte-for-byte; an explicit
  negative guard asserts segment case is **not** folded; posix arm mock-covered.

### Explicitly NOT built (deferred per dispatch)
Production wiring into identity/advertise/discover (Phases 1a/1b/2a/2b); the
advertise/discover handshake; per-daemon config-dir/port/pipe + lock re-scope;
symlink/realpath resolution (no live evidence it's needed). No edits to
`04-p3-oauth.md` or the P3 build plan (deferred reconcile).

---

## Candidate-pool note (DEFERRED — not reconciling the pool this session)
The capture confirming the *documented-but-easy-to-assume-wrong* drive-letter
lowercasing is a datapoint for a **"verify platform strings against live output,
not docs"** candidate. Logged here; pool entry deferred per dispatch.

# Recon: P3′-1a — Daemon canonical identity composition

**Task:** T-P3′-1a · **Date:** 2026-06-07 · **Refs:** ADR-001 Addendum 4,
`P3PRIME-BUILD-SEQUENCE` Phase 1a, T-P3′-0 verdict (case-folded-key contract).

## The exact composition wired
```
display_path = canonicalizeWorkspacePath(input, platform)   // case-PRESERVING
identity     = normalizeAbsPath(display_path, platform)      // case-FOLDED key
```
i.e. **`identity = normalizeAbsPath(canonicalizeWorkspacePath(input))`** —
implemented in `packages/daemon/src/workspace/identity.ts` (`computeDaemonIdentity`).

- **identity** (case-folded key) is what 1b derives config-dir/port/pipe from,
  2a advertises, and 2b matches the extension against.
- **display_path** (case-preserving canonical form) is the human-readable label
  used in logs.
- **name** is the operator's `--name`, passed through verbatim.

### Example (live, win32, 2026-06-07)
`--workspace "C:\Projects\clyde_claude_bridge" --name clyde-dev` →
```
identity      = c:\projects\clyde_claude_bridge   (case-folded key)
workspace_path= c:\Projects\clyde_claude_bridge   (display, case-preserving)
name          = clyde-dev
```
(verbatim from the daemon's `daemon identity` startup log line.)

## Why two functions, not one
T-P3′-0 captured that VS Code's `fsPath` lowercases only the drive letter and
**preserves segment case**. So the *display/identity* canonical form
(`canonicalizeWorkspacePath`) is NOT case-folded. But matching must be
case-insensitive on Windows (NTFS) because the operator types `--workspace`
independently of how VS Code reports the folder. The case-fold therefore lives
in a *second* step (`normalizeAbsPath`) applied on top of the canonical form —
that composite is the identity key. Folding inside `canonicalizeWorkspacePath`
would have broken the 2b byte-for-byte `fsPath` match; not folding at all would
have broken case-insensitive matching. The two-function split is the resolution.

## normalizeAbsPath state (read-first finding)
`normalizeAbsPath` was **complete, not a stub** (full-string lowercase on win32,
identity on unix) — but it read `process.platform` directly and was NOT
platform-injectable, unlike `canonicalizeWorkspacePath`. To compose the two
deterministically (and run the identity-stability table on any CI host), 1a
added an optional `platform` arg (default `process.platform`), behavior-
preserving for the existing `WorkspacesStore` lookup-key caller.

## Scope held (what 1a did NOT touch)
No config-dir / port / pipe derivation, no identity hashing (1b); no
single-instance lock re-scope (1c); no advertise file (2a); no extension
discovery / multi-root (2b). The daemon computes + LOGS the identity only;
existing single-daemon runtime (port-bind, pid, lock) is unchanged. The CLI
`start` now *requires* `--workspace` (single folder) + `--name` and forwards
them to the spawned daemon.

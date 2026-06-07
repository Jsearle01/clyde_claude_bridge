// Path normalization for case-insensitive identity comparison.
//
// On Windows, NTFS is case-insensitive by default; "c:\Projects\X" and
// "c:\projects\x" refer to the same on-disk location. Lowercase the
// entire string for lookup-key purposes.
//
// On Unix, filesystems are case-sensitive; return identity.
//
// This is for lookup-key normalization only. Original case should be
// preserved in stored abs_path fields for display, audit, and OS-faithful
// cwd resolution at delegation time.

export function normalizeAbsPath(p: string): string {
  if (process.platform === "win32") {
    return p.toLowerCase();
  }
  return p;
}

// Canonicalize an arbitrary operator-supplied workspace path (the daemon's
// `--workspace` input, Phase 2a) to the single string the daemon compares
// against VS Code's `workspaceFolders[0].uri.fsPath` for the same folder.
//
// DISTINCT from normalizeAbsPath above: that lowercases the WHOLE string to
// build a case-insensitive *lookup key*; this produces the *identity* form
// expected to be byte-identical to fsPath, which PRESERVES the case of path
// segments. They are not interchangeable.
//
// `platform` is injected (not read from process.platform) so both branches
// are directly assertable without mutating globals — mirrors candidatesFor()
// from CB-LINUX-LAUNCH-TESTS.
//
// win32 rules: CONFIRMED against live-captured fsPath on 2026-06-07 (folder
// "C:\Projects\clyde_claude_bridge" -> fsPath "c:\Projects\clyde_claude_bridge").
// See docs/recon/P3PRIME-0-path-normalization.md for the verbatim capture.
//   - drive letter: lowercased  ("C:" -> "c:")            [GROUND TRUTH]
//   - separators: backslash; forward slashes converted; runs collapsed  [GT]
//   - trailing separator stripped, except a drive root is kept as "x:\"  [GT]
//   - case of remaining path segments: PRESERVED as-opened — fsPath does NOT
//     fold segment case, so this fn must not either; case-insensitive lookup
//     is normalizeAbsPath's job (Phase 2b)                 [GROUND TRUTH]
//   - UNC ("\\server\share"): NOT exercised by the capture (drive path only)
//     — the UNC arm below is a hypothesis, LIVE-UNCONFIRMED
//   - symlinks: no evidence VS Code realpath-resolves; UNOBSERVED, not handled
// posix rules: DERIVED, LIVE-UNCONFIRMED (no Linux host this spike; the real
// closer is the P4 cross-platform-CI item).
//   - forward slashes, runs collapsed; trailing slash stripped except root "/"
//   - case-preserving; no drive letter; backslashes left intact (valid
//     filename chars on posix, never separators)
export function canonicalizeWorkspacePath(
  input: string,
  platform: "win32" | "posix",
): string {
  if (platform === "win32") {
    return canonicalizeWin32(input);
  }
  return canonicalizePosix(input);
}

function canonicalizeWin32(input: string): string {
  // Unify separators to backslash, remembering a UNC prefix (leading "\\")
  // so the collapse step below doesn't eat the second leading backslash.
  let p = input.replace(/\//g, "\\");
  const isUnc = /^\\\\/.test(p);
  p = p.replace(/\\+/g, "\\");
  if (isUnc) p = "\\" + p;
  // Lowercase a leading drive letter ("C:" -> "c:"); leave the rest as typed.
  p = p.replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
  // Strip trailing separators, but keep a bare drive root as "x:\".
  p = p.replace(/\\+$/, "");
  if (/^[A-Za-z]:$/.test(p)) p += "\\";
  return p;
}

function canonicalizePosix(input: string): string {
  // Collapse separator runs; drop a trailing slash except the filesystem
  // root "/". Backslashes are left untouched — they are ordinary characters
  // on posix, not separators.
  let p = input.replace(/\/+/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p;
}

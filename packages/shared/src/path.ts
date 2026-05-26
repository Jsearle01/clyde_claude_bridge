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

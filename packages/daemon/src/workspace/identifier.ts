// Workspace identifier generation. Pure function for testability — the
// caller supplies an `isUsed` predicate that the daemon backs with the
// WorkspacesStore's existing-identifier lookup. Slug + 6-hex-char suffix
// (24 bits entropy); collision retry up to 3 times. 4th collision throws,
// which is a defect indicator rather than a normal path at this entropy.
//
// Algorithm (T-P2-003 Decision 8):
//   1. Lowercase; replace non-[a-z0-9-] with "-"; collapse runs of "-";
//      strip leading/trailing "-"; truncate to 32 chars.
//   2. If empty, fall back to literal "workspace".
//   3. Generate suffix = crypto.randomBytes(4).toString("hex").slice(0,6).
//   4. Combine `${slug}-${suffix}` and check isUsed; retry up to 3 times.

import { randomBytes } from "node:crypto";

const SLUG_MAX_LEN = 32;
const FALLBACK_SLUG = "workspace";
const MAX_COLLISION_RETRIES = 3;

export class IdentifierCollisionError extends Error {
  constructor(public readonly attempts: number) {
    super(
      `failed to generate unique workspace identifier after ${attempts} attempts`,
    );
    this.name = "IdentifierCollisionError";
  }
}

export function slugify(folderName: string): string {
  let s = folderName.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  s = s.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > SLUG_MAX_LEN) s = s.slice(0, SLUG_MAX_LEN);
  s = s.replace(/-+$/g, "");
  if (s.length === 0) return FALLBACK_SLUG;
  return s;
}

function generateSuffix(): string {
  return randomBytes(4).toString("hex").slice(0, 6);
}

export function generateIdentifier(
  folderName: string,
  isUsed: (candidate: string) => boolean,
): string {
  const slug = slugify(folderName);
  for (let attempt = 0; attempt <= MAX_COLLISION_RETRIES; attempt++) {
    const candidate = `${slug}-${generateSuffix()}`;
    if (!isUsed(candidate)) return candidate;
  }
  throw new IdentifierCollisionError(MAX_COLLISION_RETRIES + 1);
}

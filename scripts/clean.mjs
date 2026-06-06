// CB-CLEAN-BUILD-FIX: delete all build artifacts (per-workspace dist/ +
// tsconfig.tsbuildinfo) so the next build is a genuine CLEAN build.
//
// WHY THIS EXISTS: incremental `tsc -b` reports success while skipping a
// package whose .tsbuildinfo says "up to date" — which masked a real
// dependency-resolution break in the daemon for weeks (the built dist stayed
// stale while every `npm run build` was a daemon no-op). A green incremental
// build is NOT evidence the project builds. CI and release verification must
// build from clean; `npm run build:clean` makes that one portable command.
//
// Dependency-free + cross-platform (Node fs.rmSync, recursive+force), so it
// works identically on Windows and Linux/WSL — both first-class targets.

import { rmSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(repoRoot, "packages");

let removed = 0;
const remove = (path, label) => {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
    console.log(`  removed ${label}`);
    removed += 1;
  }
};

for (const pkg of readdirSync(packagesDir)) {
  const base = join(packagesDir, pkg);
  remove(join(base, "dist"), `packages/${pkg}/dist`);
  remove(join(base, "tsconfig.tsbuildinfo"), `packages/${pkg}/tsconfig.tsbuildinfo`);
}

console.log(removed === 0 ? "clean: nothing to remove" : `clean: removed ${removed} artifact(s)`);

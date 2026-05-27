// T-P2-008.5: esbuild bundle config for the VS Code extension.
//
// Bundles src/extension.ts → dist/extension.js (CJS) with @claude-bridge/*
// workspace deps inlined. `vscode` is kept external (must never be
// bundled — VS Code provides it at runtime).
//
// Closes C-28: prior tsc-only emit left package-name imports of
// @claude-bridge/shared that Node ESM loader could not resolve inside
// the .vsix (workspace sibling, not in node_modules; vsce
// --no-dependencies strips workspace deps from the package).
//
// tsc is retained for type-checking only (noEmit: true in tsconfig.json).

import * as esbuild from "esbuild";
import { rmSync } from "node:fs";

// Clean dist/ first so stale tsc artifacts (.d.ts, .d.ts.map, per-module
// .js) don't ship with the new bundled output.
rmSync(new URL("./dist", import.meta.url), { recursive: true, force: true });

await esbuild.build({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  sourcemap: true,
  target: "node18",
  minify: false,
  logLevel: "info",
});

// T-P2-008.5: regression test for the .vsix bundling fix (closes C-28).
//
// Reads dist/extension.js (produced by esbuild — see esbuild.config.mjs)
// and asserts it does NOT contain external import/require references to
// @claude-bridge/* workspace packages. The bundler must inline those.
//
// Without this guard, a tsc-only emit (or an esbuild misconfig that
// externalizes workspace deps) would silently regress to package-name
// imports in the .vsix, breaking extension activation with
// ERR_MODULE_NOT_FOUND.
//
// Prerequisite: `npm run build` must have run. The build script bundles
// before tsc; vitest is invoked after build by `npm test`-style harness
// in normal use. A `test.skipIf` guard handles the dist-absent edge case
// (e.g., running this file in isolation without a fresh build) by
// reporting the actionable error rather than a confusing toBe failure.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const distPath = fileURLToPath(
  new URL("../dist/extension.js", import.meta.url),
);

describe("dist/extension.js bundling (T-P2-008.5 / C-28)", () => {
  it("dist/extension.js exists after build", () => {
    expect(existsSync(distPath)).toBe(true);
  });

  it("dist/extension.js contains no require() of @claude-bridge/* siblings", () => {
    const content = readFileSync(distPath, "utf8");
    // CJS shape: require("@claude-bridge/...") or require('@claude-bridge/...')
    expect(content).not.toMatch(/require\(\s*["']@claude-bridge\//);
  });

  it("dist/extension.js contains no ESM import from @claude-bridge/* siblings", () => {
    const content = readFileSync(distPath, "utf8");
    // ESM shapes: from "@claude-bridge/..." or import("@claude-bridge/...")
    expect(content).not.toMatch(/from\s+["']@claude-bridge\//);
    expect(content).not.toMatch(/import\(\s*["']@claude-bridge\//);
  });

  it("dist/extension.js keeps `vscode` as an external import (must not be bundled)", () => {
    const content = readFileSync(distPath, "utf8");
    // The vscode module is provided by the extension host at runtime;
    // bundling it would break activation. Esbuild output for CJS leaves
    // require("vscode") in place.
    expect(content).toMatch(/require\(\s*["']vscode["']\s*\)/);
  });
});

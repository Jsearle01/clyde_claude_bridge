import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/", "**/node_modules/", "**/*.d.ts"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // projectService auto-discovers per-package tsconfigs.
        // `allowDefaultProject` lets test files (which are not in any tsconfig
        // per the AC-5 design choice) get a default project so type-aware
        // rules still apply to them.
        projectService: {
          allowDefaultProject: [
            "packages/*/tests/*.test.ts",
            "packages/*/tests/*/*.test.ts",
          ],
          // Bumped past the v8 default of 8 — tests are growing past that
          // threshold. Each entry is a small file with no transitive imports
          // beyond src + node_modules; perf impact is minimal.
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 50,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Test files: assertions on vi.fn() mocks legitimately pass method
    // references without invoking them. The unbound-method rule's premise
    // (avoiding accidental `this`-detached calls) doesn't apply to mock
    // assertions, which never invoke the reference.
    files: ["packages/*/tests/**/*.test.ts"],
    rules: {
      "@typescript-eslint/unbound-method": "off",
    },
  },
);

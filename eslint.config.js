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
          allowDefaultProject: ["packages/*/tests/*.test.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);

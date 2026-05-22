# Pattern: Node ESM imports

## Type
convention

## Scope
project-specific

## Applies to
Every TypeScript source file in this project.

## Description

This project uses Node 20+ ESM with NodeNext module resolution. The imports look different from a CommonJS or bundler-targeted TypeScript project.

Rules:

1. **`node:` prefix for built-in modules.** `import { readFile } from "node:fs/promises"`, not `import { readFile } from "fs/promises"`. The prefix makes builtins visually distinct from third-party and avoids name shadowing if a package adopts the bare name.

2. **`.js` extension in relative imports, even from `.ts` source.** NodeNext requires it. `import { foo } from "./foo.js"` — even though the source file is `foo.ts`. TypeScript handles the resolution; the emitted JS keeps the extension and works at runtime.

3. **Re-exports from a package index use `.js` too.** `export * from "./config.js";` in `src/index.ts`.

4. **Type-only imports keep the same rule.** `import type { Foo } from "./foo.js"`.

5. **No CommonJS interop unless wrapping a CJS-only dep.** If a dep ships only CJS, the wrapper is local, documented, and isolates the interop to one file.

## Example

```typescript
// packages/shared/src/index.ts
export * from "./config.js";
export * from "./audit.js";
export * from "./ipc.js";
export * from "./tools.js";

// packages/daemon/src/audit/log.ts
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { AuditEntry } from "@claude-bridge/shared";

// packages/daemon/src/config/load.ts
import { ConfigSchema } from "@claude-bridge/shared";
import { loadConfigFile } from "./paths.js";
```

## Anti-example

```typescript
// WRONG — missing .js extension; works in some tooling but breaks at runtime
import { ConfigSchema } from "./config";

// WRONG — missing node: prefix; works but loses the distinction
import { randomBytes } from "crypto";

// WRONG — CommonJS require in an ESM project
const z = require("zod");

// WRONG — default import of a named export
import zod from "zod";  // when the package's main export is named
```

## Caveats

- Dynamic imports: `await import("./foo.js")` — same `.js` rule.
- JSON imports require import assertions in older Node; Node 20 has them stabilized as `import data from "./data.json" with { type: "json" }`. If JSON imports come up, verify the current Node 20 syntax before adopting.
- When a dep ships both ESM and CJS via `exports` field, prefer the ESM entry point.

## References

- `tsconfig.base.json` — `module: NodeNext`, `moduleResolution: NodeNext`
- Node ESM docs: https://nodejs.org/api/esm.html
- TS NodeNext docs: https://www.typescriptlang.org/docs/handbook/modules/reference.html#node16-nodenext

## Status
active (promoted 2026-05-21 at T-0003 closure — rules exercised in `packages/shared/src/{config.ts,index.ts}` and tests; build + lint + test all clean)

## History
- 2026-05-21: pre-populated during day-zero setup, based on `p0-build-plan.md` §1.1 tsconfig requirements.
- 2026-05-21: promoted from draft to active at T-0003 closure. First real exercise of the `.js` extension rule (in `src/index.ts`'s `export * from "./config.js"`) and the `node:` prefix discipline (in `src/config.ts`'s import of `zod` — not a builtin so no `node:` needed, but the test file's imports demonstrate the discipline). Build clean, lint clean, test clean.

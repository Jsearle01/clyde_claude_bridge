# Pattern: Zod schema validation at external boundaries

## Type
architectural / convention

## Scope
project-specific

## Applies to
Any code path that ingests data from outside the process boundary: config files, IPC messages, MCP tool calls, command-line arguments, environment variables, parsed subprocess output.

## Description

External inputs are untrusted. The rule: every external input is validated by a Zod schema before any business logic touches it. There are no exceptions for "obviously safe" inputs — the daemon is long-lived and a malformed input that crashes the process or corrupts state is a real failure mode.

Rules:

1. **One schema per input shape, defined once.** Schemas live in `packages/shared/src/` for any input that crosses the package boundary; package-local schemas live in `packages/<pkg>/src/`. No duplicating a schema across files.

2. **Parse, don't validate.** Use `.parse()` (throws on error) or `.safeParse()` (returns a discriminated result). Never use `as` to coerce a raw `unknown` into a typed value.

3. **Parse at the boundary, not deeper.** The function that reads the file or receives the IPC message is the parse site. Everything called from there receives an already-typed value.

4. **Translate Zod errors to typed domain errors.** Bare `ZodError` is fine internally; at user-facing boundaries (CLI output, IPC response, MCP response), translate to a typed error with a clear, non-technical message.

5. **Strict mode for schemas at trust boundaries.** Use `.strict()` (no extra keys allowed) for IPC and MCP tool inputs. Use `.passthrough()` only when forward-compatibility with unknown fields is explicitly required.

## Example

```typescript
// packages/shared/src/config.ts
import { z } from "zod";

export const ConfigSchema = z.object({
  version: z.literal(1),
  daemon: z.object({
    bind_host: z.string().default("127.0.0.1"),
    bind_port: z.number().int().min(1).max(65535).default(7423),
    ipc_socket: z.string()
  }),
  auth: z.object({
    token: z.string().regex(/^cb_live_[A-Z2-7]{32}$/)
  }),
  // ...
}).strict();
export type Config = z.infer<typeof ConfigSchema>;

// packages/daemon/src/config/load.ts
import { readFile } from "node:fs/promises";
import { ConfigSchema, type Config } from "@claude-bridge/shared";

export class ConfigValidationError extends Error {
  constructor(message: string, public readonly issues: unknown) { super(message); }
}

export async function loadConfig(path: string): Promise<Config> {
  const raw = JSON.parse(await readFile(path, "utf8"));
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigValidationError(
      `Config at ${path} is invalid`,
      result.error.format()
    );
  }
  return result.data;
}

// packages/daemon/src/mcp/dispatch.ts
import { PingInputSchema } from "@claude-bridge/shared";

async invoke(name: string, rawInput: unknown, ctx: ToolContext) {
  const tool = this.registry.get(name);
  if (!tool) throw new ToolNotFoundError(name);
  const input = tool.inputSchema.parse(rawInput);  // throws ZodError on mismatch
  return await tool.handler(input, ctx);
}
```

## Anti-example

```typescript
// WRONG — `as` to bypass validation
const config = JSON.parse(await readFile(path, "utf8")) as Config;
// `config` is typed but unsafe; a malformed file is a runtime explosion later

// WRONG — validating deep inside business logic
async function handlePing(input: unknown) {
  // ... 50 lines of logic ...
  if (typeof input !== "object" || input === null) throw new Error("bad input");
  // by now, callers have already assumed input is well-shaped
}

// WRONG — accepting a permissive schema where strict is right
const IpcRequestSchema = z.object({ kind: z.string() });  // anything-goes
// IPC is a trust boundary; "kind: 'evil'" with extra payload silently passes
```

## Caveats

- For very high-frequency hot paths, parsing every input is fine in practice; Zod is fast. If profiling shows a bottleneck, the answer is rarely "skip validation" and usually "pre-compile the schema once" or "batch validation."
- For internal-only types that never cross a process boundary, schemas are not required. The boundary is what matters.

## References

- `packages/shared/src/config.ts` — canonical ConfigSchema
- `packages/shared/src/ipc.ts` — IpcRequest discriminated union
- `packages/shared/src/tools.ts` — PingInputSchema
- Zod docs: https://zod.dev

## Status
active (promoted 2026-05-21 at T-0003 closure — `ConfigSchema` in `packages/shared/src/config.ts` implements the pattern; `.strict()` addition catches typos in user config; test suite verifies happy-path, defaults, missing-required, bad-format, and strict-rejection cases)

## History
- 2026-05-21: pre-populated during day-zero setup, based on `p0-build-plan.md` §2.2 and §4 schemas.
- 2026-05-21: promoted from draft to active at T-0003 closure. `ConfigSchema` uses `.strict()` at top level per the pattern's trust-boundary rule. Five-case test suite (`tests/config.test.ts`) verifies pattern application: happy path, defaults, missing required field, invalid token regex, extra-key rejection.

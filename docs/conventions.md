# claude-bridge — conventions

Project-specific conventions. Cross-references existing docs for content that lives there.

## Three-role workflow

This project operates under Claude-Orchestrated Development Methodology v0.3 (`claude-orchestrated-methodology-v0_3.md`):

- **Orchestrator** — Claude.ai project conversation. Plans, verifies, packages context, drafts prompts, maintains state, curates pattern library.
- **Executor** — Claude Code session with workspace access. Reads context, writes code, runs tests, reports.
- **Human gate** — project owner. Final authority.

During the calibration phase (first 20–50 tasks, methodology §25), the human gate reviews every task before integration.

## Architecture references

For architecture, frozen decisions, and design rationale, see (in order):
- `00-overview.md` — topology, gate sequence, frozen decisions
- `01-p0-bus.md` — P0 design
- `p0-build-plan.md` — concrete file paths, function shapes, build order
- `walkthrough.md` — steady-state UX (forward reference)

This conventions doc does not duplicate that content. It captures only what's project-specific and applies across all tasks.

## Implementation conventions

| Property | Choice |
|----------|--------|
| Language | TypeScript |
| Runtime | Node 20.10+ |
| Module system | ESM (NodeNext) |
| Build | TypeScript project references; `npm run build` from repo root |
| Test framework | Vitest (Q006 CLOSED 2026-05-21) |
| Lint | ESLint flat config (see Q001 — closure target T-0003) |
| Strict mode | on |
| `noUncheckedIndexedAccess` | true |

Per-package structure: see `p0-build-plan.md` §1.2 and §2–§7.

### Skeleton composite packages

When a TypeScript composite package exists but has no source files yet (`composite: true` with empty input), use `"files": []` in its `tsconfig.json`. Do NOT use `"include": []` — TypeScript 5.4.x emits `TS18003: No inputs were found` for the latter. Transition the package to `"include": ["src/**/*"]` when it gains its first source file.

(Discovered at T-0002 during package-skeleton scaffolding. Self-resolves once each package gains real source; this convention applies during the brief skeleton phase per package.)

## Commit message convention

Per methodology §22.1:

```
type: scope — human description
```

**Types:**
- `setup:` — day-zero or one-time infrastructure setup
- `impl:` — implementation work
- `docs:` — documentation
- `fix:` — bug fix
- `test:` — test work
- `refactor:` — refactoring without behavior change
- `chore:` — build/tooling/config

**Scope** is a task ID (`T-NNNN`), a package name (`shared`, `daemon`, `cli`), or a component name (`ipc-server`, `tunnel-manager`).

**Examples:**

```
setup: day-zero — methodology infrastructure (project-state, milestones, conventions)
impl: T-0001 — npm workspace scaffolding
impl: daemon — config layer with token generation
fix: ipc-server — unlink stale socket on start
docs: T-0019 — runbook covering start/stop/rotate/troubleshoot
```

**Closures** include verdict per methodology §22.3:

```
T-0001 CLOSED — workspace scaffolded; npm install verified at root
AC-3 CONFIRMED — ping roundtrip from Claude.ai project (human visual gate, 2026-MM-DD)
Q001 CLOSED — ESLint flat config adopted; rules in eslint.config.js
```

## File naming

Per methodology §24:

- Design docs at repo root or `docs/`: `00-overview.md`, `01-p0-bus.md`, etc.
- Status docs at `docs/`: `project-state.md`, `milestones.md`, `conventions.md`, `open-questions.md`
- Patterns at `patterns/project/<pattern-name>.md`
- Executor prompts: kept in chat; if filed locally, `executor_prompt_T-NNNN.md`
- Execution reports: stay in chat, NOT in repo (methodology §24.2)
- Test drivers under `tests/`, named for behavior not chronology (methodology §24.3): `tests/ping-roundtrip.test.ts`, not `tests/phase4-test1.test.ts`

## Cross-cutting concerns

Per methodology §26, the following apply to many or most routines in this project and are codified here so the executor reads them at every task:

### CC-1: Async error handling

Every async function. Promise rejections caught at the boundary where they're expected; never swallowed silently. Top-level handlers log to `daemon.log` before exit. A naked `.catch(() => {})` is a code-review failure.

### CC-2: Cross-platform paths and IPC

Two OS targets (Unix-like, Windows). Two IPC primitives (Unix domain socket, Windows named pipe). Conventions:
- Use `node:path` for all joining; never inline string concat
- Expand `~` via a single helper, never inline
- Config dir resolution lives in `packages/daemon/src/config/paths.ts` — single source of truth
- IPC socket path resolved through config; abstraction layer hides OS difference
- Test on both Unix and Windows before declaring IPC work done
- Line endings: enforce LF project-wide via `.gitattributes` at repo root with `* text=auto eol=lf` and explicit `eol=lf` on source extensions. `.editorconfig` configures editors; `.gitattributes` configures git. Both are required on Windows-host projects — `.editorconfig` alone is insufficient because `core.autocrlf=true` (Windows default) overrides editor behavior at checkout. Introduced at T-0002.5 after T-0001 shipped `.editorconfig` without the corresponding `.gitattributes`.

### CC-3: File permissions

Unix-specific. Files holding secrets or that the daemon owns:
- `config.json` — `0600`; daemon refuses to start if looser (AC-9)
- `daemon.sock` — `0600`; created with mode by the OS or chmod'd immediately after bind
- `audit.jsonl` — `0600`; created with mode

Check perms on read (refuse if looser). Set perms on write. Windows permission model differs; check OS first, only enforce on Unix.

### CC-4: Secret handling

Bearer tokens are sensitive. Rules:
- NEVER log token values. Use last-4 suffix in user-facing output (`token_suffix`).
- Always use constant-time compare for token equality (see `patterns/project/constant-time-compare.md`).
- Audit log records `input_hash` (sha256), never raw input that might contain tokens.
- `config.auth.token` is the only persistent copy. In-memory copies are scoped to where they're needed and not passed around freely.

### CC-5: Process lifecycle

The daemon is long-lived; cleanup matters.
- SIGTERM and SIGINT handlers registered at startup
- 10-second graceful shutdown budget; SIGKILL after
- PID file written on start (`${configDir}/daemon.pid`), removed on clean shutdown
- Stale PID detection on start: read PID, send signal 0; if process exists, refuse to start; if not, clear stale file
- Tunnel subprocess is a child; ensure SIGTERM propagates

### CC-6: Schema validation at external boundaries

Every external input goes through a Zod schema before code touches it:
- Config file read → `ConfigSchema.parse`
- IPC message received → `IpcRequest` discriminated union parsed
- MCP tool call input → tool's `inputSchema.parse`

No `as` casts to bypass validation. Schema parse errors become typed errors with clear messages, not raw Zod exceptions surfaced to the user. See `patterns/project/zod-schema-validation.md`.

## Documentation-first triggers

Per methodology §12, executor cites authoritative reference before producing code that depends on:
- MCP SDK behavior (`@modelcontextprotocol/sdk` — transport API, server API, tool registration)
- cloudflared output format (URL appears on stderr; format may vary across cloudflared versions)
- Node 20 ESM specifics (`node:` prefix, `.js` extension in TS-source imports, top-level await)
- Cross-platform IPC (`net.createServer` behavior on Unix sockets vs Windows named pipes)
- File permission semantics on Unix vs Windows

The orchestrator rejects work that proceeds on unverified assumptions about these.

## Dev-dependency audit policy

Added 2026-05-21 in response to T-0001's `npm install` surfacing 4 moderate advisories on the vitest dep chain. Codifies how this project treats transitive-dep advisories so the assessment doesn't get re-run from scratch every time.

### Severity floor

- **Critical or high** — block. Escalate to human gate regardless of reachability.
- **Moderate** — accept after reachability check (see below).
- **Low or info** — accept; track only if a pattern of accumulation emerges.

### Reachability check

For any moderate advisory, the executor's REASONING (and the orchestrator's verification) must include a brief assessment answering:

- Is there a production code path that could exercise the affected behavior?
- If yes → escalate to human gate (treat as high regardless of declared severity).
- If no → dev-only; accept; register as a standing advisory below.

### Force-bump policy

`npm audit fix --force` is never automatic. Major-version bumps of pinned dependencies are project decisions that go through normal task review (a dedicated task with its own AC). Standing advisories are accepted until either:
- the chain naturally resolves (transitive dep ships fix and `npm update` brings it in), or
- a major-version bump is proposed and approved by the human gate.

### Re-audit cadence

- Orchestrator re-runs the audit assessment at every task that adds or bumps a dependency.
- Standing advisories are revisited at every gate transition (P0 → P1, P1 → P2, etc.). The orchestrator decides whether each remains accepted, escalates a still-open advisory, or notes it cleared.
- A standing advisory that has been "accepted" for two consecutive gate transitions without resolution gets escalated to the human gate as a strategic question — at that point the supply chain isn't fixing itself and a force-bump or substitution is on the table.

### Standing advisories

| ID | Chain | Severity | Reachability | Accepted | Revisit trigger |
|----|-------|----------|--------------|----------|-----------------|
| GHSA-67mh-4wv8-2f99 | esbuild → vite → vite-node → vitest | Moderate | Dev-only (vite dev-server CORS issue; production daemon never invokes vite, vite-node, or the affected esbuild dev-server code paths) | 2026-05-21 (T-0001) | Vite ships fixed esbuild AND `npm update` clears chain; OR P0→P1 gate transition (whichever first) |

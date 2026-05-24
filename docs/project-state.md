# claude-bridge — project state

**Project:** claude-bridge
**Methodology version:** v0.3
**Current phase:** P0 (bus validation)
**Current integration milestone:** INT-1 (first ping roundtrip from Claude.ai project)
**Last conversation date:** 2026-05-23
**Status:** **P0 GATE-CLOSED 2026-05-23**. P1 IN PROGRESS — T-P1-008 (report assembler + cross-platform-test-inputs pattern doc) COMPLETE, awaiting verdict. Steady-state operating mode under methodology v0.4.
**Repository:** https://github.com/Jsearle01/clyde_claude_bridge (public, mechanically verified via `gh repo view` at T-P1-001.6)

## Gate status

| Gate | Status | Owner | Notes |
|------|--------|-------|-------|
| Day-zero setup | CLOSED | Orchestrator | Methodology infrastructure produced 2026-05-21 |
| P0 (bus validation) | OPEN | — | 10 acceptance criteria in `01-p0-bus.md`; AC-* blockers tracked in `milestones.md` |
| P1 (headless delegation) | NOT STARTED | — | Design doc written after P0 ships |
| P2 (VS Code extension) | NOT STARTED | — | Design doc written after P1 ships |
| INT-1 (ping roundtrip) | OPEN | — | All 10 AC blockers still OPEN |

## Task queue

### In progress
- T-P1-008 — Phase 8 report assembler (fail-soft transcript parsing + summary backward-walk + truncation precedence) + new project pattern doc `cross-platform-test-inputs.md` at 5th use site (COMPLETE, awaiting verdict)

### Pending (ordered, mapped from `p1-build-plan.md` phases)
- T-P1-002+ — Phase 2 workspace registry stub
- (Phases 3-14 per `docs/design/p1-build-plan.md` §Task order; note Phase 4/5 swap applied)

### Recently completed
- **T-0019.7** — P0 gate close — all 10 ACs VERIFIED (CONFIRMED 2026-05-23; gate-close commit)
  - Trivial doc-only insert; ~3 min Clyde-time. Two milestones.md cell edits + project-state.md status / in-progress / recently-completed / handoff updates.
  - AC-10 transitioned IMPLEMENTED → **VERIFIED** with MANUAL-VERIFIED-AT-GATE per orchestrator + human gate decision. T-0007 unit-tested the rotation with synthetic midnight; async-sink-queue architecture protects against rotation-during-write race. Natural confirmation expected at first midnight-crossing daemon run during P1.
  - P0 phase row IMPLEMENTED → **GATE-CLOSED** 2026-05-23.
  - 23-commit P0 history (T-0001 through T-0020 + T-0002.5 + T-0019.5 + T-0019.6 + T-0019.7).
- **T-0019.6** — AC-9 verification on WSL Ubuntu (CONFIRMED 2026-05-23; commit c721198)
  - 17 min Clyde-time; +15 min WSL environment setup overhead (user-local Node 20.18 + cloudflared 2026.5.0 tarballs, project rsync from /mnt/c to ~/claude-bridge-wsl for native ext4 modes).
  - AC-9 procedure ran end-to-end with cloudflared functional: first start created config at -rw-------; chmod 0644 → start exited 1 with verbatim `ConfigPermissionError`; chmod 0600 restored normal start. Verbatim transcript in T-0019.6 report.
  - Noted-not-fixed: TS7016/TS7006 build noise on Node 20 + WSL for `@modelcontextprotocol/sdk/types.js`; JS output complete, runtime unaffected; candidate P1 follow-up.
- **T-0020** — README + runbook (CONFIRMED 2026-05-23; commit 4a936f9)
  - 6 min Clyde-time; consolidation-medium sub-bucket (faster than the medium prediction band because all findings were cached from T-0019/T-0019.5).
  - `README.md` (~95 lines): replaced T-0001 scaffolded version with quick-start + layered gate table + per-OS cloudflared install + MCP client procedures including SMOKE-2 caveat.
  - `docs/runbook.md` (~280 lines): every CLI command with examples; full config.json schema; troubleshooting (cloudflared/PATH, stale PID, port collision, DNS for trycloudflare, Windows console, file-handle inheritance trap); MCP client procedures in depth; AC-9 + AC-10 verification procedures; acceptance harness run instructions.
  - `docs/project-state.md`: Final P0 calibration summary section with timing table, forward prediction bands (trivial/small/medium-fresh/medium-consolidation/large), 5 findings to keep, 3 findings to apply at P1.
  - `docs/milestones.md`: P0 phase OPEN → GATE-REVIEW-READY.
  - No code changes (doc-only per scope); 193 tests passing unchanged.
- **T-0019.5** — Windows console-window suppression + conventions codification (CONFIRMED 2026-05-23; commit cb690fa)
  - 5 min Clyde-time; trivial bucket; insert task between T-0019 and T-0020.
  - `packages/cli/src/commands/start.ts`: +1 line (`windowsHide: true` in the daemon spawn options).
  - `docs/conventions.md`: CC-2 bullet codifying two T-0015 + T-0019 findings — `windowsHide: true` for detached children on Windows, and the file-handle inheritance trap with redirected stdio when launching daemons from PowerShell.
  - No AC closes; no test changes (visual UX verification is the user's interactive check).
  - 17th consecutive zero-fire on async-discipline rules.
- **T-0019** — P0 acceptance script + 8-of-10 AC verification (CONFIRMED 2026-05-23; commit 5ed3940)
  - 60 min Clyde-time; medium task hit low end of prediction band.
  - `scripts/mcp-ping-client.mjs`: SDK client driver with custom-DNS workaround for trycloudflare subdomain propagation (undici Agent + `dns.resolve4` against 1.1.1.1/8.8.8.8 since the local resolver returned NXDOMAIN for newly-issued URLs)
  - `scripts/acceptance-p0.ps1`: PowerShell-native harness for 8 mechanical AC checks + 2 SKIPs (AC-9 Unix-only; AC-10 24-hour midnight)
  - `scripts/README.md`: index of dev scripts
  - Three source bugs surfaced and fixed: start.ts READY_TIMEOUT_MS 5s → 15s (race with daemon tunnel budget); dispatch.ts `Date.now()` → `performance.now()` + `Math.ceil` (AC-5 non-zero `duration_ms` spec fidelity); `undici` added as devDep for the helper's DNS workaround.
  - Live acceptance run 2026-05-23: 8 PASS / 2 SKIP / 0 FAIL across all 10 ACs (AC-1 cold-start 7.6s; AC-6 respawn observed; AC-8 full thunk → config → auth chain exercised).
  - Three PowerShell-side iterations (Args automatic-variable conflict; native-exe stderr ErrorRecord wrapping; **Windows file-handle inheritance trap** — the last codified at T-0019.5 as a cross-cutting convention).
  - 16th consecutive zero-fire on async-discipline rules.
- **T-0018** — CLI bin entry + global install (CONFIRMED 2026-05-23; commit 223a518)
  - First trivial-bucket task; 5 min Clyde-time.
  - `packages/cli/src/index.ts`: `--version` flag via commander + createRequire (matches daemon state.ts pattern); reads from packages/cli/package.json
  - `scripts/verify-install.ps1`: `npm link` + PATH resolution check + `--version` match + `--help` non-empty (4 PASS gates)
  - Shebang preservation: `tsc -b` preserves natively; no post-build scaffolding added (verified by inspecting dist/index.js's first line)
  - Manual smoke: `claude-bridge status` from `/tmp` → `Daemon: down` (exit 0); bin is globally reachable from any directory
  - No AC closes here (infrastructure for AC-1's globally-reachable invariant; T-0019 acceptance script exercises the linked bin)
  - 193 cases passing + 6 platform-skipped across 26 test files
  - Zero reactive source deviations
  - 15th consecutive zero-fire on async-discipline rules
  - The T-0018 commit bundled T-0017's source files (token.ts, tunnel.ts + tests) per orchestrator direction since T-0017's standalone closure verdict was not issued before T-0018 dispatched. AC-8 + AC-6 cross-link doc edits attribute to T-0017 in milestones.md.
- **T-0017** — `token rotate` + `tunnel restart` CLI commands (CONFIRMED 2026-05-23; bundled in commit 223a518 with T-0018)
  - AC-8 IMPLEMENTED. Two thin sendIpc wrappers following the stop/status pattern; PID-stale pre-flight, bounded timeouts, typed error classes per failure mode mapped to friendly stderr in index.ts.
  - `packages/cli/src/commands/token.ts`: `tokenRotateCommand` + 3 typed errors (`DaemonNotRunningError`, `TokenRotateConnectionLostError`, `TokenRotateTimeoutError`); 10s timeout.
  - `packages/cli/src/commands/tunnel.ts`: `tunnelRestartCommand` + 3 typed errors (`TunnelRestartConnectionLostError`, `TunnelRestartTimeoutError`, `TunnelRestartFailedError`); 20s timeout (cloudflared start + buffer). Imports `DaemonNotRunningError` from token.ts.
  - The error-envelope path (sendIpc surfacing `{kind:"error",message}` as plain Error) wraps to `TunnelRestartFailedError` preserving the daemon's message — exercises the TunnelDegradedError 5-in-5 fail path.
  - Commander nested subcommands (`token rotate`, `tunnel restart`); parent-without-subcommand prints help and exits 1 — appropriate default UX.
  - 9 new cli tests; 193 cases total + 6 platform-skipped across 26 files
  - 1 reactive fix: no-unused-vars on TunnelRestartFailedError import in tunnel.test.ts; resolved by switching from toMatchObject to instanceof + toThrow.
  - 14th consecutive zero-fire on async-discipline rules
  - AC-6 Notes column cross-linked: `tunnel restart` is the manual recovery path from `degraded` state.
- **T-0016** — stop / status / tail-log CLI commands (CONFIRMED 2026-05-23; commit e23779e)
  - AC-2 IMPLEMENTED; AC-7 IMPLEMENTED (SIGTERM path validated by smoke test 2026-05-22; CLI wrapper closes the user-facing surface)
  - `packages/cli/src/util/{paths,config,pidfile}.ts`: extracted from ipc-client.ts and start.ts on third confirmed use
  - `packages/cli/src/commands/stop.ts`: idempotent (absent → exit 0); ECONNREFUSED → "Daemon shut down."; 12s timeout → DaemonStopTimeoutError
  - `packages/cli/src/commands/status.ts`: PID-down short-circuit; full formatted block per 01-p0-bus.md spec; formatUptime, formatBytes, collapsePath helpers
  - `packages/cli/src/commands/tail-log.ts`: createReadStream + pipeline; follow mode via fs.watch + last-position tracking; truncation-tolerant; rotation tolerance deferred
  - 31 new cli tests; 184 cases total + 6 platform-skipped across 24 files
  - 2 reactive fixes: prefer-promise-reject-errors on tail-log watcher; cross-platform path.sep → explicit / or \\ in collapsePath
  - 13th consecutive zero-fire on async-discipline rules
- **T-0015** — `claude-bridge start` CLI command + bin entry (CONFIRMED 2026-05-22; commit ac66642)
  - First user-facing command; AC-1 IMPLEMENTED (end-to-end verification at T-0019)
  - `packages/cli/src/commands/start.ts`: orchestrator + 4 typed errors + 3 testable helpers (checkCloudflared, checkExistingDaemon, waitForReady)
  - `packages/cli/src/index.ts`: commander-based bin entry with shebang; friendly stderr mapping per error class
  - Pre-flight: cloudflared --version check; PID stale-detection; config-absent notice (daemon's main.ts handles actual init)
  - Daemon spawn detached + ready-line wait + unref + pipe destroy; full token surfaced via re-reading config
  - `packages/daemon/src/main.ts`: EPIPE handler on stdout/stderr (carry needed by T-0015's CLI detach pattern; daemon-side fix)
  - 12 new cli tests; 158 cases total + 4 platform-skipped
  - 1 reactive lint fix (restrict-template-expressions on never-narrowed response.kind; resolved by dropping over-specified generic)
  - 12th consecutive zero-fire on async-discipline rules for production
- **T-0014** — cli ipc-client (CONFIRMED 2026-05-22; commit 17398e3)
  - First source in packages/cli; foundation for T-0015–T-0017
  - `sendIpc<R>` + three typed error classes; 10s default timeout; addressOverride opt for test parallelism on Windows (parallels T-0008 IpcServer.addressOverride)
  - Cross-platform helpers (addressFor, getCliConfigDir) inline-duplicated from daemon with header comment; preserves T-0002's no-cli→daemon-TS-reference design
  - Tests import IpcServer from daemon via relative path (vite-node handles cross-package resolution at runtime)
  - 5 new cli tests; 146 cases total + 4 platform-skipped across 19 test files
  - 11th consecutive zero-fire on async-discipline rules
  - AC-3 and AC-5 → VERIFIED in milestones.md (smoke test 2026-05-22 via MCP Inspector)
- **T-0013** — Daemon main wiring + pidfile + DaemonState (CONFIRMED 2026-05-22; commit 72c6134)
  - First runnable daemon: `node packages/daemon/dist/main.js` produces working daemon end-to-end
  - Token rotation wired across three locations (closure, on-disk, auth thunk)
  - Script-entry guard prevents test imports from triggering real daemon startup
  - 2 reactive fixes; 16 new daemon tests; 145 cases total (141 passing + 4 platform-skipped)
  - 10th consecutive zero-fire on async-discipline rules for production
  - **Smoke-tested 2026-05-22 via MCP Inspector**: AC-3 and AC-5 functionally validated end-to-end (see calibration findings #SMOKE-1 through #SMOKE-5 below)
  - **Calibration phase CLOSED at T-0013.** Steady-state operating mode (lighter prompts, paragraph verdicts, summary reports) starts at T-0014.
- **T-0012** — Tunnel manager + AC-6 closure (CONFIRMED 2026-05-22; commit 55644db)
  - All 23 gate-blocking AC passed
  - AC-6 IMPLEMENTED (exit-handler triggers respawn; emits url_change; manager.test.ts 15.c/15.d verify; T-0019 end-to-end with real cloudflared)
  - `packages/daemon/src/tunnel/cloudflared.ts`: typed-EventEmitter subprocess wrapper; SIGTERM + 5s SIGKILL watchdog; line-buffered stdout/stderr
  - `packages/daemon/src/tunnel/manager.ts`: sliding-window restart policy (5-in-5min → degraded); 15s start timeout; processFactory + clock injection
  - `patterns/project/line-buffered-stream-reader.md` created at status active (two confirmed instances: T-0008 IPC + T-0012 cloudflared)
  - Two convention additions carried from T-0011: pre-add-dep verification; sync-handler Promise.resolve discipline
  - 3 reactive lint fixes + 1 reactive test fix (microtask flush via setImmediate)
  - 10 new daemon tests; 132 cases total across 16 test files (passing) + 4 platform-skipped
  - 9th consecutive zero-fire on async-discipline rules for production
  - Build plan §5 complete
- **T-0011** — Tool dispatch + ping + AC-3, AC-5 closure (CONFIRMED 2026-05-22; commit bcdbc22)
  - All 25 gate-blocking AC passed
  - AC-3 IMPLEMENTED (integration test 17.b via SDK Client → tools/call)
  - AC-5 IMPLEMENTED (integration test 17.c verifies audit entry on successful ping)
  - Build plan §4.1 complete (server + auth + dispatch + ping = full MCP surface)
  - `packages/daemon/src/state.ts`: minimal DaemonState (extends at T-0013)
  - `packages/daemon/src/mcp/dispatch.ts`: ToolRegistry centralizes audit-write across success/handler-exception/validation-failure paths; three typed errors
  - `packages/daemon/src/mcp/tools/ping.ts`: first registered tool; imports PingInputSchema from shared (zod-schema-validation rule 1)
  - AsyncLocalStorage for per-request context plumbing (request_id, remote_addr) through SDK handlers
  - Two design adjustments: zod-to-json-schema → z.toJSONSchema() (zod v4 built-in); stateless → stateful transport (SDK v1.29 bug)
  - patterns/project/safe-narrow-of-unknown-shape.md created at draft (no second instance yet)
  - 6 reactive lint fixes (all justified at config or fix-site)
  - 24 new daemon tests; 122 cases total across 15 test files (passing) + 4 platform-skipped
  - 8th consecutive zero-fire on async-discipline rules for production code
- **T-0010** — MCP auth middleware (CONFIRMED 2026-05-22; commit 4a13e06)
  - AC-4 IMPLEMENTED (verification at T-0019 end-to-end)
  - `packages/daemon/src/mcp/auth.ts`: pure authenticate() with discriminated AuthResult (missing_header / malformed_header / invalid_token)
  - `packages/daemon/src/mcp/server.ts`: 401-no-body on failure + tool:"<auth>" sentinel audit entry with input_hash:"sha256:n/a"
  - constant-time-compare.md FIRST AC-blocking exercise
  - getExpectedToken thunk shape supports future T-0017 token rotation
  - 1 reactive lint fix: Array.isArray's any-cascade under recommendedTypeChecked → unknown+typeof helper pattern (carried to T-0011 as new pattern doc)
  - 13 new daemon tests; 102 cases total across 13 test files
  - 7th consecutive zero-fire on async-discipline rules; type-safety rules continue earning
- **T-0009** — MCP server skeleton + HTTP transport + promise utility (CONFIRMED 2026-05-22; commit 7d78f91)
  - All 19 gate-blocking AC passed; two reactive fixes (production-source `no-base-to-string`; tooling `maximumDefaultProjectFileMatchCount` raised to 50)
  - `packages/daemon/src/util/promises.ts`: promisifyCallback + onceOrError (infrastructure for new code; existing T-0007/T-0008 sites unchanged)
  - `packages/daemon/src/mcp/server.ts`: McpServer skeleton against @modelcontextprotocol/sdk v1.29; StreamableHTTPServerTransport in stateless mode; capabilities `tools: {}` (empty)
  - 127.0.0.1 local bind by design; no auth (T-0010) or tools (T-0011) yet
  - npm install: 0 new advisories from SDK chain (84 packages added)
  - 13 new daemon tests (7 promises + 6 mcp server)
  - 6th consecutive zero-fire on `no-floating-promises` / `no-misused-promises` for production code
  - 93 cases total across 12 test files (89 passing + 4 platform-skipped)
  - Deferred decision recorded: at P0 gate close, evaluate `tsconfig.test.json` refactor to retire the file-count-cap workaround
- **T-0008** — Daemon IPC server + Q005 closure (CONFIRMED 2026-05-22; commit 9bee9c5)
  - All 18 gate-blocking AC passed; one reactive ESLint test-file override for unbound-method (mock-matcher edge case)
  - `packages/daemon/src/ipc/{protocol,server}.ts`: newline-delimited JSON IPC; cross-platform Unix socket / Windows named pipe; stale-socket cleanup via connect-probe; EADDRINUSE → IpcSocketBusyError
  - Q005 CLOSED via layered protection (PID file at T-0013 + Unix connect-probe + Windows EADDRINUSE)
  - 12 new daemon cases; Windows-side Q005 first-hand verified (11.l ran on this host); Unix-side deferred to Unix CI
  - 5th consecutive zero-fire on `recommendedTypeChecked` for production code
  - `packages/daemon/src/audit/hash.ts` header extended with JSON-native assumption note (carried from T-0007)
  - 80 cases total across 10 test files (76 passing + 4 platform-skipped)
- **T-0007** — Daemon audit log + Q003 closure + sink-queue pattern (CONFIRMED 2026-05-22; commit 17b30d4)
  - All 16 gate-blocking AC passed; zero reactive deviations
  - `packages/daemon/src/audit/{hash,log}.ts`: hashInput with recursive canonicalization; AuditLog with queued writes, hybrid midnight-timer + per-append-guardrail rotation, idempotent stop()
  - `append()` returns flushed Promise (departure from logger's void return)
  - Per-append date check inside queue handler (race fix documented as anti-example in new pattern doc)
  - `patterns/project/async-sink-queue.md` created at status `active` (codifies logger + audit-log shared shape)
  - Q003 CLOSED via hybrid resolution
  - conventions.md: ESLint glob maintenance note + temp-file test pattern
  - milestones.md: AC-9 → IMPLEMENTED (Unix runtime verification pending)
  - 16 new daemon tests; 66 total passing
  - `recommendedTypeChecked` 4th consecutive zero-fire on async code — rule set declared validated
- **T-0006** — Daemon config layer (paths, load, init, token) (CONFIRMED 2026-05-21; commit ca6ae92)
  - All 19 gate-blocking AC passed
  - `packages/daemon/src/config/{paths,token,load,init}.ts` — full surface for T-0013 wiring and T-0015 CLI start
  - `loadConfig` implements **AC-9** from `01-p0-bus.md` (mode-0600 enforcement on Unix) — first P0 acceptance criterion implemented
  - Q002 CLOSED via hand-rolled RFC 4648 base32 encoder (~25 lines, no dep, no modulo bias)
  - `constant-time-compare.md` promoted draft → active
  - `ConfigAlreadyExistsError` introduced for T-0015's first-run vs already-initialized distinction
  - 22 new daemon tests (20 run + 2 platform-skipped on Windows)
  - One reactive: ESLint allowDefaultProject glob widened by one level for `tests/<subdir>/*.test.ts`
- **T-0005** — Daemon logger + carried fixes + pattern promotion (CONFIRMED 2026-05-21; commit 4e74331)
  - All 14 gate-blocking AC passed; second consecutive zero-deviation task
  - `packages/daemon/src/log/logger.ts`: Promise-chain queue (CC-1), lazy file-handle open, idempotent close()
  - `packages/daemon/tests/logger.test.ts`: 6 cases (4.a–4.f)
  - Daemon tsconfig transition (second instance of lifecycle pattern)
  - `packages/shared/src/ipc.ts`: `daemon_uptime_s` tightened to `.int().nonnegative()` (carried from T-0004 verdict)
  - `patterns/project/test-token-fixtures.md` created at status `active` (two prior instances + one anticipated)
  - `recommendedTypeChecked` ran clean on first real async code — calibration signal validated
  - 30 tests total across 4 files
- **T-0004** — Remaining shared contracts: audit, ipc, tools (CONFIRMED 2026-05-21; commit 2a516f7)
  - All 11 gate-blocking AC passed; **zero reactive deviations** (first such task)
  - `packages/shared/src/audit.ts` (AuditEntry interface — no trust boundary)
  - `packages/shared/src/ipc.ts` (IpcRequestSchema + IpcResponseSchema as discriminated unions with .strict() per variant; StatusPayloadSchema; trust boundary)
  - `packages/shared/src/tools.ts` (PingInputSchema schema + PingOutput interface)
  - `packages/shared/src/index.ts` extended to re-export all four modules
  - 19 new tests across 2 files (24 total in shared)
  - `packages/shared` feature-complete for P0
  - Carried forward: `daemon_uptime_s` schema tighten + "inert conforming tokens" pattern promotion → T-0005
- **T-0003** — Config schema in @claude-bridge/shared (CONFIRMED 2026-05-21; commit 74b853e)
  - All 13 gate-blocking AC passed; first impl: commit on the project
  - `packages/shared/src/config.ts` (ConfigSchema with .strict() at trust boundary) + index.ts re-export
  - Five-case test suite (happy, defaults, missing required, malformed token, strict rejection)
  - ESLint flat config wired (eslint v10, typescript-eslint v8, recommendedTypeChecked); Q001 CLOSED
  - Vitest defaults sufficient for NodeNext-ESM (no config file needed)
  - Reactive fixes: zod resolved to v4 (works as-spec); `allowDefaultProject` glob narrowed from `**` to `*.test.ts` per typescript-eslint v8 perf rule
  - Patterns `node-esm-imports.md` and `zod-schema-validation.md` promoted draft → active
- **T-0002.5** — Line-ending hygiene + T-0002 closure docs (CONFIRMED 2026-05-21; commit 6490ed7)
  - `.gitattributes` created at repo root; `* text=auto eol=lf` + per-extension explicits + binary list
  - `git add --renormalize .` confirmed index never held CRLF (bug was prospective)
  - Boundary test (re-stage T-0001-era file) produces zero LF/CRLF warning — load-bearing AC passed
  - Three doc edits applied per spec; open-questions.md confirmed no-change needed
  - First task using doc-edit-delta dispatch protocol — worked cleanly
- **T-0002** — Package skeletons (CONFIRMED 2026-05-21; commit e0bf6c9)
  - All 9 gate-blocking AC passed
  - Three workspace packages (`@claude-bridge/{shared,daemon,cli}`) with TS project references
  - Reactive design: empty-input form switched from `include: []` to `files: []` after the former triggered TS18003 — both were valid in the prompt
  - cli references shared only (NOT daemon) — runtime spawn dep ≠ TS project reference; design held
  - npm install: +3 packages (workspace symlinks); audit unchanged at 4 moderate
  - `node-esm-imports.md` stays at `draft`; promotes at T-0003 first-import use
- **T-0001** — Initialize workspace root (CONFIRMED 2026-05-21; commit 9fffba0)
  - All 8 gate-blocking AC passed
  - Files produced: `package.json`, `tsconfig.base.json`, `.gitignore`, `.editorconfig`, `.nvmrc`, `README.md`
  - Verified: `npm install` clean (126 packages, 4 moderate dev-only advisories below threshold); Node v24.10.0 ≥ v20.10.0 floor
  - Deviations from AC minimum (all reasoned and accepted): `engines` field added; 4 extra `.gitignore` entries (coverage/, *.log, .env*); 4 extra `tsconfig.base.json` options (lib, forceConsistentCasingInFileNames, resolveJsonModule, declaration triplet)
  - Q006 closed inline (vitest ^1.4.0)
  - Standing advisory registered in `conventions.md` §Dev-dependency audit policy
- **Day-zero** — Methodology infrastructure (committed 2026-05-21; commit fff652e)

### Failed / awaiting resolution
(none)

## Completed work manifest

| File | Task | Notes |
|------|------|-------|
| `package.json` | T-0001 | npm workspaces, devDeps pinned, `engines: { node: ">=20.10" }` |
| `tsconfig.base.json` | T-0001 | NodeNext, strict, composite-ready (declaration triplet at base) |
| `.gitignore` | T-0001 | 9 entries (5 required, 4 reasoned additions) |
| `.editorconfig` | T-0001 | utf-8, lf, 2-space TS/JSON/MD |
| `.nvmrc` | T-0001 | `20` |
| `README.md` | T-0001 | Real description + links to design docs |

## Pattern library cross-references

Project-specific patterns in `patterns/project/`. Status as of last conversation:

| Pattern | Status | First-use target | Notes |
|---------|--------|------------------|-------|
| `node-esm-imports.md` | **active** | promoted at T-0003 | Rules exercised in shared's src + tests; build/lint/test clean |
| `zod-schema-validation.md` | **active** | promoted at T-0003 | ConfigSchema implements .strict() at trust boundary; test suite verifies pattern application |
| `constant-time-compare.md` | **active** | promoted at T-0006 | Used by `packages/daemon/src/config/token.ts` `constantTimeEqual` |
| `test-token-fixtures.md` | **active** | created at T-0005 (codifies pattern observed in T-0003 + T-0004) | Inert conforming strings for token-format test fixtures; CC-4 corollary |
| `async-sink-queue.md` | **active** | created at T-0007 (codifies pattern observed in T-0005 logger + T-0007 audit log) | Queue + lazy handle + idempotent close shape; departure point is whether per-call API returns void or flushed Promise |
| `safe-narrow-of-unknown-shape.md` | draft (created at T-0011) | Codifies T-0010's Array.isArray pitfall; awaiting second instance for promotion to active | Promote to active if T-0011 produces a second instance (it did not; stays draft) |
| `line-buffered-stream-reader.md` | **active** | created at T-0012 (codifies pattern observed in T-0008 IPC server + T-0012 cloudflared stdout/stderr) | Accumulate-and-split shape; two confirmed instances at promotion |

Promotion from `draft` to `active` happens at orchestrator review after first real use.

## Open issues

See `open-questions.md`.

Recent activity (this conversation):
- **Q001 CLOSED** — ESLint flat config with typescript-eslint v8+ and `recommendedTypeChecked` ruleset; `eslint.config.js` at repo root; `projectService: true` for monorepo discovery (closed at T-0003).
- **Q006 CLOSED** — vitest ^1.4.0 with standing-advisory tracking (decided 2026-05-21).
- **Q001 OPEN** — closure target moved from "T-0001 or T-0002" → T-0003 (no source files to lint until then; adding ESLint to scaffolding-only tasks is busywork).
- Q002, Q003, Q004, Q005 unchanged.

## Calibration findings (rolling)

Findings from completed tasks that inform future task design:

**From T-0001:**
- §3.5.1 report format works well for mechanical config tasks; the structured summary is sufficient evidence and verbatim file content is NOT required for AC verification of config-class files.
- For T-0003+ (source files with meaningful degrees of freedom), verbatim diffs in the report ARE required per §8.2. T-0002 prompt's reporting section will start enforcing this for tsconfig files (config but with meaningful freedom).
- "Executor extends slightly beyond AC minimum, with reasoning" is acceptable when each addition is small, defensive, and explicitly justified in REASONING. Track whether this scales — if it grows, tighten scope statements.
- Dev-dependency audit advisories will surface again on `npm install` and at every dep-adding task. Codified handling in `conventions.md` §Dev-dependency audit policy.

**From T-0002:**
- Anticipatory risk flagging works. The prompt named TS18003 as a known risk with valid alternative forms upfront; executor hit it, used the documented alternative, zero revision rounds. **Pattern for future prompts:** when multiple valid forms exist for a config choice, the prompt names them all rather than picking one — converts a likely revision into one-shot success.
- Verbatim-tsconfig + summarized-package.json reporting cadence works. Continue for source-class config files.
- Executor self-throttled on new pattern candidate (proposed lightweight form, deferred call to orchestrator). Good restraint to preserve.

**From T-0002 closure (post-commit, surfaced during git add):**
- `.editorconfig` without `.gitattributes` is a real cross-platform bug on Windows hosts. T-0001's prompt scope and AC both missed it. Two methodology lessons:
  - When conventions span tool boundaries (editorconfig governs editors; gitattributes governs git), AC for either tool alone is insufficient. Verification must touch the boundary: e.g., "`git add <file>` produces no LF/CRLF warning."
  - CC-2 (cross-platform concerns) extends to line endings, not just paths. Conventions doc updated at T-0002.5.
- Out-of-sequence task numbering: T-0002.5 used. Mid-decimal IDs reserved for "inserted between" semantics; T-NNNN integer IDs stay aligned to build plan sections. No methodology revision needed; this convention is self-explanatory.
- Process refinement: the orchestrator was producing full new doc files each task. Switched to delta instructions in the executor prompt — the executor edits in place, one new file per dispatch (the prompt itself).

**From T-0002.5:**
- Doc-edit-delta dispatch protocol works. Verbatim before/after strings in the prompt made the Edit-tool operations mechanical. Explicit "no edits expected here" sections (AC-7 for open-questions.md) prevent drift-by-omission.
- Watched item, not yet codified: if a doc drifts between prompt-authoring and prompt-execution, an Edit-tool delta would fail on a missing `old_string`. Mitigation that worked: executor reads target files before applying edits. Promote to methodology rule only if this bites us empirically.
- "Prospective vs retroactive" framing for warnings: distinguish between "the bad thing already happened" (retroactive) vs "the bad thing will happen later if you don't intervene" (prospective). T-0002.5's LF/CRLF warnings were prospective. Useful diagnostic frame when interpreting any verification warning.

**From T-0003:**
- Anticipatory risk flagging continues to work. Prompt named zod v3/v4 drift, vitest config sufficiency, and typescript-eslint version sensitivity as likely-failure-modes; two hit (zod v4, typescript-eslint glob), both fixed in one iteration each because the failure modes were named in advance.
- Orchestrator-side error caught by executor: the prompt's eslint.config.js template used the same `**` glob in both `files:` (ESLint matcher, allowed) and `allowDefaultProject:` (parserOption, disallowed). Lesson: when a prompt template includes config shared across tool boundaries, check that the same patterns are valid in every place they appear. Adding to orchestrator checklist for config-heavy prompts.
- Verbatim source-file reporting at the right cadence. Verbatim config.ts, index.ts, config.test.ts, eslint.config.js; summarized everything else. Verification was complete from the report alone; no round-tripping needed.

**From T-0004:**
- First zero-deviation task. Prompts that name design choices explicitly (the schemas-vs-interfaces table) and leave structure flexibility (it.each as suggestion not mandate) produce clean executions when the toolchain is settled.
- `recommendedTypeChecked` lint rules caught nothing for the second consecutive task — expected at the contract layer (no async, no unsafe patterns). Watch signal for T-0005 onward: first async code will be the real test of whether the rule set earns its cost or whether we're paying for unused enforcement.
- Pattern promotion threshold validated: "inert conforming token strings" reached two confirmed instances (T-0003 + T-0004) — promoted to a proper pattern doc at T-0005 (with status `active`, not `draft`, because two instances already exist).

**From T-0005:**
- Two consecutive zero-deviation tasks (T-0004, T-0005). As patterns become active and the toolchain settles, the compounding effect makes well-bounded tasks one-shot.
- `recommendedTypeChecked` validated on first real async code: zero fires, zero noise, queue/catch/void-method discipline all caught preventively. Continue with confidence; watch T-0006 onward for the second affirmative data point.
- Pattern promotion threshold (two confirmed instances) worked for `test-token-fixtures.md` — created at status `active` rather than going through a `draft` phase since the prior use already validated the rule. Methodology's "promotion happens after first confirmed use" generalizes to "creation at `active` is fine when use already precedes the doc."
- Two new pattern candidates flagged: "Async sink queue discipline" (await T-0007's audit log for second instance) and "Temp file lifecycle in tests" (await T-0006/T-0007 for second/third instances; promote to conventions.md note if it recurs).

**From T-0006:**
- First P0 acceptance criterion implemented: AC-9 mode-0600 enforcement lives in `loadConfig`. Implementation verifiable; verification platform-specific (Unix-only). Added to INT-1 blocker list as "verified-on-Unix-CI" pending.
- Three consecutive zero-deviation source tasks (T-0004, T-0005, T-0006). The one reactive deviation in T-0006 was tooling config (ESLint glob), not source.
- `recommendedTypeChecked` second affirmative on real async code (config layer's loadConfig/initConfig). Third data point at T-0007.
- ESLint `allowDefaultProject` glob is a maintenance lever as test-tree structure evolves. Documented as a maintenance pattern in conventions.md to remove the surprise next time it surfaces.

**From T-0007:**
- `recommendedTypeChecked` validated: 4 consecutive zero-fire runs on real async code, including this task's deferred-resolve Promise machinery and IIFE-wrapped setTimeout callbacks. T-0008+ uses the rule set without further evaluation.
- Pattern doc creation from real implementation experience: `async-sink-queue.md` was created at status `active` AND includes an anti-example drawn from a race the executor caught and fixed during T-0007 itself. The methodology working as intended: docs absorb real lessons.
- Reporting cadence calibration: the executor summarized the ~200-line `log.ts` rather than pasting verbatim. Acceptable for T-0007 because REASONING covered the load-bearing choices, but tightening for T-0008: server.ts is safety-relevant (request dispatch, error envelope), so verbatim required.
- Q003 closure validates the "tentative resolution becomes implementation" lifecycle: Q-item opened with tentative resolution → became implementation at T-0007 with no surprises. The Q lifecycle is working.

**Orchestrator self-correction (2026-05-22):**
- The orchestrator was using a fixed date (2026-05-21) on dated entries in project-state, Q-item closures, and pattern docs starting from T-0001 closure onward. The actual current date drifted past 5/21 to 5/22 mid-execution but the dates didn't update — confirmation bias on a value already present in project files.
- **Correction going forward:** every dated entry uses today's actual date as read from the orchestrator's environment context. Existing entries in committed files stay as-is (methodology §22.6 forbids amending pushed commits, and the historical record is part of the audit trail even when wrong by one day).
- Not a methodology defect; an orchestrator-discipline drift. The lesson generalizes: any value the orchestrator can re-read fresh from environment context (date, time, available tools, system state) should be re-read each turn, not anchored to a previously-observed value.

**From T-0008:**
- 5 consecutive zero-fire `recommendedTypeChecked` runs on production code. Single fire in T-0008 was test-only (vitest matcher passing method reference to `expect(...).toHaveBeenCalledOnce()`); resolved at config level with sound justification.
- Tooling-config reactive deviations are the new normal as the test surface grows. Two now (T-0006 glob widening, T-0008 test-file rule override). Both config-level, both justified. Source code itself stays at zero deviations for four consecutive tasks (T-0005, T-0007, T-0008, plus T-0004).
- Verbatim discipline for safety-relevant source files validated: server.ts paste-verbatim allowed direct verification of event-handler discipline. Continue for T-0009 mcp/server.ts.
- Deferred-resolve Promise shape now at five instances across two tasks. Decision: extract to a small `util/promises.ts` utility (T-0009 deliverable) for new code; do NOT refactor existing sites. Refactor-for-refactor's-sake violates the methodology's "do exactly what was asked" disposition.

**From T-0009:**
- `recommendedTypeChecked` continues earning, in a new way: 6 consecutive tasks without `no-floating-promises` / `no-misused-promises` fires on production code; T-0009 fired on `no-base-to-string` which caught a real diagnostic-quality concern (`String(unknown)` producing `[object Object]`). Rule pack's value isn't single-shaped — catches bug patterns AND quality patterns.
- Tooling-config reactive deviations normalized: three now (T-0006 glob; T-0008 test override; T-0009 file-count cap). All config-level, all justified. The growing-test-surface causing config evolution is predictable, not regressive.
- Documentation-first triggers worked for MCP SDK: executor verified the SDK API surface against installed types before writing code. Build plan sketch matched closely; no large deviations. The discipline succeeded preventively.
- Promise utility extracted cleanly: first consumers (start/stop in mcp/server.ts) used both helpers naturally. The deferred-resolve family captured infrastructure-side; no pattern doc needed.
- Deferred decision recorded: at P0 → P1 transition, evaluate splitting tests into their own tsconfig to retire the file-count-cap workaround. Not actioning now.

**From T-0010:**
- AC-4 IMPLEMENTED. `constant-time-compare.md` earns its first AC-blocking exercise — four-task gap between pattern pre-population (T-0001) and first AC-binding use (T-0010) validates the pre-populate-then-discover rhythm: the pattern was ready when the security boundary needed it.
- `recommendedTypeChecked` delivers TWO distinct value streams. Async discipline rules deliver preventively (code design naturally avoids those bugs across 7 tasks); type-safety rules deliver reactively (catches no-base-to-string, unbound-method, no-unsafe-*-cascade). Rule pack value is not single-shaped.
- Array.isArray pitfall codified: under `recommendedTypeChecked`, `Array.isArray`'s built-in predicate `arg is any[]` collapses narrowing to any. Workaround pattern (unknown + typeof + re-narrow) is recorded in `safe-narrow-of-unknown-shape.md` at status draft.
- Audit-on-rejection-only is the right scope decision. T-0010's 15.j cleanly verifies that successful requests produce no `<auth>` entry; T-0011 layers per-tool audit on top. Two audit layers compose naturally without schema stress on AuditEntry.

**From T-0011:**
- AC-3 AND AC-5 close at the implementation layer; build plan §4.1 complete. MCP server slice is feature-complete for P0.
- Pre-add-dep verification discipline: verify capabilities aren't already in installed deps before adding. Codified in conventions.md at T-0012.
- SDK behavior verified via SDK's own integration tests can still surprise in client interop (stateless transport's bug at v1.29). Documentation-first reduces risk but doesn't eliminate it.
- `recommendedTypeChecked` continues earning across both value streams: 8 consecutive zero-fires on production async-discipline; 6 reactive fires on type/style rules catching real concerns.
- request_id format inconsistency between auth (`req_<8hex>`) and dispatch (UUID). Track for future cleanup pass; not actioning now.
- "Sync handlers satisfying Promise-returning interfaces use Promise.resolve, not async" — three instances in T-0011 (pingTool, echoTool, explodeTool); codified in conventions.md at T-0012.

**From T-0012:**
- AC-6 IMPLEMENTED. Build plan §5 complete. The tunnel manager's sliding-window restart policy + 15s start timeout cover both the AC-6 respawn semantic and the user-facing "cloudflared not installed / can't reach network" failure mode.
- Line-buffered-stream-reader codified at two instances. The candidate pattern from T-0008 reached its second instance in T-0012; pattern doc created at status active.
- FakeProcess subclass pattern for testing subprocess wrappers worked cleanly. EventEmitter typed-override pattern composable across CloudflaredProcess and TunnelManager. The `listener as never` cast for super calls is the right knob; no recommendedTypeChecked friction.
- Microtask-flush test technique (`await new Promise(r => setImmediate(r))`) needed once for the restart-in-non-degraded-state case. Worth flagging if it recurs in T-0013's main.test.ts.

**From T-0015:**
- Detached-spawn pattern leaves the daemon writing to a half-closed pipe after the CLI's `unref()` + pipe destroy. Daemon-side EPIPE handler on stdout/stderr was the right carry; without it the daemon dies on first log write after CLI exit. Single line in main.ts; the failure mode is cross-cutting (any future detached-spawn entrypoint hits the same thing), so the handler stays in main.ts as infrastructure rather than at any specific call site.

## Calibration phase closure

Calibration phase closed at T-0013 per methodology §25.3. The first 13 tasks (T-0001 through T-0013) ran with full prompt detail, comprehensive verbatim reporting, and per-task human-gate confirmations. The toolchain (TypeScript, ESLint with recommendedTypeChecked, vitest, conventions, patterns) is settled. Steady-state operating mode in effect from T-0014: lighter prompts, paragraph verdicts, summary reports except for safety-relevant files explicitly named.

## Smoke-test findings (post-T-0013, pre-T-0014)

Captured 2026-05-22. Hand-tested daemon end-to-end via MCP Inspector after T-0013 closed. Findings:

- **SMOKE-1**: AC-3 and AC-5 functionally validated end-to-end. Milestones doc updated to mark both VERIFIED (IMPLEMENTED → VERIFIED with smoke-test reference in Verified-At column).
- **SMOKE-2**: Claude.ai's custom MCP connector UI restricts auth to OAuth client id/secret only — no Bearer token field. **Scope-affecting:** the literal AC-3 wording ("from a Claude.ai project") cannot be satisfied via the connector UI with our current static-Bearer-token design. Functional satisfaction comes through MCP Inspector, Claude Code (`claude mcp add --transport http`), Claude Desktop, and raw HTTP clients — all accept Bearer tokens. The connector UI is the outlier, not our design. P1+ design decision: implement OAuth in the daemon, document the alternative-client workaround, or both.
- **SMOKE-3**: Clean SIGINT shutdown validated end-to-end. Reverse-instantiation sequence completed in 14ms total (IPC 0ms → MCP 2ms → tunnel 10ms → audit 1ms → logger). Well under the 10s budget. AC-7 functionally validated (the CLI-side `claude-bridge stop` at T-0016 will trigger the same shutdown via IPC rather than signal).
- **SMOKE-4**: T-0019 acceptance script implications. Driving an MCP handshake against the live daemon will need either (a) programmatic MCP Inspector invocation (brittle) or (b) raw curl with manual JSON-RPC (more code, fewer deps). T-0019 design will weigh these.
- **SMOKE-5**: Audit log accumulated ~33 failed-auth entries from MCP Inspector's session-setup probes (mix of missing_header and malformed_header). AC-4's audit-on-rejection mechanism scaled correctly under burst.

## Handoff notes

**P0 GATE-CLOSED 2026-05-23.** All 10 ACs VERIFIED. 23 commits across roughly 2.5 weeks calendar time (T-0001 through T-0020 plus T-0002.5 + T-0019.5 + T-0019.6 + T-0019.7). The methodology held: pre-populate-then-discover patterns, §3.5.1 reporting cadence, steady-state operating mode after T-0014, insert tasks at the .5/.6/.7 nomenclature, and `recommendedTypeChecked` rule pack delivering on both async-discipline (preventive) and type-safety (reactive) value streams.

**P1 design conversation is the next step.** Resume in the orchestrator conversation's saved context; this repo currently has no `docs/snapshots/` directory — snapshot artifacts live in the orchestrator's storage. The natural P1 scope is headless delegation (job queue + result streaming) per `docs/design/00-overview.md` §"Gate sequence". Carry items for P1:

1. **Build the acceptance harness early** — T-0019 exposed three source bugs that unit tests didn't catch (CLI ready timeout vs daemon tunnel budget; ms-granularity duration_ms; DNS resolution chain for fetch). P1 should start its harness early, not last.
2. **Cross-platform discipline is a continuous tax** — three platform-specific findings codified during P0 (line endings T-0002.5; Windows IPC pipe name T-0008; Windows file-handle trap + windowsHide T-0019.5). P1's job queue + result streaming will likely surface more, especially around process group / signal propagation on Windows.
3. **TS type resolution for `@modelcontextprotocol/sdk/types.js` on Node 20 + WSL** — flagged in T-0019.6 as TS7016/TS7006 build noise (JS output complete; runtime unaffected). Worth resolving cleanly in P1 if the SDK surface keeps growing.
4. **AC-10 natural confirmation** — first midnight-crossing daemon run during P1 will naturally validate the audit log rotation. Watch for `audit-YYYY-MM-DD.jsonl` files in `~/.claude-bridge/`. No instrumented test needed; the unit tests already cover the mechanism.

The `~/claude-bridge-wsl` working copy and `~/node-v20` + `~/cloudflared` user-local binaries in WSL are left in place for any future Unix-side verification (P1's job queue, AC-10 midnight observation, etc.).

## Final P0 calibration summary

After 22 commits across 19 tasks (T-0001 through T-0020 plus T-0002.5 and T-0019.5):

### Timing data (from T-0018 onward — earlier tasks predate the standing-requirement instrument)

| Task | Bucket | Predicted | Actual | Notes |
|---|---|---|---|---|
| T-0018 | trivial | — | 0:05 | Bin entry + version flag; manual smoke; verify-install script |
| T-0019 | medium | 60-90 min | 1:00 | Acceptance harness + live run; 3 source bugs surfaced and fixed; 3 PowerShell-side iterations |
| T-0019.5 | trivial | T-0018 size | 0:05 | One-line + convention bullet |
| T-0020 | medium (prose) | 60-90 min | 0:06 | Two user-facing docs; no code changes. Came in well under prediction because cached context (SMOKE-2, DNS, file-handle trap, schema field semantics) was already in mind from T-0019 / T-0019.5 — no fresh discovery pass needed. |

### Prediction bands (forward)

- **Trivial:** 5-10 min — one-line fix or small mechanical addition with clear AC and no integration surface
- **Small:** 15-30 min — single command/module + small test suite, established patterns
- **Medium:** 60-90 min — new component with integration surface, or doc-heavy task; may surface bugs that need triage
- **Large:** 90-180 min — multiple modules, new patterns, or unfamiliar integration

The T-0019 hit-the-low-end-of-band finding (60 min for a medium task) calibrates against having a settled toolchain + established patterns; new patterns or unfamiliar SDKs push toward the upper bound. The T-0020 finding (6 min for a "medium prose" task) calibrates a sub-bucket: **doc tasks that consolidate already-discovered findings ship much faster than the medium band suggests** — closer to trivial. Doc tasks that require fresh discovery (reading docs, learning new APIs) stay in the medium band.

### Methodology findings worth keeping

1. **Pre-populate-then-discover pattern docs.** Pattern documents created BEFORE first use validated the rhythm: when the security boundary needed `constant-time-compare`, the doc was ready. Carry forward into P1.
2. **§3.5.1 reporting cadence.** Verbatim for safety-relevant source files; summary for everything else. Worked across all 19 tasks. Verbatim discipline was load-bearing on auth, audit, IPC; summary discipline kept the report-vs-work ratio sustainable.
3. **Steady-state operating mode** (active from T-0014). Lighter prompts, paragraph verdicts, summary reports — the prompts shrunk by ~50% from T-0014 onward without loss of clarity. Continue into P1.
4. **Insert tasks (`T-NNNN.5`).** Used twice (T-0002.5 line-ending hygiene; T-0019.5 windowsHide). Single-purpose closure-after-discovery; valuable for keeping the build-plan task IDs aligned to the build-plan sections.
5. **`recommendedTypeChecked` value.** 17 consecutive zero-fires on async-discipline rules for production code; ~12 reactive fires on type-safety rules catching real issues. Rule pack value is not single-shaped — both async-discipline (preventive) and type-safety (reactive-but-real) streams justify the cost.

### Findings to apply at P1

1. **Acceptance harness is the gate test.** T-0019's harness exposed three source bugs that unit tests didn't catch (`READY_TIMEOUT_MS` racing the daemon's tunnel budget; `duration_ms` ms-granularity; DNS resolution chain for fetch). P1 should build its acceptance harness early, not last.
2. **Cross-platform discipline (CC-2) is a continuous tax.** Three platform-specific findings codified during P0 (line endings T-0002.5; Windows IPC pipe name T-0008; Windows file-handle trap + windowsHide T-0019.5). P1's job queue + result streaming may surface more.
3. **Smoke-vs-mechanical verification gap.** SMOKE-2 (Claude.ai connector UI's OAuth-only constraint) was a smoke-test discovery that the mechanical acceptance harness doesn't capture. P1 design should consider what's verifiable mechanically vs requires interactive smoke and bias toward mechanical where possible.

T-0019 produced a full end-to-end acceptance harness at `scripts/acceptance-p0.ps1` (10 steps; 8 verified mechanically, 2 skipped with notes). The harness uses `scripts/mcp-ping-client.mjs` (an `@modelcontextprotocol/sdk` Node helper) to drive MCP roundtrips. Final live run: AC-1 cold-start in 7.6s (under 10s budget); all PASS through AC-8; AC-9 + AC-10 skipped with documented reasons.

**Three reactive fixes from T-0019:**
1. `packages/cli/src/commands/start.ts` — `READY_TIMEOUT_MS` raised 5s → 15s to match daemon's TunnelManager budget. Cold-start cloudflared can easily exceed 5s; the CLI's old default would spuriously fail valid scenarios.
2. `packages/daemon/src/mcp/dispatch.ts` — switched `Date.now()` → `performance.now()` + `Math.ceil` for `duration_ms`. `Date.now()` has 1ms granularity; sub-ms tools (e.g. ping) rounded to 0 which violated AC-5's "non-zero duration_ms" requirement.
3. `scripts/mcp-ping-client.mjs` — installed `undici` as a dev-dep and set a global dispatcher that resolves via `dns.resolve4` (c-ares) against Cloudflare/Google public resolvers. The host's system DNS returned NXDOMAIN for newly-issued `*.trycloudflare.com` subdomains; `dns.setServers()` alone doesn't affect `dns.lookup()` (which fetch uses). The custom dispatcher's `connect.lookup` honors `options.all` per net.connect's polymorphic contract.

**Install-and-run procedure (dev):**

    From the repo root:
      npm install
      npm run build
      cd packages/cli && npm link

Then `claude-bridge --help` from any directory. To unlink: `npm unlink -g @claude-bridge/cli`. To run the gate: `pwsh scripts/acceptance-p0.ps1` (or `powershell -ExecutionPolicy Bypass -File` on 5.1 hosts).

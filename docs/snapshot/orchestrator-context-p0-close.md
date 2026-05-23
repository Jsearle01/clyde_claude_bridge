# claude-bridge — Orchestrator Context Snapshot (P0 GATE-CLOSED)

**Date:** 2026-05-23
**Project:** claude-bridge
**Phase:** P0 (Bus Validation) — **GATE-CLOSED**
**Next phase:** P1 (Headless delegation) — design conversation pending
**Methodology:** v0.3 (steady-state mode since T-0014)
**Conversation role:** Orchestrator (Claude.ai, project chat)
**Counterpart:** Executor is Clyde (Claude Code) in the local repo

---

## P0 status

**GATE-CLOSED.** All 10 acceptance criteria at VERIFIED status.

**Commits:** 22 (T-0001 through T-0020 plus three insert tasks: T-0002.5, T-0019.5, T-0019.6, plus the P0 gate-close docs commit).

**Test state:** 193 tests passing + 6 platform-skipped across 26 files. Build/lint/test clean across all three workspaces (shared, daemon, cli).

**Calendar:** ~2.5 weeks (early May 2026 → 2026-05-23). Active Clyde-time across all tasks was a small fraction of that.

## What P0 produced

- Long-lived daemon hosting an MCP HTTP endpoint at `127.0.0.1:7423`
- Cloudflared tunnel providing public HTTPS URL via `*.trycloudflare.com`
- Bearer-token auth (`cb_live_<base32>`) with constant-time compare and rotation support
- Per-tool dispatch with audit logging (currently just `ping`)
- CLI surface: `start` / `stop` / `status` / `tail-log [-f]` / `token rotate` / `tunnel restart` / `--version` / `--help`
- Cross-platform: Windows verified primary; WSL Ubuntu verified for AC-9
- Reproducible acceptance harness (`scripts/acceptance-p0.ps1` + `scripts/mcp-ping-client.mjs`)
- User-facing documentation (`README.md` + `docs/runbook.md`)
- Design docs unchanged from before P0 started (per §17.3 write-once discipline)

## What P0 proved

The bus works end-to-end. A caller using any MCP client that supports Bearer auth can reach a tool running on the local machine via cloudflared tunnel, with auth, dispatch, audit, lifecycle, and shutdown layers all functioning as designed.

## Final AC status

| AC | Description | Status | Evidence |
|----|-------------|--------|----------|
| AC-1 | start <10s, prints URL/token | VERIFIED | T-0019 cold-start 7.6s |
| AC-2 | status reports daemon + tunnel up | VERIFIED | T-0019 mechanical |
| AC-3 | ping roundtrip returns echo | VERIFIED | T-0019 via MCP SDK (SMOKE-2 caveat) |
| AC-4 | wrong token → 401 + audit | VERIFIED | T-0019 + 33 audit-fail entries |
| AC-5 | successful ping audit entry | VERIFIED | T-0019; dispatch.ts duration_ms fix |
| AC-6 | cloudflared kill → respawn <30s | VERIFIED | T-0019 live PID kill on Windows |
| AC-7 | clean stop | VERIFIED | T-0019 stop + PID-removed assertion |
| AC-8 | token rotate → old invalid | VERIFIED | T-0019 full chain (closure → config → auth) |
| AC-9 | refuse 0600-loose start | VERIFIED | T-0019.6 WSL Ubuntu |
| AC-10 | midnight rotation | VERIFIED (MANUAL-VERIFIED-AT-GATE) | T-0007 unit-tested; gate-accepted 2026-05-23 |

## Open questions status

| Q-item | State | Notes |
|--------|-------|-------|
| Q001 | CLOSED 2026-05-21 | ESLint flat config + typescript-eslint v8 + recommendedTypeChecked |
| Q002 | CLOSED 2026-05-21 | Hand-rolled RFC 4648 base32, no dep |
| Q003 | CLOSED 2026-05-21 | Hybrid midnight timer + per-append date guardrail |
| Q004 | DEFERRED → P3 | Token rotation UX (Claude.ai connector repaste) |
| Q005 | CLOSED 2026-05-22 | Layered: PID file + Unix connect-probe + Windows EADDRINUSE |
| Q006 | CLOSED 2026-05-21 | Vitest ^1.4.0 with standing-advisory tracking |

All resolved or properly deferred. No open Q-items as P0 closes.

## Patterns codified during P0

**Project-level (in `docs/patterns/project/`):**

| Pattern | Status | Use sites |
|---------|--------|-----------|
| `node-esm-imports.md` | active | Universal |
| `zod-schema-validation.md` | active | Config, IPC, audit, tools, CLI |
| `constant-time-compare.md` | active | Token comparison, auth middleware |
| `test-token-fixtures.md` | active | All token-related tests |
| `async-sink-queue.md` | active | Audit log, auth audit-write, dispatch audit-write |
| `line-buffered-stream-reader.md` | active | IPC server, cloudflared stdout |
| `safe-narrow-of-unknown-shape.md` | draft | T-0011 ping dispatch (1 instance) |

**Methodology-level candidates** (worth promoting to cross-project pattern library):

- **"Extract on third confirmed use"** — applied at T-0014 → T-0016 util/ extraction
- **"Inline-duplicate-with-comment for small cross-platform helpers"** — used 4× before extraction; reaches "natural extraction point" predictably
- **"Settle-once gate for socket/timeout/event race resolution"** — used in IPC server, IPC client, cloudflared subprocess, daemon main shutdown, waitForReady; 5+ instances
- **"Verbatim discipline for safety-relevant files"** — tightened at T-0007, applied consistently after; caught multiple subtle issues at design time
- **"Smoke-test early, smoke-test often"** — T-0019 surfaced 3 real source bugs that earlier smoke would have caught at the introducing task

## Cross-cutting concerns (codified in conventions.md)

- **CC-1: Async error handling** — Promise rejections caught at expected boundary; never silent
- **CC-2: Cross-platform paths and IPC** — `node:path` joins; `~` expansion via helper; OS-specific branches via `process.platform`; LF line endings; collapsePath separator tolerance (T-0016); **Windows detached subprocess discipline** (T-0019.5): `windowsHide: true` for detached children, fire-and-forget redirection (`> NUL 2>&1`) for daemon-spawning shell scripts to avoid file-handle inheritance trap
- **CC-3: File permissions** — 0600 on config/socket/audit; 0700 on config dir; check on read, set on write
- **CC-4: Secret handling** — never log tokens; last-4 suffix in user output; constant-time compare; audit records input_hash not raw input
- **CC-5: Process lifecycle** — SIGTERM/SIGINT handlers; 10s graceful shutdown; PID file write/clean; stale detection; EPIPE handlers for detached subprocesses (T-0015 carry)
- **CC-6: Schema validation at external boundaries** — every external input → Zod schema; no `as` bypass

## Calibration findings (rolling, final P0)

**Streak:** 17 consecutive zero-fire on `recommendedTypeChecked` async-discipline rules for production code. Pattern validated across config I/O, audit queue, MCP server, tunnel manager, IPC server, six CLI commands, tail-log watcher, and daemon main wiring.

**Timing data (Clyde-time on no-wait dev host):**

| Task | Bucket | Predicted | Actual |
|------|--------|-----------|--------|
| T-0018 | trivial | 5-15 min | 5 min |
| T-0019 | medium (fresh) | 60-120 min | 60 min |
| T-0019.5 | trivial | 5-15 min | 5 min |
| T-0019.6 | trivial+setup | 10-20 min | 17 min |
| T-0020 | medium (consolidation) | 60-90 min | 6 min |

**Calibrated prediction bands** (for P1+):
- **Trivial:** 5-10 min (single-line fixes; verification with stable env)
- **Trivial+setup:** 10-20 min (verification requiring fresh environment install)
- **Small:** ~30-60 min (one new module + tests; following established patterns)
- **Medium-consolidation:** 5-15 min (doc tasks consolidating already-known material)
- **Medium-fresh:** 60-120 min (new functionality with discovery component)
- **Large:** 2h+ (architectural; multiple subsystems)

**Methodology findings to keep:**
- Pre-populated pattern library starts populated from day zero (T-0003 era)
- §3.5.1 reporting format applied consistently from T-0004; never relaxed
- Steady-state transition at T-0014 saved real token cost without quality drop
- Insert tasks (T-NNNN.5/.6) work cleanly for scoped follow-ups; three uses, all clean
- recommendedTypeChecked delivers two value streams: preventive on async, reactive on type-safety

**Methodology findings to apply at P1:**
- **Build acceptance harness early.** T-0019 surfaced 3 real source bugs (start.ts timeout, dispatch.ts duration_ms, DNS resolution) that earlier mechanical verification would have caught at the introducing task rather than 5-9 tasks later. P1 should produce its acceptance test surface within the first 3-4 tasks.
- **Cross-platform discipline is continuous.** Windows-vs-Unix issues surfaced at T-0008 (IPC sockets), T-0015 (subprocess detach), T-0016 (path separators), T-0019 (file-handle inheritance), T-0019.5 (console window), T-0019.6 (build noise). Treat as a cross-cutting concern requiring sustained attention, not a one-time setup decision.
- **Mechanical-vs-smoke gap is real.** Unit tests caught zero of T-0019's three real bugs (timeouts pass at synthetic boundaries; sub-ms timing isn't observable in unit tests; DNS is environmental). Smoke tests caught all three. Both layers necessary; don't conflate.

## Scope-affecting discoveries (carry into P1 design)

**SMOKE-2: Claude.ai connector UI requires OAuth.** Static Bearer tokens don't work via the connector UI (confirmed via Anthropic GitHub issues #112 and #155 as of 2026-04). Static-Bearer paths work with MCP Inspector, Claude Code (`claude mcp add --transport http --header`), and Claude Desktop. **P1 design decision pending:** implement OAuth 2.1 in the daemon, document workaround as deployment story, or both. This is the single biggest scope-affecting decision from P0.

**DNS resolution for newly-issued cloudflared subdomains.** Local resolvers may not see new `*.trycloudflare.com` subdomains for some minutes (corporate DNS / ISP filtering / router NXDOMAIN cache). The acceptance script's helper uses public DNS via undici dispatcher to work around this. Production users would just retry. P3 mitigation already noted: persistent named tunnels.

**TypeScript build noise on Node 20 in WSL.** TS7016/TS7006 for `@modelcontextprotocol/sdk/types.js`. Builds clean on Windows with Node 24. Likely subpath-exports/Node-version interaction with SDK type declarations. Candidate fix: pin Node 24+ in prerequisites, or tsconfig moduleResolution adjustment. Not blocking.

## What's next: P1 design conversation

Per methodology §28.1 and `00-overview.md`'s gate sequence, P1 (Headless delegation) has its own design doc written before the gate starts. The conversation that opens P1 produces:

1. **`docs/design/02-p1-delegation.md`** — design + scope + acceptance criteria
2. **`docs/design/p1-build-plan.md`** — concrete file-paths/function-shapes per task

P1's scope per `00-overview.md`:
- `delegate_to_claude_code` tool (job_id + status; long-poll)
- `poll_delegation` long-poll
- `cancel_delegation`
- In-memory job queue (single concurrent job for v1)
- Claude Code SDK invocation with mode plumbing (read_only / agentic)
- Transcript persistence (`~/.claude-bridge/transcripts/{job_id}.jsonl`)
- DelegationReport assembly with diff, diagnostics delta, transcript URI
- No VS Code extension yet — hardcoded workspace path for testing

**Two P0 findings that affect P1 design:**

1. **OAuth question (SMOKE-2).** Decide P1 design-time, not implementation-time. If OAuth is in scope: significant scope expansion. If documented workaround is sufficient: P1 is what `00-overview.md` already describes.

2. **Acceptance harness in P1.** Per the findings above, build it early — first 3-4 tasks.

## Files in /mnt/project/

- `00-overview.md` — architecture, gate sequence, frozen decisions
- `01-p0-bus.md` — P0 design + 10 acceptance criteria
- `p0-build-plan.md` — concrete file-paths/function-shapes per task
- `walkthrough.md` — steady-state UX after P0–P2 ship
- `claude-orchestrated-methodology-v0_3.md` — the methodology
- `orchestrator-context-2026-05-22.md` — mid-P0 snapshot
- `orchestrator-context-2026-05-23.md` — earlier same-day snapshot (T-0016 era)
- **`orchestrator-context-p0-close.md`** — this snapshot (final P0)

## Resume protocol for P1 design conversation

1. Read all files in `/mnt/project/` to rebuild context
2. Read this snapshot (the P0-close context)
3. Pull latest `docs/project-state.md`, `docs/milestones.md`, `docs/conventions.md`, `docs/patterns/project/*.md` from the repo
4. Read `00-overview.md` §"P1 — Headless delegation" for the existing P1 scope outline
5. Open P1 design conversation:
   - Confirm SMOKE-2 resolution direction (OAuth, doc workaround, both)
   - Confirm P1 AC list based on overview + any additions from P0 learnings
   - Confirm task slicing approach
   - Produce `docs/design/02-p1-delegation.md` (or update existing if started)
   - Produce `docs/design/p1-build-plan.md` once design is locked
6. Maintain steady-state mode (lighter prompts, paragraph verdicts, summary reports except safety-relevant)
7. Apply P0 findings to P1: acceptance harness early; cross-platform continuous; mechanical-vs-smoke layering

## What to celebrate

P0 is done. 22 commits, 0 reverts, 0 escalations, 0 quality regressions. The methodology held across the entire gate. The bus works.

End of P0-close snapshot.

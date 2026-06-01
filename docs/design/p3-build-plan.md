# P3 Build Plan

**Phase:** P3 (OAuth resolution)
**Status:** Draft — pending Clyde review and user final approval
**Predecessor:** `docs/design/p2-build-plan.md` (15 phases, gate-closed 2026-05-30)
**Design reference:** `docs/design/04-p3-oauth.md`
**Methodology in effect:** v0.7

This document is the per-task breakdown of P3. Each task is a numbered phase. The design rationale for each phase is in `docs/design/04-p3-oauth.md`.

P3 has 6 phases (vs P2's 15). The smaller size reflects pure-OAuth focus per the design scope-lock — beyond-OAuth candidates roll to P4+. P3's gate close (T-P3-006) doesn't include a methodology-codification phase because v0.7 codification will happen when P3 accumulates enough candidates, not on a fixed schedule.

---

## Phase summary

| # | Task | Phase | Description |
|---|---|---|---|
| 1 | T-P3-001 | DCR + metadata endpoints | `/.well-known/oauth-authorization-server`, `/register`, `clients.json` persistence |
| 2 | T-P3-002 | `/authorize` endpoint (pre-extension-modal) | Browser-side flow: pending page, status endpoint, daemon-side consent state machine; extension stub auto-approves for harness |
| 3 | T-P3-003 | VS Code extension modal + IPC handlers | Four-message consent IPC (request/ack/response/timeout); modal UX; timeout notification |
| 4 | T-P3-004 | `/token` endpoint + auth-layer integration | PKCE verification; access token issuance; daemon's auth layer accepts both Bearer and OAuth |
| 5 | T-P3-005 | Acceptance harness extension + cross-platform | OAuth flow tests added to acceptance-p2.mjs; Windows + WSL parity run |
| 6 | T-P3-006 | P3 gate close + close snapshot | Doc-debt sweep; AC-P3-12 operator-smoke against real claude.ai; gate-close snapshot |

Estimated total: ~4-6 hours Clyde-time at P2 cadence. Plus expected 1-2 follow-up tasks from live claude.ai smoke (T-P3-006-followups) per the integration-boundary risk in design § 5.

---

## How P3 differs from P2 (process)

**1. Smaller phase count, focused scope.** P3 is single-feature; P2 was a multi-feature surface buildout. The 6-phase budget assumes no scope expansion mid-phase.

**2. Live integration smoke is gate-blocking.** AC-P3-12 (real claude.ai end-to-end) is operator-smoke and the integration-boundary risk is acknowledged in design. T-P3-006 doesn't close until that AC fires green. Follow-up tasks for live-smoke defects are expected, not a sign of methodology drift.

**3. Two-layer auth path coexistence is the architectural invariant.** Every daemon-side auth check must accept either static Bearer or OAuth token. Adjacent-invariant scoping (C-32) applies to any task that touches the auth layer.

**4. New IPC schema additions** (consent flow's 4 messages) are the only protocol additions. T-P3-003 owns this; T-P3-002 stubs it for harness purposes.

---

## Per-phase detail

### Phase 1 — T-P3-001: DCR + metadata endpoints

**Goal:** Daemon exposes the two static OAuth-discovery endpoints and accepts Dynamic Client Registration. No interactive consent yet; this phase just lets a DCR client register and persist.

**Deliverables:**
- `packages/daemon/src/oauth/metadata.ts` — `/.well-known/oauth-authorization-server` handler; constructs URLs from inbound `Host` header.
- `packages/daemon/src/oauth/register.ts` — `/register` DCR endpoint (RFC 7591); validates client metadata; persists.
- `packages/daemon/src/oauth/clients-store.ts` — load/save `clients.json`; bcrypt or argon2 hashing of `client_secret`; same shape pattern as `workspaces.ts`.
- HTTP routing in `packages/daemon/src/http/server.ts` (or wherever P2 lands HTTP routes) to wire the two endpoints. These must be unauthenticated (DCR is bootstrap auth).
- `packages/shared/src/oauth.ts` — schemas for client registration request/response (zod).
- Tests in `packages/daemon/tests/oauth/`.

**Verification:**
- Metadata endpoint returns spec-compliant JSON.
- DCR with valid metadata returns `client_id` + `client_secret`.
- DCR persists to `clients.json` (new entry per registration).
- DCR validates schema rejection on malformed request.
- Daemon restart: existing clients survive.

**AC mapping:** AC-P3-1, AC-P3-2.

**Estimated effort:** Medium pre-resolved. Empirical band per v0.6 §5.2: ~25-40 min.

**Rationale:** Bootstraps the OAuth surface. No UX yet; just persistence and discovery. T-P3-002 builds on the registry this creates.

---

### Phase 2 — T-P3-002: `/authorize` endpoint (pre-extension-modal)

**Goal:** Daemon exposes the authorization endpoint with the full state-machine for consent flow, BUT with extension-side as a test stub. This phase ships the browser-side UX (pending page, status polling, error pages) and the daemon-side state machine without yet shipping the VS Code modal. Sets up T-P3-003 to plug in the real extension UX cleanly.

**Deliverables:**
- `packages/daemon/src/oauth/authorize.ts` — `/authorize` endpoint; consent state machine with `pending` / `approved` / `denied` / `timeout` states keyed by `request_id`.
- `packages/daemon/src/oauth/status.ts` — `/authorize/status?request_id=...` endpoint for browser polling.
- Static HTML templates: pending page, error pages (extension-offline, ack-timeout, decision-timeout, deny).
- IPC schema additions in `packages/shared/src/ipc.ts`: `auth_consent_request`, `auth_consent_ack`, `auth_consent_response`, `auth_consent_timeout` (all four messages, per design § 3.4).
- Daemon-side IPC handler that emits `auth_consent_request` and awaits ack + response.
- 30-second decision timer + 2-3 second ack timer.
- Extension-side stub for harness purposes: a feature-flagged handler in extension that auto-acks and auto-approves OR auto-denies based on harness config. Not the real modal — that's T-P3-003.

**Verification:**
- `/authorize` with stub auto-approving returns auth code (in the URL redirect or status endpoint).
- `/authorize` with extension offline immediately returns the offline error page.
- `/authorize` with stub never-acking returns ack-timeout error within 2-3s.
- `/authorize` with stub acking but never responding returns decision-timeout error after 30s.
- Status endpoint returns correct state at each phase.

**AC mapping:** AC-P3-3 (stub variant), AC-P3-4, AC-P3-5 (timeout half — modal-half tested in T-P3-003), AC-P3-6.

**Estimated effort:** Large pre-resolved (more surface than T-P3-001 — state machine, multiple HTML pages, IPC schema additions). Empirical band: ~45-75 min.

**Rationale:** Separating the daemon-side state machine from the extension-side modal lets us verify the wire path and timing in isolation. T-P3-003 then layers UX without re-testing the state machine. Matches T-P2-008.6/.7/.8's pattern of "instrument the surface, then fix the defect on top."

---

### Phase 3 — T-P3-003: VS Code extension modal + IPC handlers

**Goal:** Replace the T-P3-002 stub with the real VS Code modal flow. User-facing UX lands.

**Deliverables:**
- `packages/extension/src/oauth-consent.ts` — IPC handler that consumes `auth_consent_request`, opens VS Code modal, sends `auth_consent_ack` immediately, sends `auth_consent_response` on user decision.
- VS Code modal UX: `vscode.window.showInformationMessage(...)` with Approve / Deny actions OR `vscode.window.showQuickPick(...)` if the message-modal API doesn't give enough room for client info display.
- Timeout handling: `auth_consent_timeout` IPC closes modal if open; surfaces VS Code notification (`vscode.window.showWarningMessage(...)`).
- Dismissal-as-deny: modal X / window-close treated as deny per design § 3.4.
- Tests in `packages/extension/tests/oauth-consent.test.ts` using VS Code API mock pattern from T-P2-009/010.
- Remove the T-P3-002 stub or feature-flag it for harness-only paths.

**Verification:**
- Real claude.ai-shaped DCR + `/authorize` flow against a fully-functional daemon + extension produces VS Code modal.
- User-click-Approve → tool call with the resulting token succeeds.
- User-click-Deny → browser sees deny error.
- User-dismiss → treated as deny.
- 30s timer fires while modal still open → modal auto-closes + notification.
- 30s timer fires after user dismisses → modal already closed (no-op + notification).
- Click Approve after timer fires → late response discarded by daemon; modal already closed.

**AC mapping:** AC-P3-3 (full variant), AC-P3-5 (modal half).

**Estimated effort:** Medium pre-resolved. Empirical band: ~25-40 min. Extension-side UX work is similar shape to T-P2-008's approval modal flow.

**Rationale:** This is the user-visible OAuth UX. After this phase, the consent flow is feature-complete; remaining phases are token issuance, tests, and gate close.

---

### Phase 4 — T-P3-004: `/token` endpoint + auth-layer integration

**Goal:** Complete the OAuth flow with token issuance. Daemon's auth layer accepts both static Bearer (existing) and OAuth tokens (new).

**Deliverables:**
- `packages/daemon/src/oauth/token-endpoint.ts` — `/token` endpoint; accepts `grant_type=authorization_code`; verifies PKCE; issues opaque access token; persists token→client_id mapping with 30-day expiry.
- `packages/daemon/src/oauth/token-store.ts` — token persistence (in `clients.json` extended with a `tokens` field, OR separate `tokens.json` — implementation call at dispatch time; flag the choice in T-P3-004 pre-conversation).
- Auth-layer extension in `packages/daemon/src/auth/` — every request that currently checks static Bearer ALSO checks OAuth tokens. Dual-mode per design § 3.6.
- Token expiry handling: expired token → 401.
- Tests covering: valid `/token` call returns access token; invalid PKCE returns error; expired token rejected; static Bearer still works (regression).

**Verification:**
- `/token` with valid auth code + PKCE returns access token.
- `/token` with invalid PKCE returns error.
- MCP tool call with OAuth token succeeds.
- MCP tool call with expired OAuth token returns 401.
- MCP tool call with static Bearer still succeeds.
- Auth-layer code path: confirm both Bearer and OAuth paths checked, neither short-circuits the other.

**AC mapping:** AC-P3-7, AC-P3-8, AC-P3-9, AC-P3-10, AC-P3-11.

**Estimated effort:** Medium pre-resolved. Empirical band: ~30-50 min. The auth-layer integration is the C-32 (adjacent-invariant) discipline point — must touch every auth check site.

**Rationale:** Closes the OAuth-spec wire path. After this phase, claude.ai's DCR client can theoretically complete the full flow against the daemon. T-P3-005 tests that systematically; T-P3-006 verifies live.

---

### Phase 5 — T-P3-005: Acceptance harness extension + cross-platform

**Goal:** Extend `scripts/acceptance-p2.mjs` with OAuth flow tests. Run on both Windows and WSL to verify cross-platform parity.

**Deliverables:**
- `scripts/acceptance-p2.mjs` extensions: ~7-10 new test cases covering DCR / authorize-approve / authorize-deny / authorize-offline / authorize-ack-timeout / authorize-decision-timeout / token-valid / token-invalid-pkce / tool-with-oauth / tool-with-expired / tool-with-bearer-regression.
- `scripts/mock-extension.mjs` extensions: behavior-config additions for `onAuthConsent: "approve" | "deny" | "ignore" | "ack-only"` (so harness can drive each consent outcome).
- Brittleness-defense disciplines (v0.6 §3.5): `unwrapOrThrow` on every MCP/HTTP call; elapsed-floor assertions where applicable; both-sides assertions (operation success + state change); drain between tests; schema rejection surfaces loudly.
- Run on Windows: 11/11 PASS.
- Run on WSL Ubuntu: 11/11 PASS.

**Verification:**
- All 11 OAuth-related AC tests PASS on Windows.
- All 11 PASS on WSL.
- Cross-platform parity per-AC elapsed within 2x; no >5x outliers.

**AC mapping:** AC-P3-13 (cross-platform parity for harness-coverable ACs).

**Estimated effort:** Medium. Empirical band: ~30-45 min. Builds on T-P2-011's harness structure which is well-tested.

**Rationale:** Hermetic regression coverage. Live-claude.ai smoke (AC-P3-12) catches integration-boundary defects this harness can't.

---

### Phase 6 — T-P3-006: P3 gate close + close snapshot

**Goal:** P3 GATE-CLOSED. AC-P3-12 (operator-smoke against real claude.ai) verified. Gate-close snapshot produced. P4 handoff clean.

**Deliverables:**
- **AC-P3-12 operator smoke:** operator configures claude.ai project chat with daemon's tunnel URL as MCP connector; triggers OAuth flow; approves in VS Code modal; delegates a real task. End-to-end works.
- Follow-up tasks (T-P3-006-followups) for any defects surfacing during the smoke. Expected 1-2 per design § 5.
- `docs/snapshot/orchestrator-context-p3-close.md` per T-P2-015 template.
- README P3 section: "P3 — OAuth resolution. Status: GATE-CLOSED 2026-XX-XX. See snapshot."
- Walkthrough Part 1 update: add the OAuth flow as a documented path; preserve Part 2's "P3 target state" wording (now retroactively complete) by absorbing it into Part 1 with a note about P4+ candidates remaining.
- Doc-debt sweep:
  - C-27 status flipped to closed-by-T-P3-* (whichever task actually closes it).
  - v0.7_candidates updated with any P3-surfaced methodology candidates.
  - Pattern doc instance count refresh if any new instances of existing patterns landed.
- `docs/project-state.md`, `docs/milestones.md`, `docs/calibration-log.md` updates.

**Verification:**
- AC-P3-12 fires green: operator-smoke transcript captured in report.
- AC table for all 13 P3 ACs shows VERIFIED.
- Internal-link verification.
- Fresh lint clean.
- Workspace-root build clean.

**AC mapping:** AC-P3-12 (the main smoke); plus gate-close discipline.

**Estimated effort:** ~20-30 min for the gate-close work itself; the operator-smoke time is operator-driven and not included in C-35 elapsed per M-I discipline. Live-smoke defects (if any) become T-P3-006-followups with their own calibration entries.

**Rationale:** Closes P3. The operator-smoke gate means we don't ship P3 until we've actually verified end-to-end with claude.ai. P4 design conversation opens against the close snapshot.

---

## P4 candidates (carry-forward from P2 gate-close snapshot)

Per the gate-close snapshot's "P3 candidates beyond OAuth" list, all carry to P4+:

- Per-workspace `.claude-bridge.json` policy schema.
- Tool surface expansion (`get_selection`, `get_git_state`, `get_terminal_output`, `get_search_results`, `show_diff`).
- Production deployment story: CI integration, marketplace publishing, autoupdate. **Worth flagging:** the retro-community-release framing makes this a natural P4 priority.
- Multi-user / team-shared daemon.
- macOS first-class support.
- Trust revocation UI (builds on `/revoke` endpoint, which P3 explicitly skipped).
- Approval timeout configurable.
- Discriminated `403 workspace_untrusted` response.
- Concurrent-delegation test coverage.
- v0.7 methodology codification (when accumulated P3 candidates warrant it).

P4 design conversation prioritizes among these based on the post-P3 state.

---

## Methodology applications carried from P2

Per `claude-orchestrated-methodology-v0_6.md`:

- **C-13 pre-dispatch grep** on every dispatch.
- **C-14 empirical band landing** tracked per task; bands borrow P2 calibration for shape-equivalent tasks.
- **C-21 mock-vs-production contract drift discipline** — OAuth has real risk here. claude.ai's actual DCR behavior is the production target; our harness mocks it. Any drift between mock behavior and claude.ai behavior is the defect, not a test failure.
- **C-31 diag-before-fix** for any race/retry symptoms during live smoke.
- **C-32 adjacent-invariant scoping** — especially relevant at T-P3-004 (auth-layer touches multiple sites).
- **C-33 diagnostic-add as separate task** if live-smoke surfaces hard-to-localize defects.
- **C-34 hard-stop guards** on dispatch verification.
- **C-35 elapsed-time block** in every Form A/B report.
- **§11 sub-rules 25.1/25.2/25.3** per task shape.
- **Pre-conversation matrix** per substantive task — especially T-P3-001 (DCR schema decisions), T-P3-002 (state machine + HTML page decisions), T-P3-004 (token store decisions).
- **Honest scope deferrals** — beyond-OAuth candidates explicitly route to P4 per design § 7.

Carry-forward methodology candidates from P2 (provisional, log-and-watch):
- **M-J** — Hard-stop guards permit at-site diagnostic resolution. 3 P2 instances; v0.7 promotion candidate.
- **M-L** — Parallel-sub-agent leverage for independent-file tasks. 2 P2 instances; v0.7 promotion candidate. Note: T-P3-001 + T-P3-002 will have IPC schema additions in `packages/shared/src/ipc.ts` — single-file editing, not parallel-eligible. T-P3-006 doc sweep is parallel-eligible.
- **M-N** — C-35 imprecision-flag honest application. 2 P2 instances; watch for 3rd.

End of P3 build plan.

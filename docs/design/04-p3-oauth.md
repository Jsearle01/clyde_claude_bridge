> **⚠ SUPERSEDED (2026-06-10) — read with care.** This document predates **ADR-001** (daemon-per-workspace, physical isolation) and **T-BEARER-1** (the unconstrained Bearer auth path was removed — OAuth-bound is now the ONLY auth model). Where it describes (a) one daemon serving many bound workspaces, or (b) the static Bearer / `token rotate` / unconstrained auth as live, it is WRONG. Current model: `05-autonomous-collaboration-model.md` §3/§4/§9 + ADR-001/002. The OAuth *mechanics* (DCR, consent, bound-token lookup) here remain broadly accurate for the per-daemon case; the *topology* and *Bearer coexistence* do not.

# Design — P3 OAuth (scope-lock)

**Date:** 2026-05-31
**Phase:** P3 (OAuth resolution)
**Predecessor:** P2 GATE-CLOSED 2026-05-30 (`docs/snapshot/orchestrator-context-p2-close.md`)
**Methodology:** v0.6
**Doc shape:** lightweight scope-lock (~200 lines), not full design doc (P2 precedent). Architectural prep in gate-close snapshot B.9 is the architectural frame; this doc records decisions and acceptance criteria.

---

## 1. Purpose

Close C-27. Make claude.ai project-chat connector UI work end-to-end against the local daemon. P3 closes when a claude.ai project chat with the daemon's tunnel URL configured as an MCP connector can:

1. Complete Dynamic Client Registration against the daemon.
2. Complete an OAuth 2.1 authorization-code flow (with PKCE) to obtain an access token.
3. Use that access token to invoke any of the daemon's MCP tools (`delegate_to_claude_code`, `poll_delegation`, `cancel_delegation`, `get_open_editors`, `get_diagnostics`).

The static-Bearer auth path (P2-era) remains available for non-claude.ai MCP clients (Claude Code CLI, MCP Inspector, Claude Desktop, raw curl). Dual-mode auth.

P3 does NOT ship anything from the gate-close snapshot's "P3 candidates beyond OAuth" list. Those route to P4+.

---

## 2. Architectural frame (from gate-close snapshot B.9)

- OAuth 2.1 + Dynamic Client Registration (RFC 7591).
- Endpoints implemented: `/.well-known/oauth-authorization-server` (RFC 8414 metadata), `/register` (DCR), `/authorize` (consent), `/token` (auth code + PKCE).
- Token signing: HMAC.
- Consent UX surface: VS Code extension modal (the decision below).
- Token persistence: `clients.json` (next to `workspaces.json`).
- Integration boundary risk: claude.ai's DCR client behavior is unmapped; live smoke will likely surface defects (precedent: T-P2-008.7/.8 surfaced C-29/C-30 after harness passed).

---

## 3. Locked design decisions

### 3.1 OAuth spec compliance scope (Decision 1: b)

RFC-clean on the endpoints we ship. No padding with unused features.

**Endpoints shipped:**
- `/.well-known/oauth-authorization-server` — RFC 8414 metadata; URLs constructed dynamically from inbound request `Host` header (must work across rotating tunnel URLs).
- `/register` — RFC 7591 DCR; accepts client metadata, persists to `clients.json`, returns `client_id` + `client_secret`.
- `/authorize` — RFC 6749 §4.1 authorization endpoint with PKCE (RFC 7636) required.
- `/token` — RFC 6749 §4.1.3 token endpoint; authorization-code grant with PKCE verification.

**Endpoints NOT shipped:**
- `/revoke` (RFC 7009) — skipped, not stubbed. Pairs naturally with trust-revocation-UI work in a later phase.
- `/introspect` (RFC 7662) — skipped.
- Refresh-token grant (RFC 6749 §6) — skipped (Decision 5).
- Dynamic Client Registration Management (RFC 7592) — skipped.

### 3.2 Token format (Decision 2: a)

Opaque random tokens. 32-byte random hex string. Daemon stores a `token → client_id` mapping. Validation by lookup.

No JWT. Single-tenant single-process daemon; JWT's distributed-validation property doesn't apply.

### 3.3 DCR persistence (Decision 3: b)

`packages/daemon/<config-dir>/clients.json`. Same on-disk pattern as `workspaces.json`:

```json
{
  "version": 1,
  "clients": [
    {
      "client_id": "<random>",
      "client_secret_hash": "<bcrypt or argon2>",
      "client_name": "<from DCR registration>",
      "redirect_uris": ["..."],
      "created_at": "<ISO timestamp>"
    }
  ]
}
```

Client secret stored as hash, not plaintext. Verified at token-endpoint with constant-time compare (existing pattern from P0's `test-token-fixtures`).

### 3.4 Consent UX surface (Decision 4: b)

**The substantive decision.** Consent happens via VS Code extension modal, with browser-side instructions.

**Flow:**

1. claude.ai redirects browser → daemon `/authorize?...`.
2. Daemon checks extension is connected via IPC. If not → immediate HTML error page in browser (*"VS Code extension not running. Open VS Code and retry."*).
3. Daemon emits `auth_consent_request` IPC to extension. 30-second timer starts.
4. Daemon waits for `auth_consent_ack` from extension (2-3s ack timeout). If no ack → HTML error in browser (*"VS Code unresponsive, retry."*).
5. Daemon responds to browser with HTML pending page (*"OAuth approval pending. Please go to VS Code to approve or deny this request."*) with meta-refresh polling `/authorize/status?request_id=...`.
6. Extension shows VS Code modal with client name + tunnel URL the request arrived on.
7. User decides → extension sends `auth_consent_response` over IPC.
8. Daemon stores result; browser's polling sees status; redirects to claude.ai with auth code (approve) or shows error page (deny / timeout).

**IPC schema (4 messages):**
- `auth_consent_request` (daemon → extension): `request_id`, client info.
- `auth_consent_ack` (extension → daemon): `request_id`, "received."
- `auth_consent_response` (extension → daemon): `request_id`, `"approve" | "deny" | "dismiss"`.
- `auth_consent_timeout` (daemon → extension): `request_id`. Extension closes modal, surfaces VS Code notification (*"OAuth consent request timed out. To retry, refresh the page in claude.ai."*).

**Guardrails:**
- **Extension-offline detection:** Guardrail 2 above; immediate browser error before IPC fires.
- **Ack timeout (2-3s):** confirms IPC reached extension before browser sees pending page.
- **Decision timer (30s):** daemon-side; starts at IPC send. Timeout surfaces in BOTH browser (timeout error page) and VS Code (modal closes + notification).
- **Dismissal-as-deny:** modal dismissed (X clicked / window closed) treated as deny.
- **Race resolution:** daemon owns authoritative state. If response and timeout race, first-to-daemon wins; daemon discards late arrivals.

**Status endpoint (`/authorize/status?request_id=...`):** returns one of `pending` / `approved&code=...` / `denied` / `timeout` / `not_found`. Browser polls (meta-refresh ~2s); on non-pending result, redirects appropriately.

### 3.5 Token lifetime + refresh (Decision 5: 30-day, no refresh)

Access token TTL: 30 days. Re-auth on expiry.

No refresh tokens shipped. Re-auth is the once-a-month flow; acceptable UX. If claude.ai's DCR client demands refresh tokens during integration, that surfaces at first claude.ai smoke and gets handled as a follow-up.

### 3.6 Bearer compatibility preservation (Decision 6: a)

Daemon accepts EITHER the existing static Bearer (`cb_live_*` pattern from P0) OR an OAuth access token. Single auth layer in daemon, two acceptance paths:

- **Static Bearer path:** existing P0/P1/P2 behavior. Token-equality check against `auth.token` in `config.json`. Untouched.
- **OAuth path:** check token against `clients.json` token→client_id store. If match and not expired → authenticated; capture `client_id` and any associated metadata.

Either path satisfies any downstream tool call. Tool surface doesn't distinguish — `delegate_to_claude_code` works identically regardless of auth source.

Migration: zero breakage. Existing static-Bearer users see no change. New claude.ai users do DCR.

### 3.7 Acceptance harness shape (Decision 7: a)

Extend `scripts/acceptance-p2.mjs` with OAuth flow tests. Plus operator-smoke against real claude.ai as the final gate AC.

**Harness coverage (mockable):**
- DCR registration → check response shape, persistence to `clients.json`.
- `/authorize` with mock extension that auto-approves → check auth code returned.
- `/authorize` with mock extension that auto-denies → check error returned.
- `/authorize` with extension offline → check immediate error.
- `/authorize` with extension acking but never responding → check 30s timeout fires.
- `/token` exchange with valid auth code + PKCE → check access token returned.
- `/token` with invalid PKCE → check error.
- Tool call with OAuth token → success.
- Tool call with expired OAuth token → 401.
- Tool call with static Bearer → still succeeds (regression).

**Operator-smoke coverage (real claude.ai):**
- Operator configures claude.ai project as MCP connector with daemon's tunnel URL.
- Operator triggers OAuth flow from claude.ai.
- Operator approves in VS Code modal.
- Operator delegates a real task from claude.ai project chat.

### 3.8 Build-plan phase count (Decision 8: a)

4-6 numbered phases. Honest sizing per gate-close snapshot B.9. Anticipated breakdown — final shape in `p3-build-plan.md`:

1. **T-P3-001** — DCR endpoint + `/register` + `clients.json` persistence + metadata endpoint.
2. **T-P3-002** — `/authorize` endpoint + consent IPC + pending page + status endpoint (no modal yet).
3. **T-P3-003** — VS Code extension modal + IPC handlers (request/ack/response/timeout).
4. **T-P3-004** — `/token` endpoint + PKCE verification + token storage + auth-layer integration.
5. **T-P3-005** — Acceptance harness extensions + cross-platform validation.
6. **T-P3-006** — P3 gate close + doc updates + walkthrough Part 1 update.

Plus expected 1-2 follow-ups from live claude.ai smoke surfacing integration-boundary issues.

---

## 4. Acceptance criteria (P3)

| AC | Description | Verification category |
|----|-------------|----------------------|
| AC-P3-1 | DCR endpoint registers a client; persists to `clients.json`; returns `client_id`+`client_secret`. | HARNESS |
| AC-P3-2 | Metadata endpoint returns spec-compliant JSON with dynamically-constructed URLs from request `Host`. | HARNESS |
| AC-P3-3 | `/authorize` flow with extension auto-approving completes and returns auth code. | HARNESS |
| AC-P3-4 | `/authorize` with extension offline returns clear browser error before any IPC fires. | HARNESS |
| AC-P3-5 | `/authorize` 30s timeout fires; browser sees timeout error; VS Code modal closes + notification appears. | HARNESS |
| AC-P3-6 | `/authorize` ack-timeout fires when extension doesn't ack within 2-3s. | HARNESS |
| AC-P3-7 | `/token` exchange with valid auth code + PKCE returns access token. | HARNESS |
| AC-P3-8 | `/token` with invalid PKCE returns error. | HARNESS |
| AC-P3-9 | Tool call with OAuth access token succeeds. | HARNESS |
| AC-P3-10 | Tool call with expired OAuth token returns 401. | HARNESS |
| AC-P3-11 | Tool call with static Bearer still succeeds (regression check). | HARNESS |
| AC-P3-12 | claude.ai project-chat connector UI can complete end-to-end DCR + authorize + delegate. | SMOKE |
| AC-P3-13 | Cross-platform: harness passes on Windows + WSL Ubuntu. | X-PLAT |

13 ACs. Harness covers 11; operator-smoke covers AC-P3-12 (the actual integration); cross-platform covers AC-P3-13.

---

## 5. Risks

**Integration-boundary risk (high probability, low-medium severity):** claude.ai's DCR client behavior is unmapped. Live smoke will likely surface at least one defect. Anticipated kinds: redirect URI format, scope handling, error response shape expectations. Will be handled as follow-up tasks per P2 precedent.

**Token-lifetime mismatch (low probability, low severity):** if claude.ai's client expects refresh tokens, we'd need to add them. Surfaces at AC-P3-12.

**Tunnel URL rotation (medium probability, medium severity):** cloudflared rotates tunnel URLs on daemon restart. OAuth metadata URLs are constructed from inbound `Host` header so daemon doesn't care about the URL itself. But: claude.ai-side registered DCR client persistence — does it survive a tunnel URL change? If not, user has to re-register the client each daemon restart. Unknown until smoke.

**Consent UX UAT risk (low):** the new browser→VS Code handoff flow is novel. 30s timer may need adjustment after real-user feedback. Easy to change.

---

## 6. Open questions (resolved at design conversation)

All scope decisions resolved per Section 3. No carry-over open questions blocking T-P3-001.

---

## 7. What this design does NOT include (explicit deferrals)

Per the gate-close snapshot's "P3 candidates beyond OAuth" list, all deferred:

- Per-workspace `.claude-bridge.json` policy schema.
- Tool surface expansion (`get_selection`, `get_git_state`, etc.).
- Production deployment story (CI, marketplace, autoupdate).
- Multi-user / team-shared daemon.
- macOS first-class support.
- Trust revocation UI (would build on `/revoke` endpoint).
- Approval timeout configurable (per P2 backlog).
- Discriminated `403 workspace_untrusted` response (per P2 backlog).
- Concurrent-delegation test coverage.
- v0.7 methodology codification (timing depends on P3 candidate accumulation).

---

## 8. Methodology notes

P3 dispatches per v0.6:
- Pre-dispatch grep (C-13) on every dispatch.
- Empirical band landing tracked (C-14) — initial bands borrow P2 calibration for shape-equivalent tasks.
- Mock-vs-production contract drift discipline (C-21) — OAuth has real risk here since claude.ai is the production target and we'll be mocking it in harness.
- Diag-before-fix (C-31) for any race/retry symptoms during live smoke.
- Adjacent-invariant scoping (C-32) when fixes touch shared surfaces.
- Diagnostic-add as separate task (C-33) if live-smoke surfaces hard-to-localize defects.
- Hard-stop guards (C-34) on dispatch verification.
- Elapsed-time block (C-35) in every Form A/B report.
- Verdict-time evidence (§11 sub-rules 25.1/25.2/25.3) per task shape.

Plus carry-forward observations from P2:
- Parallel-sub-agent leverage for independent-file tasks (M-L, 2 P2 instances).
- C-35 imprecision-flag honest application (M-N, 2 P2 instances).
- Hard-stop guards permit at-site diagnostic resolution (M-J, 3 P2 instances).

---

## 9. Next actions

1. Draft `docs/design/p3-build-plan.md` — 6 phases per Section 3.8.
2. T-P3-001 dispatch.

End of P3 design scope-lock.

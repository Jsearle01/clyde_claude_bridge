# claude-bridge — P3′ (P3-prime) Build Plan: Bound Autonomous Collaboration

**Status:** Active plan. Re-planning of P3 (OAuth) against the autonomous-collaboration model (`05-autonomous-collaboration-model.md`, agreed 2026-06-01). Supersedes the remaining-task portion of the original `p3-build-plan.md` (T-P3-003 onward); T-P3-001 and T-P3-002 already shipped (and T-P3-002 is revised here).
**Methodology:** v0.7.
**Design authority:** `05-autonomous-collaboration-model.md`. Where this plan and that doc differ, the design doc wins; this plan sequences it into tasks.

---

## Strategy: Order A — binding-first, isolation as a milestone, then autonomy

The binding (isolation) is the load-bearing foundation: granularity, gate re-keying, and enforcement all depend on the token carrying the binding. So the isolation layer is built and proven FIRST (a complete, independently-valuable milestone — it solves the operator's original "A must not touch B" need even before the autonomy polish), and the autonomy layer is layered on top of the proven foundation.

**Test scope: TWO bindings.** Isolation is binary (A can reach B, or it cannot). Two pairs (claude.ai-A↔workspace-A, claude.ai-B↔workspace-B) prove it completely: A acts on A; A cannot touch B; B cannot touch A; cross-attempts are blocked + surfaced. The design is N-pair; two is the minimal N that proves isolation. No third pair needed for the proof.

**Shipped-code policy: REVISE, don't add-alongside.** T-P3-002's daemon-global consent flow is revised to the binding model — the global assumption is removed, not left as a deprecated parallel path (the design doc frames daemon-global as "the model being replaced"; it was inherited-unexamined, never intended).

---

## Phase map

```
FOUNDATION (isolation)
  T-P3-002R  revise consent: bound workspace + responder-binds + named modal   [revises shipped code]
  T-P3-003   reshaped modal: bind-this-workspace (named: client + codebase) + status-bar binding display
  T-P3-003U  unbind / revoke: targeted daemon teardown + VS Code unbind command   [misclick recovery]
  T-P3-004   /token + token carries binding + AUTH-LAYER ENFORCEMENT + unbound-broadcast filter
  ── ISOLATION MILESTONE ──  (two bindings; A⊥B proven; misbinding recoverable)
AUTONOMY (layered on the proven binding)
  T-P3-005   gate re-key (workspace→token) + per-operation granularity
  T-P3-006   gate categories (sandbox-escape / irreversible / recursive floor) + retry limit N=3
  T-P3-007   end-of-automation log (daemon) + per-transaction report (orchestrator)
GATE CLOSE
  T-P3-008   full acceptance + cross-platform + live smoke + close snapshot
SEPARATE (not a code task)
  methodology codification of the §5/§6.4 disciplines → orchestrator/executor prompting, via the pool
```

**Sequencing note (why T-P3-003U lands before T-P3-004):** misclick recovery is an operator requirement, not a P4 nicety. Today the only recovery is daemon restart (which clears in-memory consent state). But T-P3-004 persists the token (30-day TTL) — and a persisted binding is NOT cleared by restart. So if T-P3-004 shipped before an unbind path existed, a misbinding would be written to a persisted token with no recovery short of manual file editing. The unbind/revoke (T-P3-003U) therefore lands **before** token persistence, so the isolation milestone ships with bindings that are always undoable. (Recon 2026-06-01 established no revocation of any kind exists today; /revoke was P4-deferred — this pulls a minimal targeted unbind into P3′.)

---

## Tasks

### T-P3-002R — Revise consent to the binding model (FOUNDATION; revises shipped code)
**Goal:** the consent flow binds a client to a specific workspace, replacing the daemon-global broadcast model.
**Scope:**
- `ConsentRecord` / `AuthCodeRecord` gain a `bound_workspace` field (the workspace identifier the grant is bound to).
- **Responder-binds:** the daemon ties the `auth_consent_response` to the responding extension connection, and reads that connection's workspace from the active registry (`{abs_path, identifier, name, socket}` — the socket is already in scope at the response handler, `server.ts:570/601-606`; the workspace is recovered via `entry.socket === socket`). The workspace is threaded into `recordDecision` and onto the consent/auth-code record. (This is the binding seam recon confirmed available; claude.ai cannot itself carry a workspace identifier — `/authorize` reads only standard OAuth params, the connector UI exposes only URL + client_id/secret, and per-workspace URLs are blocked by the single-quick-tunnel exposure. See §"Binding mechanism" below.)
- **Consent delivery stays broadcast** (consent is initiated by claude.ai, which gives no target to aim at before a window responds); the BINDING is determined by *which window responds*, not by targeting delivery. The misclick guard is the named modal (T-P3-003), not targeted delivery.
- **Dismiss-siblings-on-resolve (closes the recon-#2 zombie-modal gap):** when a consent resolves by approve OR deny, the daemon sends a dismiss signal to all the OTHER broadcast recipients so their now-stale modals close immediately. Today the daemon only sends a close on the 30s *timeout* path, and the shared decision-timer is cleared on first resolution — so on approve/deny the siblings get NO signal and their modals hang (zombie modals: won't auto-close, do nothing if clicked due to first-write-wins, must be manually dismissed). This adds a daemon→ext "consent resolved, dismiss" message (or extends `auth_consent_timeout`'s close-path with a resolved reason) sent to the non-responding connections on resolution. (Extension-side handling of the dismiss is in T-P3-003.)
- Remove the daemon-global *grant* assumption from the consent path where the binding replaces it (revise, don't leave dead parallel code) — but the broadcast *delivery* is retained (it is correct for a remote-initiated consent).
**Out of scope:** the token (T-P3-004), enforcement (T-P3-004), the modal UI itself (T-P3-003), unbind (T-P3-003U), granularity (T-P3-005, set at operation-time not consent-time — see Open items).
**ACs:**
- AC-1: a consent grant records the bound workspace (recovered from the responding connection); `AuthCodeRecord` carries it.
- AC-2: the binding is determined by the responding window's workspace; a response from workspace-A's connection binds to workspace-A.
- AC-2b: on consent resolution (approve/deny), the daemon signals the other broadcast recipients to dismiss their modals (no zombie modals left hanging).
- AC-3: the daemon-global grant assumption is removed from the consent path (the grant is now workspace-bound, no dead parallel grant logic).
- AC-4: existing T-P3-001 DCR/metadata + T-P3-002 state-machine behavior otherwise preserved (transitions, timers, first-write-wins) except where binding changes them.
**Risk note:** touches shipped code (`consent.ts`, `main.ts` wiring, `server.ts` response handler). Pre-flight: diff against the shipped behavior; preserve the state-machine/timer correctness recon #2 documented.

**Binding mechanism (decided 2026-06-01, after four recon passes):** responder-binds. Rejected alternatives — (3a) *claude.ai declares target*: impossible, the connector UI exposes no scope/custom-param field and `/authorize` reads only standard params; (URL-encodes-workspace) *workspace in the server URL path/subdomain*: blocked by exposure — the daemon runs behind a single rotating cloudflared quick-tunnel (one random `*.trycloudflare.com` host), and the metadata/discovery chain assumes one global base; per-workspace public URLs would need named-tunnel+DNS or multi-tunnel infra outside the repo. **URL-encodes-workspace is recorded as a future option IF the deployment ever moves to per-workspace public URLs** (named Cloudflare tunnel + DNS) — at which point binding-as-configuration becomes cleanly available and would remove the misclick risk entirely.

### T-P3-003 — Reshaped consent modal (named) + status-bar binding display (FOUNDATION)
**Goal:** the consent modal names BOTH parties so a misclick is visible; the established binding is shown in the status bar for inspection.
**Scope:**
- Extension-side `oauth-consent.ts` (greenfield, parallels `approval-modal.ts`): receives `auth_consent_request`, sends `auth_consent_ack` immediately, shows the modal, sends `auth_consent_response`, handles `auth_consent_timeout`.
- **Named modal (the misclick guard):** the modal names BOTH (a) the requesting **claude.ai project** and (b) the **target VS Code codebase**. Codebase = the friendly folder name (`workspaceFolder.name`, always available from the active registry); abs_path available for disambiguation. claude.ai side = `client_name` WHEN meaningful, with the `client_id` prefix (e.g. `cb_client_a1b2c3d4`) shown ALWAYS as the guaranteed distinguisher. (`client_name` meaningfulness is external-to-confirm — it defaults to `"unnamed-client"` and is whatever claude.ai sends; the AC-P3-12 live smoke reveals the real value. Build to show client_name-if-present + client_id-prefix-always so the modal is unambiguous regardless.)
- Modal copy reflects the binding: e.g. "Bind {claude.ai client} to **{codebase}**?" so approving in the wrong window shows the wrong codebase name — a visible, catchable error.
- Two callback fields + two dispatch branches in `ipc/client.ts`; wired in `extension.ts`.
- **Status-bar binding display:** after a binding is established, the affected window's status bar shows it (e.g. `$(plug) {identifier} → {client}`), tooltip naming the bound claude.ai client. Requires a NEW daemon→ext message ("binding established: client X") on `IpcServerMessageSchema`, a new settable callback at `ipc/client.ts:295-323`, and a new status-bar source in `status-bar.ts` (composeStatusBarText). Located seam; this task wires it.
- **Dismiss-siblings handling (extension side of the T-P3-002R signal):** handle the daemon's "consent resolved, dismiss" message — when a sibling window receives it, close its now-stale consent modal. This is what makes the named-broadcast clean: you approve in one window, the others' modals vanish immediately instead of dangling. (Daemon sends the signal — T-P3-002R; extension closes the modal on receipt — here.)
- (Granularity: NOT set at consent — see Open items / T-P3-005. The modal is binding-only.)
**ACs:**
- AC-5: modal names the claude.ai client (client_name if meaningful + client_id prefix always) AND the target codebase (folder name); approve binds, deny/dismiss don't.
- AC-6: `auth_consent_ack` sent on receipt (before modal resolves); `auth_consent_response` on decision; `auth_consent_timeout` closes/notifies (best-effort per recon #2 — daemon authority is the real guarantee).
- AC-6b: when one window resolves the consent, sibling windows' modals dismiss on the daemon's resolved signal (no zombie modals — verified with two windows open).
- AC-7: AC-P3-3 (full, real-modal path) and AC-P3-5 (modal-close-on-timeout half) satisfied via the real extension, not the harness stub.
- AC-7b: after binding, the status bar shows the bound claude.ai client; the binding is human-inspectable.

### T-P3-003U — Unbind / revoke: misclick recovery (FOUNDATION; before token-persistence)
**Goal:** a misbinding can be undone — targeted, without nuking other bindings — BEFORE T-P3-004 makes bindings persist (and thus survive the restart that is today's only recovery).
**Scope:**
- **Daemon-side targeted teardown:** drop a specific binding (this workspace ↔ this client), leaving other bindings and the DCR registration intact. (No `removeClient` needed — the lighter unbind drops the binding, keeps the registration; claude.ai can re-bind with the same client_id.) Once T-P3-004 exists, unbind also invalidates/deletes the bound token so it can no longer authenticate.
- **VS Code-side trigger (operator decision: act in the window you can see is wrong):** a status-bar affordance / command in the affected window — "Unbind this workspace from {client}?" → confirm → daemon teardown. (The status bar from T-P3-003 is where the binding is inspected, so it's where unbind is triggered.) Requires an ext→daemon unbind request message + handler.
- **claude.ai re-bind after unbind:** the daemon's half is guaranteed (binding/token killed → that client's requests rejected via the existing `invalid_client`/401 machinery). The claude.ai-side re-bind smoothness is **external-to-confirm** (whether claude.ai auto-re-registers/re-prompts on `invalid_client`, or the user must manually reconnect via claude.ai's connector UI). **Build for graceful (return `invalid_client` so a well-behaved client re-prompts); accept the manual-reconnect floor** if claude.ai doesn't auto-re-prompt. Either way recovery is guaranteed — and targeted unbind beats restart (doesn't nuke the good binding) AND survives token-persistence (restart won't).
**ACs:**
- AC-7c: a specific binding can be torn down on operator command without affecting other bindings.
- AC-7d: after unbind, the unbound client can no longer act on the formerly-bound workspace (rejected).
- AC-7e: the operator triggers unbind from the affected VS Code window (status-bar command).
- AC-7f (smoke-confirmed): after unbind, re-binding to the correct workspace succeeds (graceful re-prompt if claude.ai supports it; manual reconnect otherwise — confirmed at AC-P3-12).
**Sequencing:** lands BEFORE T-P3-004 so persisted bindings are always undoable (see Phase map sequencing note).

### T-P3-004 — /token + binding on the token + auth-layer enforcement (FOUNDATION; the milestone)
**Goal:** the token carries the binding and the auth layer ENFORCES it — isolation becomes structural and real.
**Scope:**
- `/token` endpoint (PKCE verification, auth-code redemption, mints the access token). The token record carries `bound_workspace` (and a `granularity` field, populated minimally now / fully in T-P3-005).
- Auth layer (`auth.ts authenticate()` + the layer after it): an authenticated request may act ONLY on its token's bound workspace. Tool-call workspace resolution is constrained to the binding.
- Binding-violation attempts (a token targeting a non-bound workspace) are **rejected AND surfaced** (not silent).
- The `ambiguous_workspace` resolution path is simplified — under a binding there is no ambiguity; the explicit workspace arg validates against the binding rather than resolving against the global registry.
- **Consent broadcast filtered to unbound windows (now that binding state exists):** the consent request broadcasts only to windows WITHOUT an active binding — a window already bound to a claude.ai can't accept another binding, so it shouldn't prompt. ("Bound," not merely "connected" — every window is connected; filter on active-binding state, read live.) This progressively narrows the prompt set: the first binding still broadcasts to all unbound windows (named modal + dismiss-siblings guard it), but each subsequent binding prompts fewer, until the last prompts exactly one. A window freed by unbind (T-P3-003U) re-enters the set. **Edge case — all windows already bound:** broadcast reaches zero recipients → fail with a LEGIBLE message ("no unbound workspace available to bind; unbind one or open the intended workspace"), not the generic offline error.
**ACs (the isolation milestone):**
- AC-8: a token carries its bound workspace; `/token` issues it correctly (PKCE enforced).
- AC-9: **claude.ai-A (bound to workspace-A) can act on workspace-A.**
- AC-10: **claude.ai-A CANNOT act on workspace-B — the auth layer rejects it.** (The core isolation proof.)
- AC-11: a binding-violation attempt is surfaced (logged/reported), not silently denied.
- AC-12: with two bindings live, A⊥B and B⊥A both hold.
- AC-12b: consent broadcast excludes already-bound windows; with workspace-A bound, authorizing a second client prompts only the unbound workspace-B window. All-bound → legible refusal.
**── ISOLATION MILESTONE: at AC-12, the operator's original requirement (no cross-talk) is structurally met and testable. Independently valuable; could be used as-is even before the autonomy layer. ──**

### T-P3-005 — Gate re-key + per-operation granularity (AUTONOMY)
**Goal:** approval granularity becomes per-binding/per-operation, consulted by the gate.
**Scope:**
- Re-key the approval gate (`gate.ts`) from workspace-keyed to token/binding-keyed.
- Per-operation granularity (per_call / task / auto) read from the token/operation; set at handoff, fixed for the operation (fire-and-run, not changed in-flight).
- Resolve the `session_bypass` vestigial-mode ambiguity (recon #4 item 2) here.
**ACs:**
- AC-13: granularity is selected per operation and governs that operation's gating (per_call prompts each gated step; task approves once; auto runs within bounds).
- AC-14: granularity is fixed for an operation's duration (no in-flight change).
- AC-15: the gate consults the binding/token, not the workspace key; `session_bypass` ambiguity resolved.

### T-P3-006 — Gate categories + retry limit (AUTONOMY)
**Goal:** the always-gate floor and the autonomous-loop safety bound.
**Scope:**
- Wire §6 always-gate categories: sandbox-escape detection (acting outside the bound workspace + the pool live/ sandbox), irreversible-op detection, the recursive auth-system floor (the autonomy system can't autonomously modify its own gates/auth/binding).
- Product-repo push = granularity-governed (not always-gate).
- Pool live/ capture stays autonomous (firewalled sandbox).
- Retry limit N=3 on the autonomous restructure-reissue loop; Clyde voluntary-escalation honored.
**ACs:**
- AC-16: actions escaping the authorized sandboxes (other workspace, external, send/publish, money, deploy, irreversible) gate regardless of granularity.
- AC-17: the recursive floor holds — no autonomous modification of the autonomy/auth/binding system.
- AC-18: pool live/ capture runs autonomously (fire-and-forget); product-repo push follows the operation granularity.
- AC-19: the autonomous loop gates to human after N=3 restructure-reissue cycles.

### T-P3-007 — End-of-automation log + per-transaction report (AUTONOMY)
**Goal:** the accountability counterweight.
**Scope:**
- Daemon-captured mechanical interaction log (every dispatch/result/abort/restructure/gate-event/capture/push) — guaranteed, the authoritative spine.
- Orchestrator per-transaction report: walks the log, accounts for each transaction (purpose/kind/round-count/resolution), near-gate disclosure attached per-transaction. (The report-synthesis is orchestrator discipline / prompting; the LOG is the daemon code deliverable here.)
**ACs:**
- AC-20: the daemon log records every autonomous-loop transaction; cannot be omitted.
- AC-21: the report accounts for every logged transaction (omission is structurally visible); near-gates disclosed per-transaction.
- AC-22: a report is produced at the end of every autonomous operation regardless of granularity.

### T-P3-008 — Gate close (full acceptance + cross-platform + live smoke + snapshot)
**Goal:** P3′ acceptance.
**Scope:** acceptance harness covering the new ACs; Windows+WSL parity (AC-P3-13 lineage); AC-P3-12-lineage operator live smoke against real claude.ai end-to-end (two bindings); close snapshot. Expect 1–2 live-smoke follow-ups (design-anticipated).
**ACs:** all prior ACs verified under harness; cross-platform; live two-binding smoke passes; close snapshot written.

### Methodology codification (SEPARATE — not a P3′ code task)
The §5/§6.4 disciplines (pre-flight dispatch review; design-vs-implementation judgment; resolution-loop boundary; voluntary escalation; per-transaction report narrative) are prompting/methodology, not daemon code. They codify into the orchestrator/executor instructions and route to the methodology via the pool (the three candidates captured 2026-06-01 are the seed). Track separately from the code tasks.

---

## Open items to resolve in scope conversations (not blocking the plan)
- ~~T-P3-003: granularity at consent-time or operation-time?~~ **RESOLVED 2026-06-01: operation-time** — granularity is selected per autonomous operation at handoff (matches design §4 + the operator's "specify granularity for the operation I'm about to perform"). T-P3-003's modal is binding-only; T-P3-005 owns granularity entirely.
- T-P3-006: per-item BASH_DENY block-vs-gate decisions (§6.6); cost-threshold (all-gate vs budget).
- T-P3-005: exact `session_bypass` resolution (remove the vestigial mode, or repurpose it).
- **External-to-confirm at AC-P3-12 live smoke:** (a) claude.ai's actual `client_name` (meaningful per-project vs generic — determines whether the modal/statusbar show a name or only the client_id prefix); (b) claude.ai's re-registration behavior on `invalid_client` (determines whether post-unbind re-bind is graceful or manual-reconnect). Both have guaranteed floors (client_id prefix; manual reconnect), so neither blocks the build.

## Provenance
Derived from `05-autonomous-collaboration-model.md` §9 (impact map) and the recon passes (2026-06-01). Order A + two-binding test scope + revise-shipped-code per operator decisions 2026-06-01. Binding mechanism = **responder-binds** (decided after four recon passes: 3a and URL-encodes-workspace both ruled out by claude.ai-connector + exposure constraints). Misclick recovery = **targeted unbind pulled into P3′** (T-P3-003U, before token-persistence) per operator decision; the named modal + status-bar binding display are the prevention+inspection legs.

**End of P3′ build plan.**

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
  T-P3-002R  revise consent: bound workspace + targeted delivery        [revises shipped code]
  T-P3-003   reshaped modal: bind-this-workspace (+ granularity stub)
  T-P3-004   /token + token carries binding + AUTH-LAYER ENFORCEMENT
  ── ISOLATION MILESTONE ──  (two bindings; A⊥B proven)
AUTONOMY (layered on the proven binding)
  T-P3-005   gate re-key (workspace→token) + per-operation granularity
  T-P3-006   gate categories (sandbox-escape / irreversible / recursive floor) + retry limit N=3
  T-P3-007   end-of-automation log (daemon) + per-transaction report (orchestrator)
GATE CLOSE
  T-P3-008   full acceptance + cross-platform + live smoke + close snapshot
SEPARATE (not a code task)
  methodology codification of the §5/§6.4 disciplines → orchestrator/executor prompting, via the pool
```

---

## Tasks

### T-P3-002R — Revise consent to the binding model (FOUNDATION; revises shipped code)
**Goal:** the consent flow binds a client to a specific workspace, replacing the daemon-global broadcast model.
**Scope:**
- `ConsentRecord` / `AuthCodeRecord` gain a `bound_workspace` field (the workspace identifier the grant is bound to).
- The approving extension **supplies its own workspace identifier** at approve-time (it knows it from `register_workspace`/the active registry) — this is how consent learns which workspace to bind.
- Consent delivery shifts **broadcast → targeted**: the consent request goes to the workspace being bound, not all connected extensions. (Resolves the recon-#2 sibling-modal gap as a side effect — no siblings to dangle if delivery is targeted.)
- Remove the daemon-global assumption from the consent path (revise, don't leave dead parallel code).
**Out of scope:** the token (T-P3-004), enforcement (T-P3-004), granularity (T-P3-005).
**ACs:**
- AC-1: a consent grant records the bound workspace; `AuthCodeRecord` carries it.
- AC-2: consent request is delivered to the target workspace's extension, not broadcast.
- AC-3: the prior daemon-global broadcast path is removed (no dead parallel consent flow).
- AC-4: existing T-P3-001 DCR/metadata + T-P3-002 state-machine behavior otherwise preserved (transitions, timers, first-write-wins) except where binding changes them.
**Risk note:** touches shipped code (`consent.ts`, `main.ts` wiring). Pre-flight: diff against the shipped behavior; preserve the state-machine/timer correctness recon #2 documented.

### T-P3-003 — Reshaped consent modal: bind-this-workspace (FOUNDATION)
**Goal:** the extension-side consent modal communicates and confirms the *workspace binding*, not a generic approve/deny.
**Scope:**
- Extension-side `oauth-consent.ts` (greenfield, parallels `approval-modal.ts`): receives `auth_consent_request`, sends `auth_consent_ack` immediately, shows a modal naming the client AND the workspace being bound, sends `auth_consent_response`, handles `auth_consent_timeout`.
- Modal copy reflects binding: "claude.ai wants to bind to {workspace}" — accurate to what's granted (the operator must see *which workspace*).
- Two callback fields + two dispatch branches in `ipc/client.ts`; wired in `extension.ts`.
- (Granularity selection at consent: a STUB/placeholder here — full granularity is T-P3-005. Decide in the task's scope conversation whether granularity is set at consent or at operation-dispatch time.)
**ACs:**
- AC-5: modal shows the client + the bound workspace; approve binds, deny/dismiss don't.
- AC-6: `auth_consent_ack` sent on receipt (before modal resolves); `auth_consent_response` on decision; `auth_consent_timeout` closes/notifies (best-effort per recon #2 — daemon authority is the real guarantee).
- AC-7: AC-P3-3 (full, real-modal path) and AC-P3-5 (modal-close-on-timeout half) satisfied via the real extension, not the harness stub.

### T-P3-004 — /token + binding on the token + auth-layer enforcement (FOUNDATION; the milestone)
**Goal:** the token carries the binding and the auth layer ENFORCES it — isolation becomes structural and real.
**Scope:**
- `/token` endpoint (PKCE verification, auth-code redemption, mints the access token). The token record carries `bound_workspace` (and a `granularity` field, populated minimally now / fully in T-P3-005).
- Auth layer (`auth.ts authenticate()` + the layer after it): an authenticated request may act ONLY on its token's bound workspace. Tool-call workspace resolution is constrained to the binding.
- Binding-violation attempts (a token targeting a non-bound workspace) are **rejected AND surfaced** (not silent).
- The `ambiguous_workspace` resolution path is simplified — under a binding there is no ambiguity; the explicit workspace arg validates against the binding rather than resolving against the global registry.
**ACs (the isolation milestone):**
- AC-8: a token carries its bound workspace; `/token` issues it correctly (PKCE enforced).
- AC-9: **claude.ai-A (bound to workspace-A) can act on workspace-A.**
- AC-10: **claude.ai-A CANNOT act on workspace-B — the auth layer rejects it.** (The core isolation proof.)
- AC-11: a binding-violation attempt is surfaced (logged/reported), not silently denied.
- AC-12: with two bindings live, A⊥B and B⊥A both hold.
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
- T-P3-003: is granularity set at consent-time or at operation-dispatch time? (Affects whether T-P3-003 stubs it or T-P3-005 owns it entirely.)
- T-P3-006: per-item BASH_DENY block-vs-gate decisions (§6.6); cost-threshold (all-gate vs budget).
- T-P3-005: exact `session_bypass` resolution (remove the vestigial mode, or repurpose it).

## Provenance
Derived from `05-autonomous-collaboration-model.md` §9 (impact map) and the four recon passes (2026-06-01). Order A + two-binding test scope + revise-shipped-code per operator decisions 2026-06-01.

**End of P3′ build plan.**

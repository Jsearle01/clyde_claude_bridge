# 07 — FORWARD BOARD (master index of remaining work)

**Purpose:** the single "what's left / where are we" reference, across ALL buckets. The detailed work lives in the docs/dispatches this points to; this is the index so the roadmap isn't scattered across verdict tails. **Survives across chats** (the verdict-tail boards do not).
**As of:** 2026-06-08, after P3′ complete (Phases 0→5) + tunnel-lifecycle commit (A). Update this doc as items land.

**Status legend:** 🟢 done · 🔵 in-flight · 🟡 ready/scoped · 🟠 needs-recon-first · ⚪ deferred/blocked

---

## DONE (shipped + verified — context, not work)
- 🟢 **P3′ build sequence, Phases 0→5** — foundation (identity/resources/lock), rendezvous (advert/discovery), extension UI, orphaned-binding reclaim (always-takeover), extension menu (Stop daemon + approval-mode clamp). All on `main`, live-verified.
- 🟢 **Autonomy MECHANICAL SPINE** (per-transaction) — granularity-on-token, gate re-key, hard-deny floor (irreversible + recursive auth), delegation interaction log. (T-P3-004/005/006/007; confirmed BUILT by T-RECON-autonomy-layer.)
- 🟢 **Methodology candidate-pool + self-capture** — wired, write-scope proven, fired 3× this session.

---

## 1. AUTONOMY-LOOP LAYER  (the conceptual "after P3" — design authority: `05` §9 + `06`)
The spine is mechanism; the **loop is still discipline** (runs by hand through the operator). Making the loop daemon-mechanical is the major forward build. **Five absent pieces** (per T-RECON-autonomy-layer):
- 🟡 **Restructure-reissue loop + N=3 retry counter** — no daemon/CLI orchestration for the multi-cycle loop or the retry bound. (Was T-P3-006 AC-19 — partial; never shipped.)
- 🟡 **Loop-event + OAuth-bind logging** — extend the interaction log from *delegation-grained* to *autonomous-operation-grained* (pre-flight halts, abort-and-reports, restructure cycles, captures, pushes-as-loop-events). **AND** close the persistent OAuth-bind logging gap (binds + the Phase-4 takeover revoke/install produce NO log entry). (Was T-P3-007 AC-20 — partial.)
- 🟡 **General sandbox-escape gate** — only the floor's force-push/ref-deletion/auth-dir slices are blocked; a general "new external endpoint / publish externally" is *observed* (`push_observed`) not *blocked*. (Was T-P3-006 AC-16 — partial.)
- 🟡 **`session_bypass` collapse** — the legacy per-workspace mode still coexists with the OAuth-bound `resolveOperationGranularity` path.
- 🟡 **Orchestrator narrative / per-transaction accounting** — no code support; methodology expectation on top of the (delegation-only) log.
- **Companion (design done, build pending):** 🟡 **Operator cycle dashboard / aggregator app** (`06`) — separate app (NOT a VS Code panel — topology argument), discovers all daemons via the advert system, per-cycle-spool→ingest acquisition, app-owned persistent store (outlives the daemon), project→conversation→cycle collation, live + retrospective. **Constrains the loop's logging:** the loop must emit conversation-keyed, cycle-paired records (daemon-owned conversation-id via continue-or-new + held-state; both-ends daemon timestamps) designed for dashboard consumption from the start. Downstream of / co-designed with the loop.
- **Ready primitive:** the clamp `moreCautiousGranularity` (in `shared`) is ready for a per-operation override to consume.

## 2. DEFERRED CLUSTER  (post-P3′ hardening — NOT in any phase structure)
- 🟢 **Tunnel-lifecycle ownership + drop-recovery — COMPLETE** (T-TUNNEL-1; commits `ae06c2b` + `f77a279`):
  - 🟢 **(A) ownership invariant** (`ae06c2b`) — kill-before-respawn, launch-hidden (`windowsHide`), reclaim-orphan-on-startup (PRIMARY; pid persisted; the fix for the reopening-window repro), teardown confirmed already-fast on win32. (Noted limitation: pid-reuse window on reclaim — verify-by-name closes it if ever needed; deferred.)
  - 🟢 **(B) drop-recovery modal** (`f77a279`) — drop → respawn → IPC modal "adopt new URL X?" → confirm-adopts / deny-tears-down (rides (A)'s clean teardown, no orphan); no-extension fallback (pending + CLI status + fire-on-connect). AC-T-7 never-silent-adopt proven structurally (2 named tests, `url_pending` not `url_change`). Verified, redeployed.
  - Optional doc residual: mark `DESIGN-ITEM-tunnel-lifecycle-ownership.md` → BUILT (folds into the doc-hygiene pass).
- 🟢 **Full CLI multi-daemon conversion + display surface — COMPLETE** (T-CLI 1→4):
  - 🟢 **Targeting/conversion** (`0e6b0c3`) — unified `selectDaemonTarget`; per-daemon `stop`/`tail-log`/`token rotate`/`tunnel restart`/`unbind`; bare-`stop` misreport fixed.
  - 🟢 **`list` + `delete-dir`** (`ce60643`) — read-only inventory + destructive prune (typed-name, live-target confirm, graceful-stop-then-delete, floor-deny).
  - 🟢 **Render + pick fix** (`b5d05e1`) — workspace+name rendered; numbered pick for non-destructive verbs.
  - 🟢 **Shared-renderer class fix** (`4fe95ba`) — one `renderDaemonList` + unified enumeration (rendering centralized like targeting/selection); orphans prunable via `--hash`; pick render surface-tested.
  - 🟢 **`directories`** (`8d040fb`) — config-dir paths + identity + live/dead (verify-before-prune; own spare formatter).
  - 🟢 **`unbind` binding-list** (`4efa94b`) — daemon→bindings enumeration; bare lists (empty state "No active bindings"), typed-target revoke no-number, listing-never-clears.
  - Net: daemon layer (`list`/`directories`/selector+pick) + binding layer (`unbind`-list); shared surface-tested rendering; destructive verbs typed-target-no-number.
- 🟢 **Bearer auth path REMOVED — OAuth-bound is the only model** (T-BEARER-1; `839846e`): the unconstrained `{kind:"unconstrained"}` path deleted; the 2 isolation bypasses (`extension-router:240` workspace-enforcement, `gate:177` clamp) closed; `token rotate` + the Bearer display surface gone; `config.auth.token` RETAINED inert (strict-schema-no-migration — removal would brick existing configs). Every connection now workspace-bound/consent-gated/revocable; AC-10/AC-12 is the whole story. The `unbind` ordering recon + `token`-multi-daemon question resolved en route (token = genuinely converted; sweep clean).
- 🟠 **`unbind` ordering reshape** — the LAST buildable CLI item. Binding-presence-driven flow (fan-out bindings up front: 0→no-menu, 1-daemon-with-bindings→skip-the-pick, several→show-only-daemons-with-bindings). CLI-only, reuses the status IPC. Confirmed reshapeable (recon §D). Not yet drafted.
- 🟡 **Config-migration mechanism (future-work)** — the schema is `.strict()`/`version:literal(1)`/no-migration, so ANY field removal fails-validate existing on-disk configs + bricks daemons test-invisibly. A migration mechanism is the prerequisite for any schema evolution (surfaced by the Bearer field-retention). Not urgent; flag before the next schema change.
- ⚪ **Stable tunnel** (ADR-002) — operator opt-in; BLOCKED on the operator's domain decision (~$10/yr).

## 3. DOC-HYGIENE PASS  (the design docs are stale against ADR-001 — they will MISLEAD a reader)
- 🟡 **`04-p3-oauth.md`** — STALE: zero ADR-001 awareness; describes the superseded one-daemon-many-workspaces model. Reconcile to daemon-per-workspace, OR stamp "SUPERSEDED — see ADR-001 + `05` §9."
- 🟡 **`p3-prime-build-plan.md`** — STALE + superseded: built on the pre-ADR-001 two-bindings-in-one-daemon test model; lists T-P3-006/007/008 as whole when their loop-layer portions are absent. `05` §9 is already its corrected version. Stamp superseded-by-`05`-§9.
- 🟡 **`05` §4 (line ~52)** — "each operation may override at launch" is WRONG under the clamp (claude.ai can only *tighten*, never override-to-loosen). Fix to clamp/can't-loosen.
- 🟡 **`05` §3** — check the broadcast-is-structural wording (line 38 already reads correctly; confirm no residual "shifts toward targeted" elsewhere).
- 🟡 **Wire `06` into `05` §9** — the dashboard is the loop's operator-facing companion; `05` doesn't reference it yet.
- 🟡 **Reference tunnel-lifecycle in `05`** — `05` mentions only stable-tunnel, not the lifecycle/ownership work.
- 🟠 **`00`–`03` + `p3-build-plan`** — NOT yet assessed for the same ADR-001 staleness; check as part of the pass so the cluster is fully reconciled (or superseded-stamped).
- **Edit flow:** edit the `/mnt/user-data/outputs/` working copies, hand back to sync into the project (same flow that reconciled `05` §9). Do NOT edit `/mnt/project/` (read-only).

## 4. METHODOLOGY
- 🟡 **v0.8 reconciler run** — fully unblocked. Active set: seed 19 + live 33 (3 session captures + the 10 backfill). The natural methodology-bump capstone. Reads all feeders, drafts vNext into `drafts/`, names would-incorporate/close, STOPS (publishes nothing).
- ⚪ **Pending operator commits** — canonical dispatch-template → `Cluade_methodology_store/templates/dispatch-template.md`; delete stale Downloads export.

## 5. SMALL CLEANUPS  (bundle into whatever task touches their area)
- 🟡 Stale-matching-advert render oscillation (status bar).
- 🟡 Bare-stop UX hint.
- 🟡 (`session_bypass` collapse — also listed under §1; same item.)

## Candidate-adjacent principles surfaced this session (for the v0.8 run / pool)
- **Daemon enforces its own invariant at the call boundary; the agent supplies only the minimal input it alone is qualified to give** — the design signature across the granularity clamp (`gated-party-cannot-widen-its-own-gate`), unbind no-args-errors, and the conversation-id continue-or-new mechanism.
- **Store the raw observable alongside the interpreted grouping, so a wrong interpretation can be re-derived** (the dashboard timestamp-spine reasoning).
- **Dispatches written from observed symptoms reliably mis-locate the mechanism; the §0 read relocates it** (topology, revoke-verbatim, menu specifics, tunnel teardown-not-actually-slow — 4× this session).
- **Reclaim-by-persisted-pid has a recycle window; verify-by-name closes it** (tunnel (A) limitation).

---

**The map, one line:** P3′ + the autonomy spine are DONE; the **autonomy loop + its dashboard** (§1, design in `05`/`06`) are the major forward build; the **deferred cluster** (§2: tunnel in-flight, CLI needs-recon, stable-tunnel blocked) is post-P3′ hardening; the **doc-hygiene pass** (§3) makes the design docs trustworthy again; the **v0.8 run** (§4) is the methodology capstone.

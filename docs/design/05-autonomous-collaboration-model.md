# claude-bridge — Autonomous Collaboration Model (design)

**Status:** Design — agreed in P3 design conversation (2026-06-01). Supersedes the implicit daemon-global / per-call-approval model inherited from P1/P2 for the OAuth era. Reshapes the remaining P3 tasks (see §9).
**Relationship to existing docs:** complements `04-p3-oauth.md` (OAuth mechanics). Where this document and the inherited model conflict, this document is the intended target; `04-p3-oauth.md`'s daemon-global framing is the model being replaced.
**Methodology:** v0.7.

---

## 1. Why this exists (the problem)

Two operator requirements surfaced during P3 that the inherited architecture does not satisfy:

1. **Isolation.** The operator runs multiple claude.ai instances against multiple VS Code workspaces and needs each claude.ai bound to exactly one codebase — claude.ai-A can act on workspace-A and *cannot* reach workspace-B or C. Structural, not vigilance-based.
2. **Flexible autonomy.** claude.ai and Clyde (the executor) should resolve issues back-and-forth **autonomously** — implement, test, iterate — without the operator approving each step, while still **always stopping for design decisions and genuine concerns.** The approval altitude should be selectable per operation (whole-task hands-off, or finer-grained when the operator is watching closely).

The inherited model (recon #3, #4) provides neither: authentication is daemon-global (a token carries no workspace identity; any authenticated client can name any registered workspace), and approval is a single per-workspace gate on `delegate_to_claude_code` with three modes (`auto`/`per_call`/`session_bypass`) — no per-binding policy, no design-vs-implementation distinction, and no executor→human escalation beyond the upfront prompt.

These two requirements are not separate features. **They converge on one structure** (a per-binding grant record carrying both the bound workspace and the approval granularity) and they **reinforce** each other: the binding makes the autonomy safe to grant, because an autonomous operation's blast radius is contained by construction to one workspace.

---

## 2. The model in one paragraph

Each claude.ai instance is **bound** to exactly one workspace (Model 2 — structural isolation enforced on its OAuth token). When the operator hands off an autonomous operation, they **select a granularity** for that operation (from whole-task hands-off to per-step), fixed for that operation's duration. Within the operation, claude.ai (orchestrator) and Clyde (executor) work autonomously inside two **authorized sandboxes** — the bound workspace and the candidate pool's `live/` path. Clyde **reviews each dispatch before running it** and surfaces gaps/oversimplifications (pre-flight); if it discovers mid-run that the dispatch was flawed, it **aborts and reports** (no mid-run pause). The orchestrator then **restructures and reissues autonomously**, looping up to a retry limit — **until** it hits a design/decision point or a gate-boundary action, at which point it **stops for the human.** Actions that escape the authorized sandboxes or are irreversible always gate, regardless of granularity.

---

## 3. Binding (isolation — "Model 2")

- Each claude.ai instance is identified by a distinct `client_id` (Dynamic Client Registration already mints a fresh id per registration — recon #4 item 2).
- At consent/authorization time, the grant is **bound to a specific workspace**. The natural seam (recon #3 item 10): the **approving extension supplies its own workspace identifier** at approve-time — the extension already knows its workspace from `register_workspace`/the active registry, so the approving window reports "I am binding this workspace." (Contrast: the inherited consent flow broadcasts to all extensions and binds nothing.)
- The binding is recorded on the **grant/token record** (the token store T-P3-004 will create — which does not exist yet; this is the cheapest moment to define it). The token therefore carries `bound_workspace`.
- **Enforcement** is at the MCP auth layer (`auth.ts authenticate()` and the layer immediately after — recon #4 item 8 / recon #3 item 8): an authenticated request may act **only** on its token's bound workspace. Tool-call workspace resolution is constrained to the bound workspace rather than the daemon-global registry.
- **Consequence:** the inherited `ambiguous_workspace` resolution path (recon #3 item 9 / recon #4) becomes largely unnecessary — one client, one workspace, no ambiguity. The explicit `workspace` argument on tool calls shifts from "free resolution against all workspaces" to "validate against the binding (or ignore)."
- **Binding-violation attempts** (a client trying to act on a non-bound workspace) are **structurally blocked** by the auth layer AND **surfaced** (not silently denied) — an attempt is a signal something is wrong.

---

## 4. Per-operation granularity (flexible autonomy)

- Granularity is **selected at the start of an autonomous operation**, by the operator, for that operation. It is **fixed for that operation's duration** — NOT changeable in flight. (Operator decision 2026-06-01: "I want to specify granularity for the autonomous operation I am about to perform," explicitly not steering work in flight.)
- The spectrum reuses the existing modes (recon #4 item 1) as its basis:
  - **per_call** — approve each gated step (watching closely).
  - **task** — approve once; the operation runs to completion (hands-off for this task). (Maps to the existing session-bypass mechanic, recon #4 item 2.)
  - **auto** — runs within bounds without prompting (most hands-off).
- **A binding default granularity exists; an operation may only TIGHTEN it, never loosen it (the clamp).** Stored on the **per-daemon** grant/token record (the same record carrying `bound_workspace`). The binding default is the operator-set *ceiling*; an operation may request a MORE cautious granularity (finer — e.g. per_call when the default is task), and `moreCautiousGranularity` takes the stricter of the two. It can never request a coarser/looser granularity than the ceiling — the gated party cannot widen its own gate. One binding per daemon means the resolved granularity is unambiguously this operation's, for this workspace.
- **Fire-and-run:** once launched at a chosen granularity, the operation runs to completion at that granularity. To run finer, the operator launches the *next* operation finer (or cancels the current run — the existing AbortController, recon #4 item 4). The operator does **not** tighten a running operation.
- Granularity is stored on the same per-binding grant/token record as the workspace binding (recon #4 items 5-6 — both absent today, both co-locate on the not-yet-built token). The approval gate, currently workspace-keyed (`gate.ts`), is **re-keyed to the token/binding** so it consults the operation's granularity.

---

## 5. The autonomy floor — pre-flight review, abort-and-report, autonomous resolution loop

Autonomy governs execution of an *agreed, sound* dispatch. It does not mean executing a flawed one blindly.

### 5.1 Pre-flight review (executor discipline)
Before committing to an autonomous run, Clyde **reviews the dispatch** and surfaces gaps, oversimplifications, hidden assumptions, or scope problems the orchestrator may have missed — halting for resolution **before** the autonomous portion begins. This is the existing M-J hard-stop / §1.1 scope-check discipline, made explicit in the autonomy model. It is **methodology-enforced** (how Clyde is instructed to approach a dispatch), not a daemon gate — no code detects "this dispatch is oversimplified."

### 5.2 Mid-run discovery (abort-and-report)
If Clyde discovers *mid-run* that the dispatch was flawed (an assumption proves wrong three steps in), it **aborts the run and reports the concern.** It does **not** pause-and-ask. (Operator decision: this is acceptable; it forces the task to stop cleanly. Consistent with fire-and-run — no checkpointing, no pausable delegations.)

### 5.3 Autonomous resolution loop (orchestrator-level)
On an abort-and-report (or a pre-flight halt), the **orchestrator (claude.ai)** takes Clyde's concern, **restructures the dispatch** to address it, and **reissues** it — **autonomously, with no human** — as long as the concern is something the orchestrator can resolve by restructuring. This loop lives at the orchestrator level (claude.ai issuing a new `delegate_to_claude_code` after reasoning about the prior result); it requires **no new daemon architecture** (the abort/AbortController and re-dispatch both already exist — it is simply claude.ai making another tool call after reading the report).

**The loop halts and gates to the human when:**
- it hits a **design/decision point** (see §6 — the gate boundary the loop must respect), OR
- the **retry limit** is reached (N = 3 autonomous restructure-reissue cycles), OR
- the orchestrator recognizes it **cannot resolve the concern by restructuring.**

**Risk to manage (acknowledged):** the boundary "orchestrator resolves autonomously vs. gates to human" is a judgment, relocated to the orchestrator. The failure mode to guard against is the orchestrator restructuring *around* something that was actually a design decision the operator should have seen — papering over a real question. This is why §6's design/decision category is load-bearing for the loop, why the retry limit is a hard safety floor against a non-converging autonomous loop, and why the end-of-automation report (§5.4) is mandatory — it is the operator's *after-the-fact* check on exactly this failure mode.

### 5.4 End-of-automation report (the accountability counterweight)

The model deliberately removes the operator from the per-step loop. That trade creates an **observability debt**: the operator authorized an operation, stepped away, and must be able to learn what actually happened — including judgment calls the orchestrator made autonomously that the operator might, in hindsight, have wanted to weigh in on. **Every autonomous operation therefore concludes with an end-of-automation report from the orchestrator to the human.** This report is the counterweight that makes the autonomy safe to grant: per-step oversight is traded for *complete after-the-fact visibility*. It is **always produced**, regardless of granularity — even a fully hands-off "auto" operation ends with a report. It is not itself gated; it is the *conclusion* of every autonomous operation.

**Structure: the report is the log, annotated with meaning (operator decision 2026-06-01).** The report is not two parallel artifacts (a raw log and a separate summary) — that would let the narrative float free of the log and quietly omit a messy cycle. Instead, the **mechanical log is the authoritative spine**, and the orchestrator's narrative is built by **walking the log and accounting for every transaction in it.** Every logged transaction must be addressed; a logged transaction with no accounting is immediately visible as a gap. This fuses completeness (the log) with meaning (the per-transaction accounting) into one artifact that is both exhaustive and readable.

1. **Mechanical interaction log (daemon-captured, the authoritative spine).** The daemon records every autonomous-loop transaction it can see — each `delegate_to_claude_code` dispatch and its result, each pre-flight halt, each abort-and-report, each restructure-reissue cycle, each gate event, each pool capture, each push and destination. **Guaranteed; cannot be omitted by the orchestrator.** It is the authoritative list of what happened; the report must account for all of it.

2. **Orchestrator narrative, keyed per-transaction (claude.ai-synthesized).** The orchestrator — the only party with the whole picture — walks the log and, **for each logged transaction**, states:
   - **what the transaction was for** (its purpose in the operation),
   - **what kind it was** — e.g. a *standard dispatch* that ran clean; a *pre-flight hard-stop* from Clyde (and what Clyde objected to); an *abort-and-report* mid-run (and what was discovered); a *restructure-reissue* cycle (and **how many rounds** it took to resolve);
   - **how it resolved** — completed, restructured-and-retried, gated to human, etc.
   - and, where the transaction involved a judgment call near the gate boundary, the **near-gate disclosure** attached *to that transaction* (see below).

   The narrative is **factual / log-fidelity over interpretive** — "this dispatch was a hard-stop; Clyde flagged X; I restructured to address it; the reissue completed" — not "the run went well." The operator forms their own assessment by reading the accounted log.

This per-transaction structure makes omission structurally visible (every log entry needs an accounting), gives the mechanical log its human context, and surfaces the *texture* of the run — a string of clean standard dispatches reads very differently from one hard-stop that took three rounds, and the report makes that legible at a glance.

**Required contents of the report:**
- **Outcome vs. intent** (run-level) — what was accomplished, against the dispatched goal. Did it do what was asked?
- **Per-transaction accounting** (the spine, above) — every logged transaction addressed: purpose, kind, round-count, resolution.
- **Near-gates / judgment calls (REQUIRED, PROMINENT — the highest-value content), attached per-transaction.** Every decision the orchestrator made autonomously that was *close to* the design/implementation boundary — calls that did **not** gate but plausibly *could* have — disclosed against the specific transaction where the call was made. This is the operator's hindsight check on the §5.3 "papering-over" risk: it surfaces the judgment calls so the operator can catch a bad one after the fact even though it did not gate in the moment. A run where no transaction approached the gate boundary says so explicitly ("no decisions approached the gate boundary").
- **Autonomous-resolution summary** (run-level) — overall: did the loop converge cleanly, or struggle; was the retry limit approached or hit.
- **Gate events** — any transaction that hit an always-stop category (§6) and how it was handled (surfaced per-transaction; called out at run-level too).
- **Captures** — any methodology candidates written to the pool during the run.
- **Pushes** — what was pushed where (product repo? at what granularity-governed decision?), per §6.3.

**Enforcement layers (per §7):** the mechanical log is **daemon-enforced** (guaranteed). The narrative and especially the rigorous near-gate disclosure are **orchestrator discipline** (methodology/prompt-enforced) — but the mechanical log bounds how far the narrative can drift from truth, since the operator can read the log directly.

---

## 6. The gate boundary (D4) — what always stops for the human

### 6.1 Core principle (mechanical, subsumes destructive / external / binding-violation)
> **Gate when an action escapes the authorized sandboxes OR is irreversible. Run autonomously when it is within an authorized sandbox and reversible.**

- **Authorized sandboxes:** (1) the **bound workspace**; (2) the **candidate pool's `live/` path** (firewalled pool-scoped credential, append-only, reversible). Actions within either, that are reversible, run autonomously at the chosen granularity.
- **Within-sandbox + reversible → autonomous:** file edits, running tests, reversible refactors, in-workspace commits, **candidate-pool `live/` captures** (fire-and-forget — required for the live feeder; the pool credential structurally cannot reach anything else, so a pool push is categorically a bounded-reversible-isolated write, not a "scary shared-remote push"), and the **product-repo push of the bound workspace's work** (governed by the operation's chosen granularity — §6.3).
- **Escapes-sandbox OR irreversible → always gate, regardless of granularity:** acting on a non-bound workspace (structurally blocked + surfaced); external services / network to new endpoints; **sending or publishing anything externally**; **spending money** / deploying / production actions; **irreversible/destructive operations** (delete data, force-push, history rewrite, data-drop, `rm -rf`-class); and the recursive floor below.

### 6.2 The recursive floor (security/trust — non-negotiable)
The autonomy system **must never autonomously modify the autonomy/auth/binding system itself.** Clyde cannot restructure its way into widening its own permissions, changing its binding, altering gate categories, or touching credentials/tokens/trust config. Changes to the gates are always human.

### 6.3 The product-repo push (granularity-governed, not always-gate)
Pushing the bound workspace's completed work to claude-bridge's shared remote is **governed by the operation's chosen granularity**, not a hard always-gate. Rationale: under the binding, the work is already contained to the authorized workspace, so publishing *that* work is not a sandbox escape — it is the normal conclusion of an authorized operation. "Whole-task autonomous" includes the push; "watch closely" gates it. (Operator decision 2026-06-01.)

### 6.4 Design / intent decisions (judgment — methodology-enforced)
These **always gate**, and they are **also the boundary the §5.3 resolution loop must respect**:
- choosing between architecturally-different approaches (e.g. the Model-1-vs-Model-2 fork itself);
- changing a task's **intent** vs. its **implementation** (implementation → autonomous; intent change → gate);
- departing from the dispatch's stated goal;
- introducing a new dependency, framework, or external service;
- tradeoffs with no objectively-correct answer.

These cannot be mechanized (no code detects "this is a design fork"); they are **executor/orchestrator discipline**, as reliable as the methodology. The orchestrator may autonomously restructure around **implementation** problems but must gate on **design/intent** problems.

### 6.5 Loop-state safety (mechanical)
- **Retry limit:** after **N = 3** autonomous restructure-reissue cycles, gate to the human regardless.
- **Voluntary escalation:** Clyde may **choose** to gate to the human even when no category forced it (executor judgment override — it can always involve the human).

### 6.6 Deferred / open implementation questions (not blocking the model)
- **BASH_DENY items** (recon #4 item 4) are currently *silent-deny* (blocked, no human). Per-item, decide later whether some should convert to *gate* (ask) rather than *block* — e.g. `npm install` might warrant "ask" rather than hard-block.
- **Cost threshold:** whether "spending money" is all-gate or has a small autonomous budget — deferred (likely over-engineering for now; default all-gate).
- **`approve_session` vestigial-mode ambiguity** (recon #4 item 2): the persistent `session_bypass` mode value appears functionally indistinguishable from `per_call` in current code. Resolve during the gate re-key (§9).

---

## 7. Two enforcement layers (be honest about which is which)

- **Mechanical (daemon-enforced, reliable):** the binding and its auth-layer enforcement; sandbox boundaries; irreversible-op detection; the recursive auth-system floor; retry-limit counting; granularity lookup on the token; **the end-of-automation interaction log (§5.4) — guaranteed, cannot be omitted.**
- **Discipline (methodology/prompt-enforced, as-reliable-as-the-methodology):** pre-flight dispatch review; design-vs-implementation judgment; the resolution-loop boundary; voluntary escalation; **the end-of-automation narrative and its rigorous near-gate disclosure (§5.4) — bounded by the mechanical log, which the operator can read directly to check the narrative against ground truth.** This session demonstrated the discipline is real (Clyde halted on ambiguity repeatedly, invoked conventions by name) — but it is discipline, not a hard guarantee. The model deliberately puts the *catastrophic* floors (irreversible, security, sandbox-escape, binding) and the *accountability backstop* (the log) in the mechanical layer, and the *judgment* floors in the discipline layer.

---

## 8. What is NOT being built (scope discipline)

- **No interruptible/checkpointed delegations.** Delegations remain fire-and-run to completion (recon #4 item 4). Granularity is set at start, not steered in flight.
- **No mid-run pause-and-ask channel.** Mid-run discovery is abort-and-report, not pause.
- **No live granularity dial.** Granularity affects the *next* operation, never the current one.

These exclusions are what keep this a contained P3 expansion rather than a major architecture project. They follow directly from the operator's "don't steer in flight; specify per-operation" decision.

---

## 9. Impact on the P3 task plan (re-plan target)

The model reshapes the remaining P3 tasks. (Re-planning is a follow-up; this section is the impact map, not the new plan.)

> **⚠ This §9 is the 2026-06-01 re-plan snapshot. The per-transaction SPINE it lists as forward work has since SHIPPED (P3′ / T-P3-005 / T-BEARER-1) — see §9.1 for the shipped reconciliation. The status tags below are corrected inline; the LOOP-layer bullets remain accurately pending.**

- **T-P3-002 (consent state machine — already shipped):** the consent record must gain a **bound workspace** (supplied by the approving extension), and consent delivery shifts from **broadcast** toward **targeted-to-the-binding-workspace** (broadcast and per-workspace binding are in tension — recon #3 item 10). This revises shipped code.
- **T-P3-003 (consent modal — SHIPPED (the OAuth consent/binding flow is live — see §9.1)):** becomes "**bind this workspace + (optionally) set granularity**," not just approve/deny. The modal communicates *what workspace is being bound*, not just "allow claude.ai."
- **T-P3-004 (/token + auth layer — SHIPPED (the bound-token auth layer + binding enforcement are live; T-BEARER-1 then removed the legacy Bearer, leaving OAuth-bound as the only path — see §9.1)):** the token record carries **`bound_workspace` + `granularity`**; the auth layer **enforces the binding** (reject tool calls targeting a non-bound workspace) and **exposes the granularity** to the gate.
- **gate re-key + per-operation granularity — SHIPPED (T-P3-005):** `resolveOperationGranularity` + the tighten-only clamp (§4) are wired into the gate, which consults the binding's granularity ceiling. **STILL PENDING from this bullet:** the `session_bypass` collapse (the legacy mode still coexists).
- **New work — gate categories:** wire the §6 always-gate categories (sandbox-escape detection, irreversible-op detection, the recursive auth-system floor) and the retry-limit counter.
- **New work — end-of-automation report (§5.4):** the daemon-captured **mechanical interaction log** (every dispatch/result/abort/restructure/gate-event/capture/push in an autonomous operation) and the orchestrator-synthesized **narrative** delivered at operation end. The log is mechanical (daemon); the narrative + rigorous near-gate disclosure are methodology/prompt-enforced.
- **Methodology (not code):** the pre-flight-review, abort-and-report, resolution-loop-boundary, and voluntary-escalation disciplines (§5, §6.4) are codified in how dispatches/orchestration are instructed — they belong in the methodology / orchestrator-and-executor prompting, layered on the mechanical model.

### 9.1 Reconciliation — what has shipped since this design (2026-06)

*(Added by the doc-hygiene pass. The §9 above is the re-plan map as written 2026-06-01; this subsection records what has since SHIPPED against it, so the design doc no longer reads as if the spine is unbuilt.)*

**Auth model — OAuth-bound is now the ONLY path (T-BEARER-1, `839846e`):**
- The unconstrained static Bearer (`{kind:"unconstrained"}`) is REMOVED. `authenticate()` accepts only OAuth bound tokens → `{kind:"bound", workspace}`; a non-bound credential is rejected (`invalid_token`).
- This CLOSES the two isolation bypasses the Bearer carried: `extension-router` workspace-targeting enforcement and the `gate` operator clamp now apply to EVERY connection — no unconstrained exception. The §3 isolation model and the §4 clamp are now universal, not "primary path + a bypass."
- `token rotate` is removed; the `Token:`/`Bearer:` surface is gone from `start`/`status`. `config.auth.token` is retained inert in the strict, un-migratable config schema (see the config-migration future-work item).
- Any "manual/non-OAuth MCP client via Bearer" workflow text (README, `00-overview`) is SUPERSEDED — the daemon is reachable only via the OAuth binding flow.

**CLI — now FULLY converted to per-daemon (T-CLI 1→4):** a complete display/enumeration surface: unified `selectDaemonTarget` (`--name`/`--workspace`/asymmetric default + numbered pick for non-destructive verbs); `list` + `directories` (daemon-layer sight); `delete-dir` (typed-name prune, live-target confirm, graceful-stop-then-delete, floor-deny, `--hash` for orphans); `unbind` binding-list (binding-layer sight, typed-target revoke); all through one shared surface-tested renderer.

**Tunnel lifecycle (T-TUNNEL-1, `ae06c2b` + `f77a279`) — BUILT.** The daemon owns exactly one cloudflared for its life (kill-before-respawn, launch-hidden, reclaim-orphan-on-startup — the fix for the reopening-window repro). A dropped tunnel's rotated URL is an operator-confirmed adoption, never a silent strand (drop → respawn → IPC modal → confirm-adopts/deny-tears-down; no-extension fallback holds pending + re-fires on connect). The never-silent-adopt guarantee is structural (`url_pending` not `url_change`).

**Operator cycle dashboard (`06`) — design done, build pending, CONSTRAINS the loop layer.** The loop's operator-facing companion: a separate aggregator app (NOT a VS Code panel — daemon-per-workspace topology means one panel can't collate cross-project; `06` §"separate app"), discovering all daemons via the advert system, per-cycle-spool→ingest acquisition, app-owned persistent store (outlives the daemon). It CONSTRAINS the loop's logging: the loop must emit conversation-keyed, cycle-paired records (daemon-owned conversation-id via continue-or-new + held-state; both-ends daemon timestamps) designed for dashboard consumption from the start (`06` §8). Downstream of / co-designed with the loop.

---

## 10. Provenance

Arrived at in the P3 design conversation, 2026-06-01, grounded in three read-only reconnaissance passes:
- **recon #1** — current consent/IPC surface.
- **recon #2** — grant binding, sibling resolution, consent persistence (established the grant is client-global, consent ephemeral, connection-presence carries zero authorization).
- **recon #3** — current request-routing (plain terms) + Model-2 binding seams + original-intent check (established daemon-global was inherited from P1/P2, never an explicit P3 decision).
- **recon #4** — approval/autonomy model (established the workspace-keyed gate, the three modes, session-bypass, no policy layer, no mid-task escalation channel).

The multi-pass recon-before-design was deliberate: it prevented designing on a wrong mental model (the operator's assumed one-to-one binding vs. the built daemon-global) — caught because a downstream task (the consent modal) forced the assumption into the open. (See the methodology candidates captured from this conversation.)

**End of design document.**

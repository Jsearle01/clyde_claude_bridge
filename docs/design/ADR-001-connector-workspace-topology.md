# ADR-001 — Connector ↔ Workspace topology: daemon-per-workspace (Design B)

**Date:** 2026-06-06
**Status:** DECIDED (operator). Supersedes the implicit "one connector per claude.ai project = one workspace through a shared daemon" assumption that P3 was built under.
**Trigger:** the first live smoke surfaced that claude.ai connectors are **account-global and URL-keyed**, not project-scoped objects — invalidating the original mental model. Resolved through live investigation of the claude.ai connector UI.

---

## The constraint discovered (ground truth, observed live)
- A claude.ai connector is **account-global** and **identified by its URL** (the daemon's tunnel URL). One connector per URL.
- claude.ai **refuses to add a second connector at the same URL** ("already a connector for this daemon URL"). So you cannot point two connectors at one daemon.
- BUT: **connector ENABLEMENT is per-project.** In a given claude.ai project you can toggle individual connectors on/off. The connector *list* is account-global; which are *active* in a project is selectable. (Observed directly in project settings.)
- Naming: **connectors are named at creation** — so the account-global list can read "clyde-bridge" / "cocoai-bridge", not just opaque trycloudflare URLs.

This means the original assumption ("connectors are project-specific objects") was wrong about the MECHANISM, but the desired OUTCOME (one workspace per project) is achievable — via per-project **enablement**, not per-project connector identity.

## The decision: Design B — daemon per workspace
Each workspace runs **its own daemon → its own tunnel URL → its own named connector**, enabled per-project in claude.ai.
- **Isolation is PHYSICAL** — separate processes, separate file access, separate tunnels. Not dependent on a token-check code path.
- **Routing is controlled at TWO aligned layers:**
  1. Per-project connector **enablement** — enable only `clyde_claude_bridge`'s connector in that project; claude.ai cannot reach the others because they're off in that context.
  2. Daemon **workspace-lock** — each daemon serves exactly one workspace; `enforceBoundWorkspace` means a daemon physically cannot act outside its workspace even if reached.
- **Named connectors** make the right per-project choice obvious to the user.

## Why Design B (over the alternatives)
- **Fits claude.ai's model naturally** — one connector per URL, and you genuinely have one URL per workspace. The "duplicate connector at same URL" wall (which blocks the one-daemon-many-workspaces design) does not arise.
- **Serves BOTH audiences:** release users (retro-gaming community, Model-A per-user-daemon) typically bridge ONE project → one daemon, dead-simple mental model ("one connector = one workspace"). The operator (3 simultaneous projects) runs 3 named daemons — the multiplicity cost falls only on the power user best equipped to handle it (start-all script + named connectors).
- **Aligns with the original Model-A vision** — this is a refinement of the original direction, not a redesign away from it.
- **Strongest isolation** — physical separation can't be undone by a bug in a token-check, unlike the logical isolation of a shared-daemon design.
- The OAuth work is NOT wasted — claude.ai REQUIRES OAuth for custom connectors (the SMOKE-2 finding that launched P3); each daemon still does the full DCR→consent→bound-token flow, just with one binding per daemon.

## Alternatives considered + rejected
- **Design A (one daemon, many workspaces, one connector, multi-binding):** structurally awkward-to-impossible under claude.ai's one-connector-per-URL rule — a single connector carries a single bound token (one workspace; 403 otherwise), and you can't add a second connector at the same URL to bind a second workspace. Collapses to one-workspace-anyway.
- **Design A′ (one daemon, connector binds the daemon, workspace chosen per-conversation with per-conversation enforcement):** viable, lighter to run for the power user, but: more code, larger enforcement surface, logical (not physical) isolation, and it builds the most complex path for the SMALLEST audience (release users have one workspace and don't need per-conversation selection). **Deferred** as a possible future power-user mode IF running N daemons proves genuinely painful in practice — not built on speculation.

## Residual risk + backstop (honest)
- **Residual risk:** "the user selects/enables the wrong connector in a project." This is a per-project config choice, made once, visible (named connectors) — a normal user-config risk, NOT an architectural misrouting hole.
- **Backstop:** each daemon is workspace-locked. Worst case of a wrong-connector selection = a prompt runs against the wrong-but-still-isolated workspace (a contained, misdirected action) — NOT cross-workspace contamination. Blast radius is one isolated workspace, not a leak.
- **Confidence nice-to-have (backlog):** daemon surfaces "which workspace am I" in responses/status/startup so a misdirected prompt is obvious fast (adjacent to the build-hash/identity backlog item).

## What this CHANGES downstream
- **The A⊥B isolation test is REFRAMED.** The old test ("two bindings on one daemon cannot cross via enforceBoundWorkspace") is now MOOT — there is one binding per daemon. Isolation is PHYSICAL (separate daemons/processes/files), which is structurally true rather than something tested via the binding model. The smoke's A⊥B step should be replaced/reframed: verify two daemons are genuinely separate (different URLs, different file access, per-project enablement keeps them apart) — not "one daemon enforces two bindings."
- **The OAuth binding model is SIMPLER per daemon** — one binding per daemon; `enforceBoundWorkspace` becomes a workspace-lock guard (a daemon serves only its workspace) rather than a multi-binding discriminator. The machinery is unchanged; the multiplicity is gone.
- **`04-p3-oauth.md` and the P3 build plan should be reconciled** against this ADR — any assumption of "one daemon serving multiple bound workspaces" or "A⊥B on a single daemon" needs revising to the per-daemon-per-workspace topology. (Reconcile task, next session.)
- **The round-trip smoke (Part 5) is UNAFFECTED** — claude.ai → its workspace's daemon → Clyde → back is the same regardless of topology. Still the gate-defining test.
- **Multi-daemon operational ergonomics become a real concern** (start/stop/monitor N daemons; the ephemeral-URL churn multiplies; named-but-rotating connectors go stale on restart). Elevates the backlog **stable-tunnel-URL** item — with daemon-per-workspace, rotating URLs on every restart is materially more painful (re-point N connectors). A stable/named cloudflare tunnel per workspace becomes closer to required than nice-to-have.

## Open questions (next session)
1. Reconcile `04-p3-oauth.md` + build plan against this topology (revise the multi-workspace/A⊥B assumptions).
2. Decide the A⊥B test's new form (physical-separation verification).
3. Does A′ (multi-workspace single daemon) ever get built as a power-user mode, or is N-daemons acceptable long-term? (Defer until operator has lived with 3 daemons.)
4. Stable-tunnel-URL — promote from backlog given the multiplied churn under daemon-per-workspace.
5. Multi-daemon ergonomics — a start-all / status-all operator surface for running several daemons.

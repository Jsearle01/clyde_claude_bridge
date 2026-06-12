# ADR-002 — Stable tunnel URLs: operator opt-in, per-workspace config

**Date:** 2026-06-07
**Status:** DECIDED (operator). Records the stable-tunnel decision investigated this session against current Cloudflare facts. Builds at/after Phase 2b alongside the tunnel-lifecycle-ownership item. Does NOT affect 1c/2a/2b foundation work.
**Trigger:** ephemeral quick-tunnel URLs rotate on every restart → re-point N connectors each restart cycle under daemon-per-workspace (ADR-001 flagged this and elevated the stable-tunnel backlog item).

---

## Verified facts (web, 2026-06-07)
- **Cloudflare Tunnel itself is free** — every plan incl. free tier, unlimited tunnels, custom domains, no credit card. The "$7–8/user/mo" figures are Zero Trust *Access* (SSO/identity) — NOT needed, NOT the tunnel.
- **Stable URL requires a domain on Cloudflare DNS.** Named tunnels with custom hostnames need a Cloudflare-managed domain. Quick tunnels (`cloudflared tunnel --url`) are domain-free but the URL rotates each launch (today's mechanism).
- **Domain cost:** at Cloudflare Registrar a .com is ~$10.44/yr at-cost (registration = renewal, no markup; WHOIS privacy + DNSSEC free). Any already-owned domain works if its DNS is moved to Cloudflare (free) → $0 incremental. **One domain covers ALL daemons via subdomains** (`clyde.dom`, `cocoai.dom`) — cost does NOT scale with daemon count.
- **Operator does not currently own a domain** → opt-in cost is ~$10/yr for one domain.

## The decision
**Stable tunnel = operator opt-in. Quick tunnel stays the zero-config release default.** Same shape as ADR-001's A′ reasoning: the power-user cost (account, domain, setup) falls only on the power user; the retro-gaming Model-A release user keeps `claude-bridge start` → working URL with no account and no flag to know about.

### Per-workspace config, NOT a per-start flag
Tunnel mode is a property of the *workspace*, not a per-launch choice — the connector registered in claude.ai is pegged to one URL, so flipping modes between launches would break it. Therefore:
- A one-time **`claude-bridge tunnel setup --workspace X`** CLI verb configures a workspace for stable: registers/records the named tunnel + subdomain, stores the **token/named-tunnel identity in that workspace's per-daemon config-dir** (alongside tokens.json).
- **`start` is mode-agnostic:** reads the workspace's tunnel config — token present → run the named tunnel at the fixed subdomain; absent → quick-tunnel fallback (the default). The operator never passes a tunnel flag at start.

### Local ingress at startup (composes with next-free port)
The daemon writes its ingress (subdomain → its *actual bound port*) **locally at launch**, so 1b/1c next-free port allocation still works — a named tunnel's hostname→port mapping tracks whatever port the daemon bound this run. (Locally-managed ingress, not cloud-managed, for this reason.)

### Symmetric teardown — `tunnel teardown`, NOT a tunnel-aware delete
A stable workspace has state in THREE places: the local config-dir (binding/tokens), the claude.ai connector (account-side, daemon can't reach — the ghost-connector problem), and now the **Cloudflare named tunnel + DNS record** (account-side, daemon can't reach by deleting a local dir).
- **`tunnel teardown`** is the mirror of `tunnel setup`: removes the named tunnel + DNS record from Cloudflare and clears the local tunnel config.
- **`delete-dir` stays purely local** (no Cloudflare-auth dependency bolted on). It **detects** a stable-configured workspace and warns/refuses with "run `tunnel teardown` first" rather than silently orphaning the cloud tunnel or reaching into the cloud itself.
- **Why separate (the operator's reasoning):** a quick-tunnel user (the default) has no account and no tunnel to tear down; a tunnel-aware `delete-dir` would saddle every user with cloud-auth machinery almost none need. Local verbs stay local; cloud verbs carry the cloud weight; the weight falls only on whoever opted in.

## What this is NOT
- NOT a release default (quick stays default; no account/domain for the typical user).
- NOT a per-start flag (per-workspace config, set once).
- NOT a daemon-cleans-the-cloud mechanism (the daemon can't reach claude.ai connectors or Cloudflare account state; stable URLs *prevent* stale connectors by never rotating, rather than cleaning them).
- NOT blocking 1c/2a/2b — a drop-in at the daemon's tunnel-spawn step.

## What it simplifies downstream (knock-on benefits)
- The **2a advert-content** question (DESIGN-NOTE-2a) gets easy for stable workspaces: a stable URL is worth advertising; a rotating one is noise.
- The **tunnel-lifecycle** auto-respawn tension (DESIGN-ITEM-tunnel-lifecycle) softens: a respawned *named* tunnel returns to the SAME URL, so auto-respawn becomes safe rather than disruptive.
- Connectors created **once per workspace, never re-pointed** — retires the N-connector re-point churn ADR-001 flagged.

## Open build-time questions (decide at dispatch, not now)
1. **`tunnel setup` provisioning depth:** full Cloudflare-API provisioning (create tunnel + DNS automatically) vs **dashboard-first** (operator creates the named tunnel in the dashboard; the command just records the pasted token). **Lean: dashboard-first for v1** — far less code, no API-orchestration surface.
2. **`delete-dir` on a stable workspace: refuse vs warn-and-proceed.** Lean: warn-and-proceed, consistent with its confirm-and-proceed posture for live daemons (typed confirm), but surface the orphan clearly.
3. Cloudflare auth shape the setup/teardown verbs assume (`cloudflared login` vs an API token) — confirm at §0 ground truth.

## Sequencing
Builds at/after **Phase 2b**, alongside the tunnel-lifecycle-ownership item (named vs quick spawn live in the same code). Depends on 1b (per-daemon config-dir holds the token) + the tunnel-lifecycle work (one-tunnel-per-daemon ownership). The `tunnel setup`/`teardown` verbs join the operator-CLI surface (with `list`/`delete-dir`). Carries the standard conventions when dispatched (t0 stamp, etc.).

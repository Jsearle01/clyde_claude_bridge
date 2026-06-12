# P3′ Build Sequence — ADR-001 (daemon-per-workspace) implementation roadmap

Derived from ADR-001 (+ Addenda 1–6). Eight bite-sized phases, dependency-ordered, each leaving the system working. Dispatch one at a time (Clyde works best single-concern). The riskiest assumption (path-normalization match) is proven FIRST; orphaned-binding reclaim is LAST (it's designed for the daemon-per-workspace world, so it follows the topology it depends on — building it earlier = building against an architecture about to be replaced).

Conventions carry: single-prompt-with-everything dispatch, verdict+commit same cycle, §0 git-status+read-first, C-25.1 fresh evidence, clean-build mandatory per code-touching task (v0.8), packaged-artifact-redeploy when extension code changes (v0.8), C-35 measured + t0-stamped-at-receipt.

---

## Phase 0 — Path-normalization proof (SPIKE — de-risk the make-or-break)
**Goal:** prove the daemon's normalized `--workspace` input and the extension's `workspaceFolders[0].uri.fsPath` produce a BYTE-IDENTICAL canonical string for the same folder. (Addendum 4 — this is the single assumption the whole pairing mechanism rests on; if it's wrong, everything downstream silently fails to match.)
**Touches:** a normalization function (daemon side) + a logging probe (extension side). Likely no production wiring yet — a spike/recon with a test.
**Proof of done:** logged comparison showing daemon-normalized path == extension fsPath, byte-for-byte, for the same folder on Windows (verify the observed rules: lowercase drive letter, backslashes — confirm against VS Code's ACTUAL output, don't assume). A test asserting the equality. Report the exact normalization rules VS Code uses.
**Dependency:** none. Do FIRST.
**Why a standalone spike:** a failed assumption here invalidates Phases 1b/2; proving it cheaply up front de-risks the whole chain.

## Phase 1a — Identity inputs + canonical normalization
**Goal:** `--workspace <path>` + `--name <label>` both required at `start`; daemon computes its canonical identity from the normalized workspace path (Phase 0's proven rules). (Addendum 4.)
**Touches:** CLI arg parsing (start), the identity/normalization module.
**Proof of done:** start requires both flags (errors without); daemon logs/exposes its computed canonical identity; name captured as the label. No resource-scoping yet (that's 1b). Single-folder only (multi-root rejected with a clear message).
**Dependency:** Phase 0 (uses the proven normalization).

## Phase 1b — Per-daemon resources (config-dir + port + pipe-name)
**Goal:** derive the daemon's config/state dir, port, and pipe/socket name from its identity, so two daemons don't collide. (Addendum 1, 4.)
- config-dir: `%APPDATA%\claude-bridge\<id>\` (tokens.json, pid, audit.jsonl, interaction.jsonl, transcripts all move under it)
- port: auto-increment from 7423 to next free; `--port` override
- pipe/socket name: derived from `<id>`
**Proof of done:** two daemons (different workspaces) started simultaneously each get their own dir/port/pipe, no collision; existing single-daemon case still works (don't break it); files land in the per-daemon dir.
**Dependency:** Phase 1a (identity is the key).
**Risk note:** the biggest foundational change (state-dir migration) — verify no cross-daemon disk collision explicitly.

## Phase 1c — Re-scope the single-instance lock (multi-instance becomes real)
**Goal:** lock keys on the canonical identity — same-workspace double-start REFUSES (preserves the locked refuse-incumbent decision), different-workspace ALLOWED. (Addendum 1.)
**Touches:** the single-instance lock (currently the global port-bind / pid logic).
**Proof of done:** **two daemons for DIFFERENT workspaces run simultaneously** (the headline outcome); a SAME-workspace second start refuses with the incumbent untouched; the port-bind lock still does per-port refusal.
**Dependency:** Phase 1b (port/pipe must already be per-daemon, or the lock has nothing distinct to key on).

## Phase 2a — Daemon advertises
**Goal:** on startup, write the advertisement file `%APPDATA%\claude-bridge\daemons\<id>.json` {canonical_workspace, name, port, pipe, pid, started_at}; remove on graceful exit; on startup reclaim/overwrite a stale own-id advert. (Addendum 5.)
**Proof of done:** starting a daemon writes its advert; graceful stop removes it; a crashed-then-restarted daemon reclaims its own stale advert; advert carries the canonical_workspace (Phase 0 form).
**Dependency:** Phase 1b (needs the per-daemon port/pipe to advertise).

## Phase 2b — Extension discovery + auto-pair (auto-pairing works end-to-end)
**Goal:** extension reads own fsPath → scans `daemons/` → matches canonical_workspace → connects via the hello/register handshake (handshake = liveness proof, NOT pid check) → if no match yet, WATCHES the dir and connects when one appears. (Addendum 5.)
**Proof of done:** start a daemon for a workspace + open that workspace in VS Code (either order) → they auto-pair with NO manual step; stale advert → ignored; no daemon → extension waits and pairs when one appears. **Build-time: confirm daemon-advertised path == extension fsPath byte-identical (Phase 0 underwrites this).** Authorizing before pairing correctly yields extension_offline.
**Dependency:** Phases 2a (advert exists) + 1c (multiple daemons can run). Extension code → packaged-artifact-redeploy (repackage VSIX + operator install steps).

## Phase 3 — Extension status-bar UI rewrite + manual re-scan fallback
**Goal:** rewrite the status-bar menu from connection-MANAGER to connection-STATUS + escape-hatches (Addendum 6): show paired daemon (name+pid)/workspace/live?/binding; keep unbind; add the manual re-scan; strip the obsolete manual-wiring options (daemon selection, trust-then-register, retry, mode).
- **Manual re-scan:** re-run discovery on demand; **terse on success** ("Connected to daemon '<name>' successfully"); **full diagnostic ONLY on failure** (no matching advert / found-but-stale handshake-failed / show existing adverts so a path near-miss is visible).
**Proof of done:** the rewritten menu shows pairing state; obsolete options gone; re-scan connects + reports per the terse/diagnostic rule. Extension code → packaged-artifact-redeploy.
**Dependency:** Phase 2b (UI displays/overrides the pairing that 2a/2b built).

## Phase 4 — Orphaned-binding reclaim (LAST — designed for this topology)
**Goal:** reclaim-on-fresh-consent, always-takeover (Addendum 3): a new authorization for an ALREADY-BOUND workspace proceeds to consent (not refused); on approval, revoke the old binding + install the new; modal DISCLOSES the replacement ("…this will replace the existing connection bound [date]"). Non-approval leaves the old binding intact.
**Proof of done:** a workspace with a stale/existing binding can be re-bound via fresh consent (takeover); the modal discloses the replacement; the old token is revoked on takeover; deny/dismiss/timeout leaves the existing binding. Safe because consent is human-gated in the user's own VS Code (no remote-takeover vector).
**Dependency:** the daemon-per-workspace topology (Phases 1–2) — reclaim is designed for that world; building it earlier means building against the about-to-be-replaced architecture. The manual `unbind` (already built) covers the re-bind pain in the meantime.

---

## Sequence at a glance
0 (proof) → 1a (identity) → 1b (resources) → 1c (lock → multi-instance works) → 2a (advertise) → 2b (auto-pair works) → 3 (UI + re-scan) → 4 (reclaim).

## Notes
- Each phase leaves the system working; don't half-migrate.
- Phases 2b and 3 touch extension code → packaged-artifact-redeploy rule (repackage VSIX, operator install steps, verify running==built).
- The path-normalization match (Phase 0, underwriting 2b) is the highest-risk assumption — proven first, re-verified at 2b.
- Reconcile `04-p3-oauth.md` + the old build plan against ADR-001 = release-prep hygiene (bundle with the stale-README update), NOT a build blocker — builds flow from ADR-001/this sequence, not the old docs.

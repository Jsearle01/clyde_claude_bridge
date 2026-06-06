// T-P3-008 (automated gate-close): P3′ acceptance suite.
//
// Run as a single acceptance pass:
//   cd packages/daemon && npx vitest run tests/acceptance/p3-acceptance.test.ts
// (or the full `npm test --workspaces` includes it.)
//
// PHILOSOPHY: this suite provides COHERENT end-to-end coverage of the P3 ACs
// as a set. Where a per-task unit/integration test already covers an AC, this
// suite REFERENCES it (see the coverage matrix below) rather than duplicating.
// Its genuine ADD is the end-to-end ISOLATION CHAIN — TokenStore.mint →
// authenticate → WorkspaceBinding → tool enforcement — which no single unit
// test wires together (the unit tests prove the segments in isolation).
//
// Live-only ACs are marked operator-smoke-deferred (it.skip) — NOT faked.
//
// ── P3 AC COVERAGE MATRIX ────────────────────────────────────────────────
// AC-8  token carries binding + /token PKCE ....... oauth/token-endpoint.test.ts,
//                                                   oauth/token-store.test.ts
// AC-9  A acts on A ............................... THIS suite (chain) + get_open_editors.test
// AC-10 A cannot act on B (core isolation) ........ THIS suite (chain) + get_open_editors.test
// AC-11 violation surfaced (logged), not silent ... THIS suite (403+reason) + extension-router enforce
// AC-12 two-binding A⊥B & B⊥A .................... THIS suite (chain) + get_open_editors.test
// AC-12b broadcast filter + all-bound refusal ..... oauth/consent.test, ipc/server.test, oauth/authorize.test
// AC-12c unbind teardown + binding_cleared ........ ipc/server.test, oauth/token-store.test, status-bar-menu.test (ext)
// AC-12d revoked token rejects (inverse-isolation). THIS suite + oauth/token-store.test (AC-12d)
// AC-12e re-bind after unbind ..................... OPERATOR-SMOKE-DEFERRED (claude.ai re-register behavior)
// AC-13 granularity per_call/task/auto ............ approval/gate.test, mcp/tools/delegate.test
// AC-14 granularity fixed per operation ........... approval/gate.test (no in-flight mutation path)
// AC-15 gate consults binding; session_bypass res . approval/gate.test (resolveOperationGranularity)
// AC-16 floor: irreversible/sandbox-escape ........ jobs/floor.test (+ THIS suite Windows-path re-check)
// AC-17 recursive floor (~/.claude-bridge) ........ jobs/floor.test (+ structural: no MCP tool modifies auth)
// AC-18 pool-capture autonomous / push granularity. METHODOLOGY (pool: authorization-scope-discipline) — not code
// AC-19 N=3 restructure-reissue limit ............. METHODOLOGY (pool: n3-orchestrator-restructure-limit) — not code
// AC-20 daemon log records every transaction ...... audit/interaction.test, mcp/tools/delegate.test
// AC-21 report accounts for every transaction ..... METHODOLOGY (pool: per-transaction-accountability-report-format)
// AC-22 report produced every operation ........... METHODOLOGY (same) — orchestrator discipline
// AC-P3-12 live claude.ai end-to-end .............. OPERATOR-SMOKE-DEFERRED
// AC-P3-13 Windows/WSL parity ..................... THIS suite (floor Windows-path) + cross-platform run (operator/WSL)
// ─────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { TokenStore } from "../../src/oauth/token-store.js";
import { authenticate, type WorkspaceBinding } from "../../src/mcp/auth.js";
import { makeGetOpenEditorsTool } from "../../src/mcp/tools/get_open_editors.js";
import { ExtensionToolRouter } from "../../src/mcp/tools/extension-router.js";
import { checkToolFloor } from "../../src/jobs/floor.js";
import { ToolHandlerError, type ToolContext } from "../../src/mcp/dispatch.js";
import type { AuditLog } from "../../src/audit/log.js";
import type { Logger } from "../../src/log/logger.js";
import type { DaemonState } from "../../src/state.js";

const STATIC_BEARER = "cb_live_ACCEPTANCESTATICBEARERTOKENXXXX";
const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};
const stubState = {
  version: "0.1.0",
  startedAt: 0,
  tunnelStatus: "up",
  tunnelUrl: null,
  config: {} as never,
} as DaemonState;

// Two registered workspaces — the two-binding test scope.
function twoWorkspaceRegistry() {
  const ws = (id: string) => ({ id, abs_path: `/p/${id}`, default_mode: "agentic" as const });
  return {
    list: () => [ws("ws-a"), ws("ws-b")],
    resolve: (id?: string) => (id === "ws-a" || id === "ws-b" ? ws(id) : null),
    default: () => null,
  };
}
function respondingRouter(): ExtensionToolRouter {
  const router = new ExtensionToolRouter((_, request) => {
    const req = request as { request_id: string };
    setImmediate(() =>
      router.resolveResponse({
        kind: "get_open_editors_response",
        request_id: req.request_id,
        editors: [],
      }),
    );
    return Promise.resolve();
  });
  return router;
}
function ctxWith(binding: WorkspaceBinding): ToolContext {
  return {
    request_id: "req_acc",
    remote_addr: "tunnel",
    workspaceBinding: binding,
    auditLog: {} as AuditLog,
    logger: silentLogger,
    state: stubState,
    setAuditMetadata: () => undefined,
  };
}
function reqWith(token: string): IncomingMessage {
  return { headers: { authorization: `Bearer ${token}` } } as IncomingMessage;
}

let dir: string;
let store: TokenStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cb-p3acc-"));
  store = new TokenStore(join(dir, "tokens.json"));
  await store.load();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// The injected OAuth lookup (wraps TokenStore.lookup), exactly as main.ts wires it.
function lookup(token: string): { bound_workspace: string | null; granularity: null } | null {
  const b = store.lookup(token);
  return b === null ? null : { bound_workspace: b.bound_workspace, granularity: null };
}
// Resolve a presented token → its WorkspaceBinding via the real auth layer.
function bindingFor(token: string): WorkspaceBinding {
  const r = authenticate(reqWith(token), STATIC_BEARER, lookup);
  if (!r.ok) throw new Error(`auth failed: ${r.reason}`);
  return r.binding;
}

describe("P3 ACCEPTANCE — isolation chain end-to-end (AC-8/9/10/11/12)", () => {
  it("AC-8/AC-9/AC-10/AC-12: two bound tokens; each acts on its own workspace, NOT the other", async () => {
    const a = await store.mint({ client_id: "cb_client_a", bound_workspace: "ws-a" });
    const b = await store.mint({ client_id: "cb_client_b", bound_workspace: "ws-b" });
    const tool = makeGetOpenEditorsTool({
      registry: twoWorkspaceRegistry(),
      extensionRouter: respondingRouter(),
    });
    const bindingA = bindingFor(a.access_token);
    const bindingB = bindingFor(b.access_token);

    // AC-9: A acts on A (explicit + implied).
    expect((await tool.handler({ workspace: "ws-a" }, ctxWith(bindingA))).editors).toEqual([]);
    expect((await tool.handler({}, ctxWith(bindingA))).editors).toEqual([]); // binding implies ws-a
    // AC-12: B acts on B.
    expect((await tool.handler({ workspace: "ws-b" }, ctxWith(bindingB))).editors).toEqual([]);

    // AC-10 (core proof) + AC-12 (A⊥B, B⊥A): cross-workspace rejected.
    await expect(tool.handler({ workspace: "ws-b" }, ctxWith(bindingA))).rejects.toMatchObject({
      code: 403,
      reason: "workspace_not_bound",
    });
    await expect(tool.handler({ workspace: "ws-a" }, ctxWith(bindingB))).rejects.toMatchObject({
      code: 403,
      reason: "workspace_not_bound",
    });
  });

  it("AC-11: a binding-violation is surfaced as a legible 403 (not a silent allow)", async () => {
    const a = await store.mint({ client_id: "cb_client_a", bound_workspace: "ws-a" });
    const tool = makeGetOpenEditorsTool({
      registry: twoWorkspaceRegistry(),
      extensionRouter: respondingRouter(),
    });
    let err: unknown = null;
    try {
      await tool.handler({ workspace: "ws-b" }, ctxWith(bindingFor(a.access_token)));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ToolHandlerError);
    expect((err as ToolHandlerError).message).toMatch(/bound to workspace 'ws-a'/);
  });

  it("AC-12d (inverse-isolation): after unbind, the revoked token authenticates as INVALID (not unconstrained)", async () => {
    const a = await store.mint({ client_id: "cb_client_a", bound_workspace: "ws-a" });
    expect(bindingFor(a.access_token)).toEqual({
      kind: "bound",
      workspace: "ws-a",
      granularity: null,
    });
    await store.revokeByWorkspace("ws-a"); // unbind
    const after = authenticate(reqWith(a.access_token), STATIC_BEARER, lookup);
    expect(after).toEqual({ ok: false, reason: "invalid_token" }); // NOT {kind:"unconstrained"}
    // The freed workspace re-enters the unbound set.
    expect(store.hasActiveBindingFor("ws-a")).toBe(false);
  });

  it("the legacy static Bearer stays unconstrained (coexistence preserved)", () => {
    const r = authenticate(reqWith(STATIC_BEARER), STATIC_BEARER, lookup);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.binding).toEqual({ kind: "unconstrained" });
  });
});

describe("P3 ACCEPTANCE — floor holds incl. Windows path semantics (AC-16/17, AC-P3-13)", () => {
  // The 006 floor uses node:path (platform-aware), so drive-letter + backslash
  // semantics are handled natively. These assertions run on the host OS.
  //
  // T-P3-008 PARITY FINDING (now fixed): the floor's path comparison was
  // case-SENSITIVE, but the Windows FS is case-INSENSITIVE. A case-variant of
  // the auth-dir path (`c:\users\jay\.claude-bridge` vs `C:\Users\jay\...`)
  // therefore SLIPPED the ~/.claude-bridge self-protection (a silent
  // UNDER-block — an isolation hole, not the safe over-block I'd first assumed).
  // floor.ts now case-folds all path comparisons on win32 (canon()); the
  // case-variant test below is the regression guard.
  const WS = join(tmpdir(), "acc-ws");
  const CFG = join(tmpdir(), "acc-cfg", ".claude-bridge");
  const bash = (cmd: string) => checkToolFloor("Bash", { command: cmd }, WS, CFG);
  const write = (p: string) => checkToolFloor("Write", { file_path: p }, WS, CFG);

  it("AC-16: irreversible ops denied (force-push, rm-rf outside, .git/root deletion)", () => {
    expect(bash("git push --force origin main").denied).toBe(true);
    expect(bash(`rm -rf ${join(WS, "..", "elsewhere")}`).denied).toBe(true);
    expect(bash("rm -rf .git").denied).toBe(true);
    expect(bash("rm -rf .").denied).toBe(true);
  });

  it("AC-17: recursive auth-floor — ~/.claude-bridge writes denied (Bash + Write)", () => {
    expect(bash(`cat ${join(CFG, "tokens.json")}`).denied).toBe(true);
    expect(write(join(CFG, "tokens.json")).denied).toBe(true);
  });

  it("AC-P3-13: floor path-inspection works on host path semantics (drive letters / separators)", () => {
    // An absolute outside path in host form is denied; an in-workspace path is not.
    expect(bash(`rm -rf ${join(WS, "..", "x")}`).denied).toBe(true); // outside → denied
    expect(bash("rm -rf node_modules").denied).toBe(false); // in-workspace → allowed
    expect(write(join(WS, "src", "a.ts")).denied).toBe(false); // in-workspace write → allowed
    // process.platform recorded so the parity result is attributable to the OS it ran on.
    expect(["win32", "linux", "darwin"]).toContain(process.platform);
  });

  it("AC-P3-13 (parity-finding regression): a case-variant auth-dir path is floored per host FS case semantics", () => {
    const variant = join(CFG.toUpperCase(), "tokens.json"); // case-swapped path
    if (process.platform === "win32") {
      // Case-insensitive FS → the variant names the SAME auth dir → MUST deny.
      // (Was a silent under-block before the T-P3-008 canon() fix.)
      expect(write(variant).denied).toBe(true);
      expect(bash(`cat ${variant}`).denied).toBe(true);
    } else {
      // Case-sensitive FS → the upper-cased path is a genuinely different dir →
      // correctly NOT floored (case-folding here would be wrong on POSIX).
      expect(write(variant).denied).toBe(false);
    }
  });
});

describe("P3 ACCEPTANCE — operator-smoke-deferred (live claude.ai; NOT faked)", () => {
  // These ACs can ONLY be confirmed by the operator running the live smoke
  // against real claude.ai. They are deliberately NOT simulated/stubbed — a
  // faked live-smoke result is exactly the fabricated-confirmation the
  // calibration episode warned against. Marked skipped with explicit names.
  it.skip("AC-P3-12: real claude.ai DCR → /authorize → consent modal → /token → bound delegation (operator-run)", () => {
    // Operator protocol: configure claude.ai connector with the tunnel URL,
    // trigger OAuth, approve in the VS Code modal, delegate. Reveals client_name
    // (meaningful vs generic) + modal readability — external-to-confirm.
  });
  it.skip("AC-12e: post-unbind re-bind smoothness (graceful re-prompt vs manual reconnect — operator-run)", () => {
    // Daemon half (revoked token → invalid_token) is proven above (AC-12d).
    // The claude.ai re-registration behavior on invalid_client is live-only.
  });
});

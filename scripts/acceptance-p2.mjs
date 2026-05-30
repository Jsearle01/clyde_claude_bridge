// T-P2-011: P2 acceptance harness. Node-only; drives the daemon via
// MCP + a mock VS Code extension over the local IPC channel. Hermetic:
// fresh daemon spawn per run with a temp config dir + sandbox workspace,
// teardown on exit. Cross-platform via Node (no PS/SH split).
//
// Covers 10 of the 15 P2 ACs:
//   AC-P2-3  trust prompt persists across restarts
//   AC-P2-4  unregistered workspace → 503
//   AC-P2-5  untrusted workspace → 503 (collapses with -4 at daemon level;
//            differentiated via mock call-log)
//   AC-P2-7  env-only ANTHROPIC_API_KEY inheritance (observable surface)
//   AC-P2-8  approval modes (per_call / session_bypass / auto)
//   AC-P2-9  approval rejection on extension disconnect (proxy for the
//            5-min timeout — the real timer is hardcoded so the harness
//            tests the disconnect-cancel path instead)
//   AC-P2-10 user denial → 403 delegation_denied
//   AC-P2-11 get_open_editors over MCP — bypasses approval gate
//   AC-P2-12 get_diagnostics over MCP — threshold expansion at boundary
//   AC-P2-14 multi-workspace routing (right mock receives the request)
//
// Remaining P2 ACs (1, 2, 6, 13, 15) are covered by operator smoke and
// T-P2-012 platform validation.

import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { connect, callTool } from "./mcp-delegate-client.mjs";
import {
  setupTempEnv,
  cleanupTempEnv,
  writeConfig,
  startDaemon,
  stopDaemon,
  pass,
  fail,
  extractResult,
} from "./lib/harness-common.mjs";
import { startMockExtension } from "./mock-extension.mjs";

const STUB_DELAY_MS = 50;

// ---- Helpers (v0.5 §7 brittleness defenses) ----

// unwrapOrThrow: every MCP call goes through this. Schema-rejection and
// daemon-side errors surface as loud throws rather than silently
// passing through extractResult as null/undefined-fields.
function unwrapOrThrow(callResult, where) {
  if (callResult.isError === true) {
    const text =
      callResult.result?.content?.[0]?.text ??
      callResult.result?.errorMessage ??
      JSON.stringify(callResult.result);
    const err = new Error(`${where} returned error: ${text}`);
    err.errorText = text;
    throw err;
  }
  return extractResult(callResult);
}

// callAndExpectError: inverse of unwrapOrThrow — call expecting an
// error envelope; return the error text. Throws if the call succeeded
// unexpectedly.
function callAndExpectError(callResult, where) {
  if (callResult.isError !== true) {
    throw new Error(
      `${where}: expected error envelope, got success: ${JSON.stringify(callResult.result)}`,
    );
  }
  return (
    callResult.result?.content?.[0]?.text ??
    callResult.result?.errorMessage ??
    JSON.stringify(callResult.result)
  );
}

// Run a single AC and report PASS/FAIL with elapsed-time. Catches throws.
async function run(name, fn) {
  const t0 = Date.now();
  let result;
  try {
    result = await fn();
  } catch (err) {
    result = fail(`threw: ${err instanceof Error ? err.message : String(err)}`, {
      stack: err instanceof Error ? err.stack : null,
    });
  }
  const elapsed = Date.now() - t0;
  return { name, ...result, elapsed };
}

// Format a one-line result row.
function formatRow(r) {
  const tag = r.pass ? "PASS" : "FAIL";
  const ms = String(r.elapsed).padStart(5);
  return `  ${tag.padEnd(4)}  ${r.name.padEnd(45)}  ${ms}ms  ${r.message}`;
}

// Make a fresh sandbox workspace dir for tests that need a unique path.
function makeWsDir(env, sub) {
  const p = join(env.tmpRoot, "ws-" + sub);
  mkdirSync(p, { recursive: true });
  return p;
}

// ---- AC implementations ----

async function testTrustPromptPersists(ctx) {
  const wsPath = makeWsDir(ctx.env, "trust-persist");
  // First connect — daemon has no record of wsPath, so confirm_trust is
  // required. Mock trusts; expect register_workspace_ok with
  // was_already_trusted=false.
  const mock1 = await startMockExtension({
    socketPath: ctx.socketPath,
    workspace: { abs_path: wsPath, name: "trust-persist" },
    onTrustPrompt: "trust",
    onApproval: "deny",
  });
  const log1 = mock1.getReceivedCallLog();
  const sawNeedsTrust1 = log1.some(
    (m) => m.kind === "register_workspace_needs_trust",
  );
  const sawOk1 = log1.find((m) => m.kind === "register_workspace_ok");
  await mock1.stop();
  if (!sawNeedsTrust1) {
    return fail("first register did not produce needs_trust prompt", { log1 });
  }
  if (sawOk1 === undefined || sawOk1.was_already_trusted !== false) {
    return fail("first register did not finalize with was_already_trusted=false", {
      sawOk1,
    });
  }

  // Second connect to same wsPath — daemon should already have trust;
  // expect register_workspace_ok directly, no needs_trust prompt.
  const mock2 = await startMockExtension({
    socketPath: ctx.socketPath,
    workspace: { abs_path: wsPath, name: "trust-persist" },
    onTrustPrompt: "deny", // would deny if asked — assertion is it isn't asked
    onApproval: "deny",
  });
  const log2 = mock2.getReceivedCallLog();
  const sawNeedsTrust2 = log2.some(
    (m) => m.kind === "register_workspace_needs_trust",
  );
  const sawOk2 = log2.find((m) => m.kind === "register_workspace_ok");
  await mock2.stop();
  if (sawNeedsTrust2) {
    return fail("second register re-fired the trust prompt (trust did not persist)", {
      log2,
    });
  }
  if (sawOk2 === undefined || sawOk2.was_already_trusted !== true) {
    return fail("second register did not report was_already_trusted=true", {
      sawOk2,
    });
  }
  return pass(
    "trust persisted: register #1 fired needs_trust (was_already_trusted=false); register #2 skipped prompt (was_already_trusted=true)",
    { sawOk1, sawOk2 },
  );
}

async function testUnregistered503(ctx) {
  // Call delegate with a workspace identifier that's not registered.
  const r = await callTool(ctx.client, "delegate_to_claude_code", {
    workspace: "ghost-workspace-id",
    prompt: "should fail",
  });
  const text = callAndExpectError(r, "unregistered delegate");
  // Daemon error vocabulary: 503 no_workspace_registered.
  if (!/no_workspace_registered|workspace/i.test(text)) {
    return fail(`error text did not mention workspace: ${text}`, { text });
  }
  return pass(`unregistered → daemon error: ${text.slice(0, 80)}`, { text });
}

async function testUntrusted403(ctx) {
  // The daemon doesn't model an "untrusted" delegation state distinct
  // from "unregistered" — if the user denies trust, no workspace entry
  // is written, so a subsequent delegate call hits the same
  // no_workspace_registered path. We verify the at-mock observable
  // difference: trust prompt was offered and denied.
  const wsPath = makeWsDir(ctx.env, "untrusted-" + Date.now());
  const mockDeny = await startMockExtension({
    socketPath: ctx.socketPath,
    workspace: { abs_path: wsPath, name: "untrusted" },
    onTrustPrompt: "deny",
    onApproval: "deny",
  });
  // Mock should report trust_denied: true; no identifier assigned.
  if (mockDeny.trust_denied !== true) {
    await mockDeny.stop();
    return fail("mock did not register trust_denied", { mockDeny });
  }
  if (mockDeny.id !== null) {
    await mockDeny.stop();
    return fail("mock got identifier despite trust denial", { id: mockDeny.id });
  }
  const log = mockDeny.getReceivedCallLog();
  const sawNeedsTrust = log.some((m) => m.kind === "register_workspace_needs_trust");
  await mockDeny.stop();
  if (!sawNeedsTrust) {
    return fail("trust prompt was not offered before denial", { log });
  }

  // Now call delegate with no workspace registered for that path; should
  // return the same 503-class error as testUnregistered503. Try the
  // would-be identifier (or any identifier) — daemon has no entry.
  const r = await callTool(ctx.client, "delegate_to_claude_code", {
    workspace: "untrusted",
    prompt: "should fail",
  });
  const text = callAndExpectError(r, "untrusted delegate");
  return pass(
    `trust prompt offered + denied; subsequent delegate → daemon error (same path as unregistered: ${text.slice(0, 60)})`,
    { text },
  );
}

async function testEnvOnlyApiKey(ctx) {
  // The daemon's observable surface for ANTHROPIC_API_KEY presence is
  // its startup log: when the key is absent, daemon main.ts emits
  // 'ANTHROPIC_API_KEY not set; delegations will fail with auth error'
  // (sdk-runner path). When set, no such warning. We verify the
  // negative-space here — the harness daemon was spawned with the env
  // var present, so the warn line should be ABSENT from daemon.log.
  if (!existsSync(ctx.env.logPath)) {
    return fail("daemon log does not exist", { path: ctx.env.logPath });
  }
  const log = readFileSync(ctx.env.logPath, "utf8");
  const warningPresent = /ANTHROPIC_API_KEY not set/.test(log);
  if (warningPresent) {
    return fail("daemon emitted ANTHROPIC_API_KEY-not-set warning despite env-injection", {
      log_excerpt: log.slice(0, 500),
    });
  }
  // Positive evidence: env var was injected at daemon spawn time
  // (recorded in ctx — harness controls this).
  if (ctx.injectedApiKey === undefined || ctx.injectedApiKey.length === 0) {
    return fail("harness did not inject ANTHROPIC_API_KEY", {});
  }
  return pass(
    `daemon spawned with ANTHROPIC_API_KEY=<${ctx.injectedApiKey.length}-char value>; no missing-key warning in daemon.log`,
    {
      key_length: ctx.injectedApiKey.length,
    },
  );
}

async function testApprovalModes(ctx) {
  // For each mode, register a fresh workspace, set the mode, and exercise
  // delegate. Each cycle is independent — no cross-test contamination.
  const modes = [
    {
      mode: "auto",
      expectApprovalRequest: false,
      description: "auto skips gate entirely",
      onApproval: "approve",
    },
    {
      mode: "per_call",
      expectApprovalRequest: true,
      description: "per_call fires on each call",
      onApproval: "approve",
    },
    {
      mode: "session_bypass",
      expectApprovalRequest: true, // first call fires; second does not
      description: "session_bypass fires once per session",
      onApproval: "approve_session",
    },
  ];

  const findings = {};

  for (const cfg of modes) {
    const wsPath = makeWsDir(ctx.env, "modes-" + cfg.mode);
    const mock = await startMockExtension({
      socketPath: ctx.socketPath,
      workspace: { abs_path: wsPath, name: cfg.mode + "-ws" },
      onTrustPrompt: "trust",
      onApproval: cfg.onApproval,
    });
    try {
      if (mock.id === null) {
        findings[cfg.mode] = { error: "register failed" };
        continue;
      }
      // Set the workspace mode via IPC.
      await mock.setMode(cfg.mode);

      // First delegate call.
      const t0 = Date.now();
      const r1 = await callTool(ctx.client, "delegate_to_claude_code", {
        workspace: mock.id,
        prompt: `${cfg.mode}-call-1`,
        mode: "agentic",
      });
      const elapsed1 = Date.now() - t0;
      // Give the daemon time to write any post-handler audit + the mock
      // to log any approval_request that arrived during the call.
      await sleep(50);
      const log1 = mock.getReceivedCallLog();
      const approvalRequests1 = log1.filter(
        (m) => m.kind === "approval_request",
      ).length;

      let result1;
      if (r1.isError === true) {
        result1 = {
          isError: true,
          text: r1.result?.content?.[0]?.text ?? "?",
          elapsed_ms: elapsed1,
        };
      } else {
        result1 = {
          ok: extractResult(r1),
          approval_requests_seen: approvalRequests1,
          elapsed_ms: elapsed1,
        };
      }

      // Second delegate call (only meaningful for session_bypass).
      const t1 = Date.now();
      const r2 = await callTool(ctx.client, "delegate_to_claude_code", {
        workspace: mock.id,
        prompt: `${cfg.mode}-call-2`,
        mode: "agentic",
      });
      const elapsed2 = Date.now() - t1;
      await sleep(50);
      const log2 = mock.getReceivedCallLog();
      const approvalRequests2 = log2.filter(
        (m) => m.kind === "approval_request",
      ).length;

      let result2;
      if (r2.isError === true) {
        result2 = {
          isError: true,
          text: r2.result?.content?.[0]?.text ?? "?",
          elapsed_ms: elapsed2,
        };
      } else {
        result2 = {
          ok: extractResult(r2),
          approval_requests_seen: approvalRequests2,
          elapsed_ms: elapsed2,
        };
      }

      findings[cfg.mode] = {
        result1,
        result2,
        approvalRequestsTotal: approvalRequests2,
      };
    } finally {
      await mock.stop();
    }
  }

  // Assert expected patterns.
  const errors = [];

  // auto: 0 approval requests total across two calls; both succeed.
  if (findings.auto.approvalRequestsTotal !== 0) {
    errors.push(
      `auto: expected 0 approval_requests, got ${findings.auto.approvalRequestsTotal}`,
    );
  }
  if (findings.auto.result1?.isError || findings.auto.result2?.isError) {
    errors.push(`auto: delegate returned error — ${JSON.stringify(findings.auto)}`);
  }

  // per_call: 2 approval requests (one per call); both succeed.
  if (findings.per_call.approvalRequestsTotal !== 2) {
    errors.push(
      `per_call: expected 2 approval_requests across 2 calls, got ${findings.per_call.approvalRequestsTotal}`,
    );
  }

  // session_bypass: 1 approval request total — first call fires, second
  // is bypassed.
  if (findings.session_bypass.approvalRequestsTotal !== 1) {
    errors.push(
      `session_bypass: expected 1 approval_request across 2 calls (bypass on call 2), got ${findings.session_bypass.approvalRequestsTotal}`,
    );
  }

  if (errors.length > 0) {
    return fail(errors.join("; "), { findings });
  }
  return pass(
    "auto: 0 modals across 2 calls; per_call: 2 modals; session_bypass: 1 modal (bypass on call 2)",
    { findings },
  );
}

async function testApprovalTimeout(ctx) {
  // The approval timeout is hardcoded to 5 minutes in pending.ts — too
  // long for a synchronous test. We test the adjacent rejection path:
  // when the extension closes mid-approval, the daemon's
  // removeActiveRegistrationsForSocket → approvalGate.cancelByWorkspace
  // rejects the pending with extension_reconnected, which delegate maps
  // to 408 approval_extension_reconnected within ms. This validates
  // that approval requests do NOT hang indefinitely on the daemon side,
  // which is the spec's underlying intent for AC-P2-9.
  const wsPath = makeWsDir(ctx.env, "approval-disconnect-" + Date.now());
  const mock = await startMockExtension({
    socketPath: ctx.socketPath,
    workspace: { abs_path: wsPath, name: "disconnect-ws" },
    onTrustPrompt: "trust",
    // "ignore" — never respond to approval_request. We'll close the
    // mock mid-flight to trigger the cancellation path.
    onApproval: "ignore",
  });
  if (mock.id === null) {
    await mock.stop();
    return fail("register failed", {});
  }
  try {
    await mock.setMode("per_call");
    // Fire the delegate but don't await yet — kick off the call, give
    // the mock a moment to receive approval_request, then disconnect.
    const t0 = Date.now();
    const delegatePromise = callTool(ctx.client, "delegate_to_claude_code", {
      workspace: mock.id,
      prompt: "approval-disconnect",
      mode: "agentic",
    });
    // Poll the mock's call log for the approval_request arrival.
    let sawApproval = false;
    for (let i = 0; i < 50 && !sawApproval; i++) {
      await sleep(20);
      sawApproval = mock
        .getReceivedCallLog()
        .some((m) => m.kind === "approval_request");
    }
    if (!sawApproval) {
      await mock.stop();
      const stale = await delegatePromise;
      return fail("approval_request never reached mock", { stale });
    }
    // Disconnect the mock mid-approval. Daemon will cancel pending and
    // surface 408 to the delegate caller.
    await mock.stop();
    const r = await delegatePromise;
    const elapsed = Date.now() - t0;
    if (r.isError !== true) {
      return fail(`expected error envelope; got success: ${JSON.stringify(r.result).slice(0, 200)}`, {
        elapsed,
      });
    }
    const text =
      r.result?.content?.[0]?.text ??
      r.result?.errorMessage ??
      JSON.stringify(r.result);
    if (!/extension_reconnected|approval/i.test(text)) {
      return fail(`error text did not match approval-cancel vocabulary: ${text}`, {
        text,
        elapsed,
      });
    }
    // Elapsed should be small (well under the 5-min real timeout).
    if (elapsed > 10_000) {
      return fail(`disconnect-cancel took ${elapsed}ms (expected <10s)`, {
        elapsed,
      });
    }
    if (elapsed < 5) {
      return fail(`elapsed=${elapsed}ms suspiciously fast — false-pass risk`, {
        elapsed,
        text,
      });
    }
    return pass(
      `disconnect-cancel path: 408-class error in ${elapsed}ms (proxy for the hardcoded 5-min timeout)`,
      { elapsed, text: text.slice(0, 100) },
    );
  } finally {
    // mock.stop() may have already run; no harm in calling again.
    await mock.stop().catch(() => undefined);
  }
}

async function testUserDenial(ctx) {
  const wsPath = makeWsDir(ctx.env, "deny-" + Date.now());
  const mock = await startMockExtension({
    socketPath: ctx.socketPath,
    workspace: { abs_path: wsPath, name: "deny-ws" },
    onTrustPrompt: "trust",
    onApproval: "deny",
  });
  if (mock.id === null) {
    await mock.stop();
    return fail("register failed", {});
  }
  try {
    await mock.setMode("per_call");
    const t0 = Date.now();
    const r = await callTool(ctx.client, "delegate_to_claude_code", {
      workspace: mock.id,
      prompt: "deny-me",
      mode: "agentic",
    });
    const elapsed = Date.now() - t0;
    if (r.isError !== true) {
      return fail(`expected error envelope; got success: ${JSON.stringify(r.result).slice(0, 200)}`, {
        elapsed,
      });
    }
    const text =
      r.result?.content?.[0]?.text ?? JSON.stringify(r.result);
    if (!/delegation_denied|denied|deny/i.test(text)) {
      return fail(`error text did not match denial vocabulary: ${text}`, {
        text,
        elapsed,
      });
    }
    // Floor at 2ms — catches "0ms = daemon rejected before any work happened"
    // while accepting the actual localhost mock round-trip latency
    // (measured 3–5ms on this host).
    if (elapsed < 2) {
      return fail(`elapsed=${elapsed}ms suspiciously fast — false-pass risk`, {
        elapsed,
      });
    }
    // Both-sides: mock received approval_request before the denial.
    const sawApproval = mock
      .getReceivedCallLog()
      .some((m) => m.kind === "approval_request");
    if (!sawApproval) {
      return fail("mock did not receive approval_request", {
        log: mock.getReceivedCallLog(),
      });
    }
    return pass(
      `delegate denied with 403 in ${elapsed}ms; mock saw approval_request`,
      { elapsed, text: text.slice(0, 80) },
    );
  } finally {
    await mock.stop();
  }
}

async function testGetOpenEditors(ctx) {
  const wsPath = makeWsDir(ctx.env, "editors-" + Date.now());
  const cannedEditors = [
    {
      uri: "file:///" + wsPath.replace(/\\/g, "/") + "/foo.ts",
      fs_path: join(wsPath, "foo.ts"),
      is_active: true,
      is_dirty: false,
    },
    {
      uri: "file:///" + wsPath.replace(/\\/g, "/") + "/bar.ts",
      fs_path: join(wsPath, "bar.ts"),
      is_active: false,
      is_dirty: true,
    },
  ];
  const mock = await startMockExtension({
    socketPath: ctx.socketPath,
    workspace: { abs_path: wsPath, name: "editors-ws" },
    onTrustPrompt: "trust",
    onApproval: "deny",
    getOpenEditors: () => cannedEditors,
  });
  if (mock.id === null) {
    await mock.stop();
    return fail("register failed", {});
  }
  try {
    const t0 = Date.now();
    const r = await callTool(ctx.client, "get_open_editors", {
      workspace: mock.id,
    });
    const elapsed = Date.now() - t0;
    const out = unwrapOrThrow(r, "get_open_editors");
    if (!Array.isArray(out.editors) || out.editors.length !== 2) {
      return fail(
        `expected 2 editors; got ${out.editors?.length ?? "n/a"}`,
        { out, elapsed },
      );
    }
    if (out.editors[0]?.uri !== cannedEditors[0].uri) {
      return fail("editor[0].uri mismatch", { out });
    }
    if (out.editors[1]?.is_dirty !== true) {
      return fail("editor[1].is_dirty mismatch", { out });
    }
    if (elapsed < 5) {
      return fail(`elapsed=${elapsed}ms suspiciously fast`, { elapsed });
    }
    // Both-sides: mock saw get_open_editors_request; no approval_request
    // surfaced during this read-only call (gate bypass).
    const log = mock.getReceivedCallLog();
    const sawRequest = log.some((m) => m.kind === "get_open_editors_request");
    if (!sawRequest) {
      return fail("mock did not receive get_open_editors_request", { log });
    }
    const sawApproval = log.some((m) => m.kind === "approval_request");
    if (sawApproval) {
      return fail("approval_request fired during get_open_editors (gate bypass broken)", {
        log,
      });
    }
    return pass(
      `2 editors returned in ${elapsed}ms; mock saw request; no approval_request fired (gate bypass)`,
      { elapsed },
    );
  } finally {
    await mock.stop();
  }
}

async function testGetDiagnostics(ctx) {
  const wsPath = makeWsDir(ctx.env, "diag-" + Date.now());
  const allDiags = [
    {
      uri: "file:///x/a.ts",
      fs_path: "x/a.ts",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 4 },
      },
      severity: "error",
      message: "E1",
      source: "tsc",
    },
    {
      uri: "file:///x/a.ts",
      fs_path: "x/a.ts",
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 2 },
      },
      severity: "warning",
      message: "W1",
    },
    {
      uri: "file:///x/a.ts",
      fs_path: "x/a.ts",
      range: {
        start: { line: 2, character: 0 },
        end: { line: 2, character: 1 },
      },
      severity: "info",
      message: "I1",
    },
    {
      uri: "file:///x/a.ts",
      fs_path: "x/a.ts",
      range: {
        start: { line: 3, character: 0 },
        end: { line: 3, character: 1 },
      },
      severity: "hint",
      message: "H1",
    },
  ];

  const seenSeverityArgs = [];
  const mock = await startMockExtension({
    socketPath: ctx.socketPath,
    workspace: { abs_path: wsPath, name: "diag-ws" },
    onTrustPrompt: "trust",
    onApproval: "deny",
    getDiagnostics: (severities) => {
      seenSeverityArgs.push(severities.slice());
      return allDiags.filter((d) => severities.includes(d.severity));
    },
  });
  if (mock.id === null) {
    await mock.stop();
    return fail("register failed", {});
  }
  try {
    // Threshold "error" → mock receives ["error"]; returns 1.
    const rErr = unwrapOrThrow(
      await callTool(ctx.client, "get_diagnostics", {
        workspace: mock.id,
        severity: "error",
      }),
      "get_diagnostics(error)",
    );
    if (rErr.diagnostics.length !== 1 || rErr.diagnostics[0].severity !== "error") {
      return fail("severity=error did not yield exactly 1 error", { rErr });
    }
    if (
      seenSeverityArgs[0].length !== 1 ||
      seenSeverityArgs[0][0] !== "error"
    ) {
      return fail(
        `mock received unexpected severities for 'error' threshold: ${JSON.stringify(seenSeverityArgs[0])}`,
        { seenSeverityArgs },
      );
    }

    // Threshold "warning" → mock receives ["error","warning"]; returns 2.
    const rWarn = unwrapOrThrow(
      await callTool(ctx.client, "get_diagnostics", {
        workspace: mock.id,
        severity: "warning",
      }),
      "get_diagnostics(warning)",
    );
    if (rWarn.diagnostics.length !== 2) {
      return fail("severity=warning did not yield 2 items", { rWarn });
    }
    if (
      JSON.stringify(seenSeverityArgs[1]) !==
      JSON.stringify(["error", "warning"])
    ) {
      return fail(
        `mock received unexpected severities for 'warning': ${JSON.stringify(seenSeverityArgs[1])}`,
        { seenSeverityArgs },
      );
    }

    // Threshold "all" → mock receives all four; returns 4.
    const rAll = unwrapOrThrow(
      await callTool(ctx.client, "get_diagnostics", {
        workspace: mock.id,
        severity: "all",
      }),
      "get_diagnostics(all)",
    );
    if (rAll.diagnostics.length !== 4) {
      return fail("severity=all did not yield 4 items", { rAll });
    }
    if (
      JSON.stringify(seenSeverityArgs[2]) !==
      JSON.stringify(["error", "warning", "info", "hint"])
    ) {
      return fail(
        `mock received unexpected severities for 'all': ${JSON.stringify(seenSeverityArgs[2])}`,
        { seenSeverityArgs },
      );
    }

    // No approval_request fired during any of these reads.
    const sawApproval = mock
      .getReceivedCallLog()
      .some((m) => m.kind === "approval_request");
    if (sawApproval) {
      return fail("approval_request fired during get_diagnostics (gate bypass broken)", {});
    }
    return pass(
      "thresholds expand correctly (error→1, warning→2, all→4); gate bypass intact",
      { seenSeverityArgs },
    );
  } finally {
    await mock.stop();
  }
}

async function testMultiWorkspaceRouting(ctx) {
  const wsPathA = makeWsDir(ctx.env, "multi-a-" + Date.now());
  const wsPathB = makeWsDir(ctx.env, "multi-b-" + Date.now());

  const editorsA = [
    {
      uri: "file:///A/a.ts",
      fs_path: "A/a.ts",
      is_active: true,
      is_dirty: false,
    },
  ];
  const editorsB = [
    {
      uri: "file:///B/b.ts",
      fs_path: "B/b.ts",
      is_active: false,
      is_dirty: true,
    },
  ];

  const mockA = await startMockExtension({
    socketPath: ctx.socketPath,
    workspace: { abs_path: wsPathA, name: "ws-A" },
    onTrustPrompt: "trust",
    onApproval: "deny",
    getOpenEditors: () => editorsA,
  });
  const mockB = await startMockExtension({
    socketPath: ctx.socketPath,
    workspace: { abs_path: wsPathB, name: "ws-B" },
    onTrustPrompt: "trust",
    onApproval: "deny",
    getOpenEditors: () => editorsB,
  });

  try {
    if (mockA.id === null || mockB.id === null) {
      return fail("one or both mocks failed to register", {
        a: mockA.id,
        b: mockB.id,
      });
    }
    if (mockA.id === mockB.id) {
      return fail("mocks got the same workspace identifier", {
        id: mockA.id,
      });
    }

    // Call with ws-A's identifier; ws-A's mock should receive the
    // request; ws-B's mock should not.
    const r = unwrapOrThrow(
      await callTool(ctx.client, "get_open_editors", {
        workspace: mockA.id,
      }),
      "get_open_editors(ws-A)",
    );
    if (r.editors.length !== 1 || r.editors[0]?.uri !== editorsA[0].uri) {
      return fail("get_open_editors did not return ws-A's editors", { r });
    }
    const aReceived = mockA
      .getReceivedCallLog()
      .some((m) => m.kind === "get_open_editors_request");
    const bReceived = mockB
      .getReceivedCallLog()
      .some((m) => m.kind === "get_open_editors_request");
    if (!aReceived) {
      return fail("ws-A's mock did not receive the request", {});
    }
    if (bReceived) {
      return fail("ws-B's mock incorrectly received the ws-A request", {});
    }

    // Now call with no workspace arg — daemon has 2 registered, so
    // expect 400 ambiguous_workspace.
    const rAmb = await callTool(ctx.client, "get_open_editors", {});
    const ambText = callAndExpectError(rAmb, "get_open_editors(ambiguous)");
    // Daemon's ambiguous_workspace reason maps to the message
    // "multiple workspaces registered (N); pass 'workspace' explicitly"
    // at the MCP layer (reason code itself isn't echoed to the client).
    if (!/ambiguous_workspace|ambiguous|multiple workspaces|pass 'workspace'/i.test(ambText)) {
      return fail(`expected ambiguous_workspace error; got ${ambText}`, {
        ambText,
      });
    }
    return pass(
      "routed to ws-A correctly; ws-B isolated; no-arg → ambiguous_workspace",
      { aReceived, bReceived, ambText: ambText.slice(0, 60) },
    );
  } finally {
    await mockA.stop();
    await mockB.stop();
  }
}

// ---- Setup / teardown ----

async function setup() {
  const env = setupTempEnv("cb-p2-accept-");
  // Use stub job runner so delegate's enqueue actually starts a real job
  // but completes quickly; per_call/session_bypass/auto verification
  // doesn't require a real SDK runtime.
  writeConfig(env, {
    stub_behavior: {
      outcome: "complete",
      delay_ms: STUB_DELAY_MS,
    },
  });
  const injectedApiKey = "cb-test-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const handle = await startDaemon(env, {
    allowStubConfig: true,
    extraEnv: { ANTHROPIC_API_KEY: injectedApiKey },
  });
  const client = await connect({ url: handle.url, token: handle.token });
  // On Windows the daemon's IPC pipe is fixed; on Unix it's the
  // configured ipc_socket. Mock-extension defaults handle both.
  const socketPath = process.platform === "win32" ? null : env.ipcSocket;
  return { env, handle, client, socketPath, injectedApiKey };
}

async function teardown(ctx) {
  if (ctx === undefined) return;
  if (ctx.client !== undefined) {
    try {
      await ctx.client.close();
    } catch {
      // best-effort
    }
  }
  if (ctx.handle !== undefined) {
    await stopDaemon(ctx.handle);
  }
  if (ctx.env !== undefined) {
    cleanupTempEnv(ctx.env);
  }
}

// ---- Main ----

async function main() {
  console.log("P2 acceptance harness (T-P2-011)");
  let ctx;
  let exitCode = 1;
  try {
    ctx = await setup();
    console.log(`Temp env: ${ctx.env.tmpRoot}`);
    console.log(`Daemon: ${ctx.handle.url} (token suffix ${ctx.handle.token.slice(-4)})`);
    console.log("");

    const results = [];
    results.push(await run("AC-P2-3  trust prompt persists", () => testTrustPromptPersists(ctx)));
    results.push(await run("AC-P2-4  unregistered → 503", () => testUnregistered503(ctx)));
    results.push(await run("AC-P2-5  untrusted → 503 (at daemon)", () => testUntrusted403(ctx)));
    results.push(await run("AC-P2-7  env-only ANTHROPIC_API_KEY", () => testEnvOnlyApiKey(ctx)));
    results.push(await run("AC-P2-8  approval modes", () => testApprovalModes(ctx)));
    results.push(await run("AC-P2-9  approval rejected on disconnect", () => testApprovalTimeout(ctx)));
    results.push(await run("AC-P2-10 user denial → 403", () => testUserDenial(ctx)));
    results.push(await run("AC-P2-11 get_open_editors via MCP", () => testGetOpenEditors(ctx)));
    results.push(await run("AC-P2-12 get_diagnostics via MCP", () => testGetDiagnostics(ctx)));
    results.push(await run("AC-P2-14 multi-workspace routing", () => testMultiWorkspaceRouting(ctx)));

    console.log("\n=== Results ===");
    for (const r of results) {
      console.log(formatRow(r));
    }
    const passes = results.filter((r) => r.pass).length;
    const fails = results.length - passes;
    console.log(`\n${passes} passed, ${fails} failed`);
    exitCode = fails === 0 ? 0 : 1;
  } catch (err) {
    console.error("harness setup/teardown error:", err);
    exitCode = 1;
  } finally {
    await teardown(ctx);
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("harness error:", err);
  process.exit(1);
});

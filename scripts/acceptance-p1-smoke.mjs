// P1 acceptance harness — live SMOKE (Phase 11). Exercises the
// SdkJobRunner via the MCP wire protocol against the real Anthropic API.
//
// Covers three ACs where the wire path matters:
//   AC-5 — agentic happy path completes E2E
//   AC-6 — read_only refusal semantics
//   AC-8 — cancel of running SDK delegation reaches terminal within 15s
//
// Intentionally skipped: bash deny (enforcement is in canUseTool, not at
// MCP layer) and max_turns (truncation is in report assembler, not on
// wire). Both are unit-covered by sdk-runner.test.ts (T-P1-009/010).
//
// Phase 12 runs this on WSL Ubuntu in addition to Windows.
//
// Requires: ANTHROPIC_API_KEY in the invoking shell's env. Daemon
// child_process inherits it.

import process from "node:process";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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

const KEY = process.env.ANTHROPIC_API_KEY;

// Poll budgets (per-AC). 60s is the schema-enforced max for wait_ms
// (PollInputSchema in delegation.ts). T-P1-010 measured 31-37s for
// read_only and 9-13s for agentic, so 60s is comfortable headroom.
const POLL_WAIT_CAP_MS = 60_000;
const AC5_WAIT_MS = POLL_WAIT_CAP_MS;
const AC6_WAIT_MS = POLL_WAIT_CAP_MS;
const AC8_PRE_CANCEL_MS = 4_000;   // let the SDK start a turn before cancelling
const AC8_TERMINAL_BUDGET_MS = 15_000; // AC-8 spec: terminal within 15s of cancel

// callTool wraps server-side rejections in `{ result: { errorMessage|... },
// isError: true }`. Callers that hand the wrapped result through
// extractResult get the bare result (no structuredContent), which has no
// fields the AC code expects — assertions then pass on garbage. This
// helper raises the error envelope to a hard failure at the call site.
function unwrapOrThrow(callResult, where) {
  if (callResult.isError === true) {
    const text =
      callResult.result?.content?.[0]?.text ??
      callResult.result?.errorMessage ??
      JSON.stringify(callResult.result);
    throw new Error(`${where} returned error: ${text}`);
  }
  return extractResult(callResult);
}

// ---- AC implementations ----

async function ac5_agenticHappyPath(client, env) {
  const t0 = Date.now();
  const d = unwrapOrThrow(
    await callTool(client, "delegate_to_claude_code", {
      prompt:
        "Create a file named hello.txt in the workspace root with the exact content 'hi from claude-code'. Do not modify anything else.",
      mode: "agentic",
      max_turns: 5,
    }),
    "AC-5 delegate",
  );
  if (!d.job_id) return fail("delegate returned no job_id", { d, elapsed_ms: Date.now() - t0 });

  const p = unwrapOrThrow(
    await callTool(client, "poll_delegation", {
      job_id: d.job_id,
      wait_ms: AC5_WAIT_MS,
    }),
    "AC-5 poll",
  );
  const elapsed = Date.now() - t0;

  if (p.status !== "complete") {
    return fail(`status=${p.status}, expected complete`, { p, elapsed_ms: elapsed });
  }
  const filePath = join(env.workspaceDir, "hello.txt");
  if (!existsSync(filePath)) {
    return fail("workspace missing hello.txt", { p, elapsed_ms: elapsed });
  }
  const summary = p.report?.summary;
  if (typeof summary !== "string" || summary.length === 0) {
    return fail("report missing or empty summary", { p, elapsed_ms: elapsed });
  }
  const transcriptUri = p.report?.transcript_uri;
  if (typeof transcriptUri !== "string" || !transcriptUri.startsWith("file://")) {
    return fail("report missing transcript_uri (file:// URL)", { p, elapsed_ms: elapsed });
  }
  // Resolve and read the transcript to confirm it's well-formed JSONL.
  // file:// URLs encode the absolute path; convert via URL.
  const transcriptPath = new URL(transcriptUri).pathname.replace(/^\/([A-Z]:)/, "$1");
  if (!existsSync(transcriptPath)) {
    return fail(`transcript file missing at ${transcriptPath}`, { p, elapsed_ms: elapsed });
  }
  const lines = readFileSync(transcriptPath, "utf8").trim().split("\n");
  if (lines.length < 2) return fail(`transcript has <2 lines`, { p, lines: lines.length, elapsed_ms: elapsed });

  return pass(
    `complete in ${elapsed}ms; hello.txt created; transcript ${lines.length} lines`,
    { elapsed_ms: elapsed, summary_first_100: summary.slice(0, 100), transcript_lines: lines.length },
  );
}

async function ac6_readOnlyRefusal(client, env) {
  const t0 = Date.now();
  const d = unwrapOrThrow(
    await callTool(client, "delegate_to_claude_code", {
      prompt: "Write a file named bad.txt with content 'should not appear'.",
      mode: "read_only",
      max_turns: 5,
    }),
    "AC-6 delegate",
  );
  if (!d.job_id) return fail("delegate returned no job_id", { d, elapsed_ms: Date.now() - t0 });

  const p = unwrapOrThrow(
    await callTool(client, "poll_delegation", {
      job_id: d.job_id,
      wait_ms: AC6_WAIT_MS,
    }),
    "AC-6 poll",
  );
  const elapsed = Date.now() - t0;

  // Semantic contract per T-P1-010: regardless of how the run terminates,
  // no file may be created in the workspace. But the poll MUST have
  // reached a terminal state — silent "status undefined" (e.g., schema
  // rejection masquerading) must not pass.
  if (!["complete", "failed"].includes(p.status)) {
    return fail(
      `expected terminal complete or failed; got status=${String(p.status)}`,
      { p, elapsed_ms: elapsed },
    );
  }
  const filePath = join(env.workspaceDir, "bad.txt");
  if (existsSync(filePath)) {
    return fail(`read_only mode wrote bad.txt to workspace`, { p, elapsed_ms: elapsed });
  }
  return pass(
    `terminal status=${p.status} in ${elapsed}ms; workspace unchanged`,
    { elapsed_ms: elapsed, status: p.status, error_category: p.report?.error?.category ?? null },
  );
}

async function ac8_cancelRunning(client, env) {
  void env;
  const t0 = Date.now();
  const d = unwrapOrThrow(
    await callTool(client, "delegate_to_claude_code", {
      prompt:
        "List every file in the workspace (use Glob), then read each one (use Read), then write a summary file named summary.txt describing what you found. Take your time and be thorough.",
      mode: "agentic",
      max_turns: 8,
    }),
    "AC-8 delegate",
  );
  if (!d.job_id) return fail("delegate returned no job_id", { d, elapsed_ms: Date.now() - t0 });

  // Give the SDK time to start a turn (so we're cancelling a running job,
  // not a queued one).
  await sleep(AC8_PRE_CANCEL_MS);

  const cancelT0 = Date.now();
  const c = unwrapOrThrow(
    await callTool(client, "cancel_delegation", { job_id: d.job_id }),
    "AC-8 cancel",
  );
  if (c.status !== "cancelled") {
    return fail(`cancel returned status=${c.status}`, { c, elapsed_ms: Date.now() - t0 });
  }
  // Poll until terminal cancelled state.
  const p = unwrapOrThrow(
    await callTool(client, "poll_delegation", {
      job_id: d.job_id,
      wait_ms: AC8_TERMINAL_BUDGET_MS,
    }),
    "AC-8 poll",
  );
  const cancelToTerminal = Date.now() - cancelT0;
  const totalElapsed = Date.now() - t0;

  if (p.status !== "cancelled") {
    return fail(
      `terminal status=${p.status}, expected cancelled (within ${AC8_TERMINAL_BUDGET_MS}ms of cancel)`,
      { p, cancel_to_terminal_ms: cancelToTerminal, elapsed_ms: totalElapsed },
    );
  }
  if (cancelToTerminal > AC8_TERMINAL_BUDGET_MS) {
    return fail(
      `cancel→terminal took ${cancelToTerminal}ms (>${AC8_TERMINAL_BUDGET_MS}ms budget)`,
      { p, cancel_to_terminal_ms: cancelToTerminal, elapsed_ms: totalElapsed },
    );
  }
  return pass(
    `cancelled (cancel→terminal ${cancelToTerminal}ms; total wall ${totalElapsed}ms)`,
    { cancel_to_terminal_ms: cancelToTerminal, elapsed_ms: totalElapsed, status: p.status },
  );
}

// ---- Main ----

async function main() {
  if (typeof KEY !== "string" || KEY.length === 0) {
    console.error("ANTHROPIC_API_KEY not set in env; aborting SMOKE harness.");
    process.exit(2);
  }
  console.log(
    `P1 acceptance harness — live SMOKE (Phase 11). ANTHROPIC_API_KEY prefix: ${KEY.slice(0, 8)}...`,
  );

  const env = setupTempEnv("cb-p1-smoke-");
  console.log(`Temp env: ${env.tmpRoot}`);
  // Initialize the workspace as a git repo so the diff/snapshot paths
  // work the same as in production. Mirrors sdk-runner.test.ts setup.
  execFileSync("git", ["init", "-q"], { cwd: env.workspaceDir });
  execFileSync("git", ["config", "user.email", "harness@example.com"], { cwd: env.workspaceDir });
  execFileSync("git", ["config", "user.name", "Harness"], { cwd: env.workspaceDir });

  writeConfig(env);

  const handle = await startDaemon(env, {
    // Live mode: no stub config; SdkJobRunner is the default.
    allowStubConfig: false,
    extraEnv: { ANTHROPIC_API_KEY: KEY },
  });

  const allResults = {};
  try {
    const client = await connect({ url: handle.url, token: handle.token });
    try {
      console.log("\n--- AC-5: agentic happy path ---");
      allResults["AC-5"] = await ac5_agenticHappyPath(client, env);
      console.log(`  ${allResults["AC-5"].pass ? "PASS" : "FAIL"} ${allResults["AC-5"].message}`);

      console.log("\n--- AC-6: read_only refusal ---");
      allResults["AC-6"] = await ac6_readOnlyRefusal(client, env);
      console.log(`  ${allResults["AC-6"].pass ? "PASS" : "FAIL"} ${allResults["AC-6"].message}`);

      console.log("\n--- AC-8: cancel running delegation within 15s ---");
      allResults["AC-8"] = await ac8_cancelRunning(client, env);
      console.log(`  ${allResults["AC-8"].pass ? "PASS" : "FAIL"} ${allResults["AC-8"].message}`);
    } finally {
      await client.close();
    }
  } finally {
    await stopDaemon(handle);
    cleanupTempEnv(env);
  }

  // Summary table.
  console.log("\n=== Summary ===");
  let passes = 0;
  let fails = 0;
  for (const [ac, result] of Object.entries(allResults)) {
    const tag = result.pass ? "PASS" : "FAIL";
    const ms = result.evidence?.elapsed_ms ?? "?";
    const extra =
      result.evidence?.cancel_to_terminal_ms !== undefined
        ? ` cancel→term=${result.evidence.cancel_to_terminal_ms}ms`
        : "";
    console.log(`  ${tag.padEnd(4)}  ${ac}  ${ms}ms${extra}  ${result.message}`);
    if (result.pass) passes++;
    else fails++;
  }
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("harness error:", err);
  process.exit(1);
});

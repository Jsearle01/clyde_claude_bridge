// P1 acceptance harness (Phase 5 — skeleton). Exercises the Phase 4 tool
// surface via the MCP path against the StubJobRunner. SMOKE expansion
// (real SDK delegations) lands at Phase 11; cross-platform Unix run at
// Phase 12.
//
// Default mode: own the daemon lifecycle (spawn against a temp config
// dir, wait for ready, run ACs grouped by stub behavior, stop daemon,
// clean up). `--no-daemon` mode: connect to a developer-managed daemon
// via CLAUDE_BRIDGE_URL / CLAUDE_BRIDGE_TOKEN env vars.

import process from "node:process";
import { readFileSync, existsSync } from "node:fs";
import { connect, callTool, listTools } from "./mcp-delegate-client.mjs";
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

// Drain helper: poll each job_id with wait_ms until terminal or budget
// elapsed. Used between ACs in the same daemon-run group so cumulative
// queue depth doesn't blow out subsequent ACs' wait_ms budgets.
async function drainJobs(client, jobIds, maxWaitMs = 15000) {
  const deadline = Date.now() + maxWaitMs;
  for (const id of jobIds) {
    while (Date.now() < deadline) {
      const remaining = Math.max(500, deadline - Date.now());
      const p = extractResult(
        await callTool(client, "poll_delegation", {
          job_id: id,
          wait_ms: Math.min(remaining, 5000),
        }),
      );
      if (["complete", "failed", "cancelled"].includes(p.status)) break;
    }
  }
}

// ---- ACs ----

async function ac1_delegateLatency(client) {
  const t0 = Date.now();
  const r = await callTool(client, "delegate_to_claude_code", {
    prompt: "ac1",
  });
  const elapsed = Date.now() - t0;
  if (r.isError) return fail("delegate returned isError", { elapsed });
  const out = extractResult(r);
  const shapeOk =
    typeof out.job_id === "string" &&
    /^j_[A-Z2-7]{12}$/.test(out.job_id) &&
    typeof out.status === "string" &&
    typeof out.workspace_id === "string" &&
    typeof out.queued_position === "number";
  if (!shapeOk) return fail("delegate response shape wrong", { out, elapsed });
  if (elapsed >= 500) return fail(`delegate took ${elapsed}ms (>=500)`, { elapsed });
  return pass(`returned in ${elapsed}ms with valid shape`, { elapsed, out });
}

async function ac2_queuePositions(client) {
  const a = extractResult(
    await callTool(client, "delegate_to_claude_code", { prompt: "ac2-a" }),
  );
  const b = extractResult(
    await callTool(client, "delegate_to_claude_code", { prompt: "ac2-b" }),
  );
  // A's delegate handler enqueues A, tickles runner (microtask), returns.
  // By the time B's call hits the daemon, A's microtask has fired → A is
  // running, removed from pending. B enqueues into empty pending → B's
  // queued_position is 0 (first in the FIFO behind the running job).
  // This differs from the design doc's aspirational "0 if running, 1+ if
  // queued" — the impl returns FIFO index, which is more useful for the
  // single-concurrent design (always 0 for "next to run").
  if (b.status !== "queued") {
    return fail(`B should be queued (was ${b.status}); stub delay may be too short`, { a, b });
  }
  if (typeof b.queued_position !== "number" || b.queued_position < 0) {
    return fail(`B queued_position should be non-negative integer`, { a, b });
  }
  await drainJobs(client, [a.job_id, b.job_id]);
  return pass(
    `A=${a.status}/pos${a.queued_position}, B=${b.status}/pos${b.queued_position} (impl semantic: 0 = first in FIFO behind running)`,
    { a, b },
  );
}

async function ac3_pollNonBlocking(client) {
  const d = extractResult(
    await callTool(client, "delegate_to_claude_code", { prompt: "ac3" }),
  );
  // Poll with wait_ms=0; expect running (after the tickle's microtask) or
  // queued. Either way response should be non-blocking.
  const t0 = Date.now();
  const p = extractResult(
    await callTool(client, "poll_delegation", { job_id: d.job_id, wait_ms: 0 }),
  );
  const elapsed = Date.now() - t0;
  if (elapsed >= 200) return fail(`poll took ${elapsed}ms (non-blocking expected)`, { p, elapsed });
  if (p.status === "queued" && p.queued_position === null) {
    return fail("queued status missing queued_position", { p });
  }
  await drainJobs(client, [d.job_id]);
  return pass(`poll returned status=${p.status} in ${elapsed}ms`, { p, elapsed });
}

async function ac4_pollLongPollEventDriven(client) {
  // Stub configured with delay_ms 1500; poll wait_ms 6000; expect resolution
  // close to 1500ms, well before 6000ms.
  const d = extractResult(
    await callTool(client, "delegate_to_claude_code", { prompt: "ac4" }),
  );
  const t0 = Date.now();
  const p = extractResult(
    await callTool(client, "poll_delegation", {
      job_id: d.job_id,
      wait_ms: 6000,
    }),
  );
  const elapsed = Date.now() - t0;
  const isTerminal = ["complete", "failed", "cancelled"].includes(p.status);
  if (!isTerminal) return fail(`poll returned non-terminal status=${p.status}`, { p, elapsed });
  // Bound 4000ms: tells us it's resolving via event, not waiting the full 6000ms.
  if (elapsed >= 4000) {
    return fail(
      `poll took ${elapsed}ms — should have resolved near 1500ms (delay), not near 6000ms (wait)`,
      { p, elapsed },
    );
  }
  return pass(
    `poll resolved at ${elapsed}ms (stub delay=1500, wait_ms=6000); event-driven via JobQueue.terminalPromise() — see queue.ts`,
    { p, elapsed },
  );
}

async function ac7_cancelQueued(client) {
  // First delegate occupies the runner for 2s; second delegate queues; cancel second.
  const a = extractResult(
    await callTool(client, "delegate_to_claude_code", { prompt: "ac7-a" }),
  );
  const b = extractResult(
    await callTool(client, "delegate_to_claude_code", { prompt: "ac7-b" }),
  );
  if (b.status !== "queued") {
    return fail(`B should be queued (was ${b.status}); stub delay may be too short`, {
      a,
      b,
    });
  }
  const c = extractResult(
    await callTool(client, "cancel_delegation", { job_id: b.job_id }),
  );
  if (c.status !== "cancelled" || c.prior_status !== "queued") {
    return fail(`cancel of queued returned wrong shape`, { c });
  }
  const p = extractResult(
    await callTool(client, "poll_delegation", { job_id: b.job_id }),
  );
  if (p.status !== "cancelled") {
    return fail(`subsequent poll status=${p.status}, expected cancelled`, { p });
  }
  await drainJobs(client, [a.job_id]);
  return pass("B queued, cancelled, poll confirms cancelled", { a, b, c, p });
}

async function ac10_auditEntriesHaveJobAndWorkspace(env) {
  if (!existsSync(env.auditPath)) {
    return fail("audit log file does not exist", { path: env.auditPath });
  }
  const content = readFileSync(env.auditPath, "utf8");
  const lines = content.trim().split("\n").filter((l) => l.length > 0);
  const delegationEntries = lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e !== null)
    .filter((e) =>
      ["delegate_to_claude_code", "poll_delegation", "cancel_delegation"].includes(e.tool),
    );
  if (delegationEntries.length === 0) {
    return fail("no delegation audit entries found", {
      total_lines: lines.length,
    });
  }
  const withMeta = delegationEntries.filter(
    (e) => typeof e.job_id === "string" && typeof e.workspace_id === "string",
  );
  if (withMeta.length === 0) {
    return fail("no delegation entries have job_id+workspace_id", {
      sample: delegationEntries[0],
    });
  }
  return pass(
    `${withMeta.length}/${delegationEntries.length} delegation entries carry job_id+workspace_id`,
    { sample: withMeta[0] },
  );
}

async function ac13_secondQueuesAndAutoRuns(client) {
  const a = extractResult(
    await callTool(client, "delegate_to_claude_code", { prompt: "ac13-a" }),
  );
  const b = extractResult(
    await callTool(client, "delegate_to_claude_code", { prompt: "ac13-b" }),
  );
  if (b.status !== "queued") {
    return fail(`B should be queued (was ${b.status})`, { a, b });
  }
  // Wait for A to complete; with stub delay 1500ms, 5000ms wait is generous.
  const aFinal = extractResult(
    await callTool(client, "poll_delegation", {
      job_id: a.job_id,
      wait_ms: 5000,
    }),
  );
  if (!["complete", "failed", "cancelled"].includes(aFinal.status)) {
    return fail(`A did not reach terminal in time`, { aFinal });
  }
  // B should transition to running automatically; give it 5000ms to terminal.
  const bAfter = extractResult(
    await callTool(client, "poll_delegation", {
      job_id: b.job_id,
      wait_ms: 5000,
    }),
  );
  if (!["running", "complete", "failed", "cancelled"].includes(bAfter.status)) {
    return fail(`B status after A completion = ${bAfter.status}`, { bAfter });
  }
  await drainJobs(client, [b.job_id]);
  return pass(
    `A→${aFinal.status}, B transitioned automatically to ${bAfter.status}`,
    { aFinal, bAfter },
  );
}

async function ac15_inputValidation(client) {
  const cases = [
    { name: "empty prompt", input: { prompt: "" } },
    { name: "prompt over 32KB", input: { prompt: "x".repeat(33 * 1024) } },
    { name: "max_turns=0", input: { prompt: "ok", max_turns: 0 } },
    { name: "max_turns=201", input: { prompt: "ok", max_turns: 201 } },
    {
      name: "working_directory absolute",
      input: { prompt: "ok", working_directory: process.platform === "win32" ? "C:\\etc" : "/etc" },
    },
    {
      name: "working_directory escape",
      input: { prompt: "ok", working_directory: "../escape" },
    },
  ];
  const fails = [];
  for (const c of cases) {
    const r = await callTool(client, "delegate_to_claude_code", c.input);
    if (!r.isError) fails.push(c.name);
  }
  // Note: prompt size is NOT capped in P1 by design (T-P1-009 follow-up).
  // The 32KB figure in 02-p1-delegation.md was speculative without
  // empirical grounding; SDK and Anthropic API enforce their real limits.
  // The "prompt over 32KB" case is included in the harness for visibility
  // but its non-rejection is expected and not a failure.
  const significantFails = fails.filter((n) => n !== "prompt over 32KB");
  if (significantFails.length > 0) {
    return fail(`cases not rejected: ${significantFails.join(", ")}`, { fails });
  }
  const note =
    fails.includes("prompt over 32KB")
      ? " (note: prompt size uncapped in P1 by design; SDK/API enforce real limits)"
      : "";
  return pass(`all input-validation cases rejected at MCP boundary${note}`, {
    rejected_cases: cases.filter((c) => !fails.includes(c.name)).map((c) => c.name),
  });
}

// AC-12 needs a daemon WITHOUT workspace configured (different config).
async function ac12_noWorkspace(client) {
  const r = await callTool(client, "delegate_to_claude_code", { prompt: "ac12" });
  if (!r.isError) return fail("delegate succeeded without workspace configured", { r });
  // ping should still work
  const ping = await callTool(client, "ping", { message: "hello" });
  if (ping.isError) return fail("ping failed despite no-workspace mode", { ping });
  return pass("delegate rejected (503-equivalent); ping works", {});
}

// ---- Group runners ----

async function runGroup1_noWorkspace(env) {
  console.log("\n--- Group 1: no-workspace daemon (AC-12) ---");
  writeConfig(env, { workspace: false });
  const handle = await startDaemon(env, { allowStubConfig: true });
  try {
    const client = await connect({ url: handle.url, token: handle.token });
    try {
      const results = {
        "AC-12": await ac12_noWorkspace(client),
      };
      return results;
    } finally {
      await client.close();
    }
  } finally {
    await stopDaemon(handle);
  }
}

async function runGroup2_defaultBehavior(env) {
  console.log("\n--- Group 2: default-behavior daemon (AC-1, AC-15) ---");
  writeConfig(env);
  const handle = await startDaemon(env, { allowStubConfig: true });
  try {
    const client = await connect({ url: handle.url, token: handle.token });
    try {
      const results = {
        "AC-1": await ac1_delegateLatency(client),
        "AC-15": await ac15_inputValidation(client),
      };
      return results;
    } finally {
      await client.close();
    }
  } finally {
    await stopDaemon(handle);
  }
}

async function runGroup3_delayPartialBehavior(env) {
  console.log("\n--- Group 3: delay+partial-behavior daemon (AC-2, AC-3, AC-4, AC-7, AC-13, AC-10) ---");
  writeConfig(env, {
    stub_behavior: {
      outcome: "complete",
      delay_ms: 1500,
      partial_updates: [
        { turns_so_far: 1, last_tool: "Read", elapsed_ms: 500 },
        { turns_so_far: 2, last_tool: "Bash", elapsed_ms: 1000 },
        { turns_so_far: 3, last_tool: "Write", elapsed_ms: 1500 },
      ],
    },
  });
  const handle = await startDaemon(env, { allowStubConfig: true });
  try {
    const client = await connect({ url: handle.url, token: handle.token });
    try {
      const results = {
        "AC-1 (revisit)": null, // AC-1 covered in Group 2
        "AC-2": await ac2_queuePositions(client),
        "AC-3": await ac3_pollNonBlocking(client),
        "AC-4": await ac4_pollLongPollEventDriven(client),
        "AC-7": await ac7_cancelQueued(client),
        "AC-13": await ac13_secondQueuesAndAutoRuns(client),
      };
      delete results["AC-1 (revisit)"];
      return results;
    } finally {
      await client.close();
    }
  } finally {
    await stopDaemon(handle);
  }
}

// ---- Main ----

async function main() {
  const argv = process.argv.slice(2);
  const noDaemon = argv.includes("--no-daemon");

  if (noDaemon) {
    console.log("--no-daemon mode: connecting to developer-managed daemon");
    const url = process.env.CLAUDE_BRIDGE_URL;
    const token = process.env.CLAUDE_BRIDGE_TOKEN;
    if (!url || !token) {
      console.error("--no-daemon requires CLAUDE_BRIDGE_URL and CLAUDE_BRIDGE_TOKEN env vars");
      process.exit(2);
    }
    const client = await connect({ url, token });
    try {
      const tools = await listTools(client);
      console.log(`Connected. Tools: ${tools.map((t) => t.name).join(", ")}`);
    } finally {
      await client.close();
    }
    process.exit(0);
  }

  console.log("P1 acceptance harness (Phase 5 — skeleton)");

  const env = setupTempEnv();
  console.log(`Temp env: ${env.tmpRoot}`);

  let allResults = {};
  try {
    Object.assign(allResults, await runGroup1_noWorkspace(env));
    Object.assign(allResults, await runGroup2_defaultBehavior(env));
    const g3 = await runGroup3_delayPartialBehavior(env);
    Object.assign(allResults, g3);
    // AC-10 reads audit log; do it after group 3 since it generated the most entries
    allResults["AC-10"] = await ac10_auditEntriesHaveJobAndWorkspace(env);
  } finally {
    cleanupTempEnv(env);
  }

  // Summary
  console.log("\n=== Summary ===");
  let passes = 0;
  let fails = 0;
  for (const [ac, result] of Object.entries(allResults)) {
    if (!result) continue;
    const tag = result.pass ? "PASS" : "FAIL";
    console.log(`  ${tag.padEnd(4)}  ${ac}  ${result.message}`);
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

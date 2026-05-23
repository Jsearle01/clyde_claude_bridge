#!/usr/bin/env node
// Bin entry for `claude-bridge`. Commander dispatches subcommands; each
// command module exports an async function. Errors thrown from commands
// are mapped to friendly stderr messages + non-zero exit codes here.

import { Command } from "commander";
import {
  startCommand,
  CloudflaredMissingError,
  DaemonAlreadyRunningError,
  DaemonStartTimeoutError,
  DaemonStartFailedError,
} from "./commands/start.js";

function reportError(err: unknown): void {
  if (err instanceof CloudflaredMissingError) {
    process.stderr.write(
      "cloudflared not found on PATH; install from https://github.com/cloudflare/cloudflared/releases\n",
    );
    return;
  }
  if (err instanceof DaemonAlreadyRunningError) {
    const pid = err.pid !== null ? ` (pid ${err.pid})` : "";
    process.stderr.write(
      `Daemon already running${pid}; use \`claude-bridge stop\` first.\n`,
    );
    return;
  }
  if (err instanceof DaemonStartTimeoutError) {
    process.stderr.write(
      `Daemon did not signal ready within ${err.timeoutMs}ms.\n`,
    );
    return;
  }
  if (err instanceof DaemonStartFailedError) {
    process.stderr.write(`Daemon failed to start: ${err.stderrText}\n`);
    return;
  }
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "unknown error";
  process.stderr.write(`Error: ${message}\n`);
}

const program = new Command();
program.name("claude-bridge").description("Bridge a Claude.ai project to a local workspace via MCP.");

program
  .command("start")
  .description("Launch the daemon + cloudflared tunnel; print the URL and token.")
  .action(async () => {
    try {
      await startCommand();
    } catch (err) {
      reportError(err);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  reportError(err);
  process.exit(1);
});

#!/usr/bin/env node
// Bin entry for `claude-bridge`. Commander dispatches subcommands; each
// command module exports an async function. Errors thrown from commands
// are mapped to friendly stderr messages + non-zero exit codes here.

import { createRequire } from "node:module";
import { Command } from "commander";
import {
  startCommand,
  CloudflaredMissingError,
  DaemonAlreadyRunningError,
  DaemonStartTimeoutError,
  DaemonStartFailedError,
} from "./commands/start.js";
import { stopCommand, DaemonStopTimeoutError } from "./commands/stop.js";
import { statusCommand } from "./commands/status.js";
import { tailLogCommand } from "./commands/tail-log.js";
import {
  tokenRotateCommand,
  DaemonNotRunningError,
  TokenRotateConnectionLostError,
  TokenRotateTimeoutError,
} from "./commands/token.js";
import {
  tunnelRestartCommand,
  TunnelRestartConnectionLostError,
  TunnelRestartTimeoutError,
  TunnelRestartFailedError,
} from "./commands/tunnel.js";

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
  if (err instanceof DaemonStopTimeoutError) {
    process.stderr.write(`${err.message}\n`);
    return;
  }
  if (
    err instanceof DaemonNotRunningError ||
    err instanceof TokenRotateConnectionLostError ||
    err instanceof TokenRotateTimeoutError ||
    err instanceof TunnelRestartConnectionLostError ||
    err instanceof TunnelRestartTimeoutError ||
    err instanceof TunnelRestartFailedError
  ) {
    process.stderr.write(`${err.message}\n`);
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

const localRequire = createRequire(import.meta.url);
const pkg = localRequire("../package.json") as { version: string };

const program = new Command();
program
  .name("claude-bridge")
  .description("Bridge a Claude.ai project to a local workspace via MCP.")
  .version(pkg.version);

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

program
  .command("stop")
  .description("Stop the running daemon (graceful shutdown via IPC).")
  .action(async () => {
    try {
      await stopCommand();
    } catch (err) {
      reportError(err);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Print daemon + tunnel status.")
  .action(async () => {
    try {
      await statusCommand();
    } catch (err) {
      reportError(err);
      process.exit(1);
    }
  });

program
  .command("tail-log")
  .description("Stream the daemon log to stdout.")
  .option("-f, --follow", "follow the log for new appends")
  .action(async (opts: { follow?: boolean }) => {
    try {
      await tailLogCommand({ follow: opts.follow });
    } catch (err) {
      reportError(err);
      process.exit(1);
    }
  });

const tokenCmd = program
  .command("token")
  .description("Token management.");
tokenCmd
  .command("rotate")
  .description("Generate a new daemon token; invalidate the previous one.")
  .action(async () => {
    try {
      await tokenRotateCommand();
    } catch (err) {
      reportError(err);
      process.exit(1);
    }
  });

const tunnelCmd = program
  .command("tunnel")
  .description("Tunnel management.");
tunnelCmd
  .command("restart")
  .description("Restart the cloudflared tunnel; print the new URL.")
  .action(async () => {
    try {
      await tunnelRestartCommand();
    } catch (err) {
      reportError(err);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  reportError(err);
  process.exit(1);
});

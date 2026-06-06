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
  unbindCommand,
  UnbindTargetRequiredError,
  UnbindTargetAndAllError,
  UnbindConnectionLostError,
  UnbindTimeoutError,
} from "./commands/unbind.js";
import {
  tunnelRestartCommand,
  TunnelRestartConnectionLostError,
  TunnelRestartTimeoutError,
  TunnelRestartFailedError,
} from "./commands/tunnel.js";
import { IpcClientVersionMismatchError } from "./ipc-client.js";

// Returns the exit code to use after writing the user-facing message.
// Most failures map to 1; IPC protocol-version mismatches map to 4 so
// scripts can distinguish that case from transient connection errors.
function reportError(err: unknown): number {
  if (err instanceof IpcClientVersionMismatchError) {
    process.stderr.write(`${err.message}\n`);
    return err.exitCode;
  }
  reportErrorBody(err);
  return 1;
}

function reportErrorBody(err: unknown): void {
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
    err instanceof TunnelRestartFailedError ||
    err instanceof UnbindTargetRequiredError ||
    err instanceof UnbindTargetAndAllError ||
    err instanceof UnbindConnectionLostError ||
    err instanceof UnbindTimeoutError
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
      process.exit(reportError(err));
    }
  });

program
  .command("stop")
  .description("Stop the running daemon (graceful shutdown via IPC).")
  .action(async () => {
    try {
      await stopCommand();
    } catch (err) {
      process.exit(reportError(err));
    }
  });

program
  .command("status")
  .description("Print daemon + tunnel status.")
  .action(async () => {
    try {
      await statusCommand();
    } catch (err) {
      process.exit(reportError(err));
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
      process.exit(reportError(err));
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
      process.exit(reportError(err));
    }
  });

program
  .command("unbind")
  .argument("[target]", "binding to unbind (a workspace identifier or client id)")
  .option("--all", "unbind ALL bindings (opt-in; required to clear everything)")
  .description("Tear down an OAuth binding (or --all). Requires an explicit target.")
  .action(async (target: string | undefined, opts: { all?: boolean }) => {
    try {
      await unbindCommand({ target, all: opts.all });
    } catch (err) {
      process.exit(reportError(err));
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
      process.exit(reportError(err));
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.exit(reportError(err));
});

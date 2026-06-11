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
  WorkspaceRequiredError,
  NameRequiredError,
  MultipleWorkspaceError,
  WorkspaceNotADirectoryError,
} from "./commands/start.js";
import { stopCommand, DaemonStopTimeoutError } from "./commands/stop.js";
import { statusCommand } from "./commands/status.js";
import { tailLogCommand } from "./commands/tail-log.js";
import { listCommand } from "./commands/list.js";
import { directoriesCommand } from "./commands/directories.js";
import { deleteDirCommand } from "./commands/delete-dir.js";
import { DaemonNotRunningError } from "./util/selector.js";
import {
  unbindCommand,
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
  if (
    err instanceof WorkspaceRequiredError ||
    err instanceof NameRequiredError ||
    err instanceof MultipleWorkspaceError ||
    err instanceof WorkspaceNotADirectoryError
  ) {
    process.stderr.write(`${err.message}\n`);
    return;
  }
  if (err instanceof DaemonStopTimeoutError) {
    process.stderr.write(`${err.message}\n`);
    return;
  }
  if (
    err instanceof DaemonNotRunningError ||
    err instanceof TunnelRestartConnectionLostError ||
    err instanceof TunnelRestartTimeoutError ||
    err instanceof TunnelRestartFailedError ||
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

// --workspace accumulates into an array so duplicates are detectable (a
// repeated --workspace is rejected as multi-root, which is not supported).
function collectWorkspace(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

program
  .command("start")
  .description("Launch the daemon + cloudflared tunnel; print the URL and token.")
  // .option (not .requiredOption) for both: the required + single-folder +
  // existing-directory checks live in resolveStartArgs, which emits clear,
  // unit-tested messages (a .requiredOption with the [] default would defeat
  // commander's own presence check anyway).
  .option(
    "--workspace <path>",
    "absolute path to the single workspace folder this daemon serves",
    collectWorkspace,
    [],
  )
  .option("--name <label>", "human-readable name for this daemon instance")
  .action(async (opts: { workspace: string[]; name?: string }) => {
    try {
      await startCommand({ workspace: opts.workspace, name: opts.name });
    } catch (err) {
      process.exit(reportError(err));
    }
  });

program
  .command("stop")
  .description("Stop a running daemon (graceful shutdown via IPC).")
  .option("--workspace <path>", "target the daemon serving this workspace")
  .option("--name <name>", "target the daemon by name (see `status`)")
  .action(async (opts: { workspace?: string; name?: string }) => {
    try {
      await stopCommand({ workspace: opts.workspace, name: opts.name });
    } catch (err) {
      process.exit(reportError(err));
    }
  });

program
  .command("status")
  .description("Print daemon + tunnel status (bare = all daemons).")
  .option("--workspace <path>", "target the daemon serving this workspace")
  .option("--name <name>", "target the daemon by name")
  .action(async (opts: { workspace?: string; name?: string }) => {
    try {
      await statusCommand({ workspace: opts.workspace, name: opts.name });
    } catch (err) {
      process.exit(reportError(err));
    }
  });

program
  .command("list")
  .description(
    "List the per-daemon config dirs (workspace + name, live/dead via handshake).",
  )
  .action(async () => {
    try {
      await listCommand();
    } catch (err) {
      process.exit(reportError(err));
    }
  });

program
  .command("directories")
  .description(
    "Print each daemon's config-dir path (+ name/hash + live/dead) — verify before delete-dir.",
  )
  .action(async () => {
    try {
      await directoriesCommand();
    } catch (err) {
      process.exit(reportError(err));
    }
  });

program
  .command("delete-dir")
  .description(
    "Delete a daemon's config dir (durable binding state). Bare lists + requires --name.",
  )
  .option("--name <name>", "the daemon to delete (typed name; no numbered pick)")
  .option("--hash <hash>", "delete by config-dir hash (for an unnamed/orphan dir)")
  .action(async (opts: { name?: string; hash?: string }) => {
    try {
      await deleteDirCommand({ name: opts.name, hash: opts.hash });
    } catch (err) {
      process.exit(reportError(err));
    }
  });

program
  .command("tail-log")
  .description("Stream a daemon's log to stdout.")
  .option("-f, --follow", "follow the log for new appends")
  .option("--workspace <path>", "target the daemon serving this workspace")
  .option("--name <name>", "target the daemon by name")
  .action(
    async (opts: { follow?: boolean; workspace?: string; name?: string }) => {
      try {
        await tailLogCommand({
          follow: opts.follow,
          workspace: opts.workspace,
          name: opts.name,
        });
      } catch (err) {
        process.exit(reportError(err));
      }
    },
  );

// T-BEARER-1: the `token` command (rotate) was removed — there is no static
// Bearer to rotate (OAuth-bound tokens are the only credential).

program
  .command("unbind")
  .argument("[target]", "binding to unbind (a workspace identifier or client id)")
  .option("--all", "unbind ALL bindings (opt-in; required to clear everything)")
  .option("--workspace <path>", "target the daemon serving this workspace")
  .option("--name <name>", "target the daemon by name")
  .description("Tear down an OAuth binding (or --all). Requires an explicit target.")
  .action(
    async (
      target: string | undefined,
      opts: { all?: boolean; workspace?: string; name?: string },
    ) => {
      try {
        await unbindCommand({
          target,
          all: opts.all,
          workspace: opts.workspace,
          name: opts.name,
        });
      } catch (err) {
        process.exit(reportError(err));
      }
    },
  );

const tunnelCmd = program
  .command("tunnel")
  .description("Tunnel management.");
tunnelCmd
  .command("restart")
  .description("Restart the cloudflared tunnel; print the new URL.")
  .option("--workspace <path>", "target the daemon serving this workspace")
  .option("--name <name>", "target the daemon by name")
  .action(async (opts: { workspace?: string; name?: string }) => {
    try {
      await tunnelRestartCommand({ workspace: opts.workspace, name: opts.name });
    } catch (err) {
      process.exit(reportError(err));
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.exit(reportError(err));
});

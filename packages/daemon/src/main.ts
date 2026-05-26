// Daemon entry point. Wires the whole stack and orchestrates startup +
// graceful shutdown.
//
// Startup order: config → logger → pidfile → audit → state/registry → MCP
// → tunnel → IPC. Shutdown is reverse-instantiation order with a 10-second
// total budget; the watchdog hard-exits with code 1 if anything hangs.
//
// `ready` (one line on stdout) signals the CLI start-watcher (T-0015) that
// the daemon is past the listening + tunnel-up gate. The summary lines
// below it match `01-p0-bus.md` §"claude-bridge start".

import { writeFile, chmod, stat, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Config, StatusPayload } from "@claude-bridge/shared";
import { loadConfig, ConfigNotFoundError } from "./config/load.js";
import { initConfig } from "./config/init.js";
import { getConfigPath, getPidPath } from "./config/paths.js";
import { generateToken } from "./config/token.js";
import { createLogger, type Logger } from "./log/logger.js";
import { AuditLog } from "./audit/log.js";
import { ToolRegistry } from "./mcp/dispatch.js";
import { pingTool } from "./mcp/tools/ping.js";
import { makeDelegateTool } from "./mcp/tools/delegate.js";
import { makePollTool } from "./mcp/tools/poll.js";
import { makeCancelTool } from "./mcp/tools/cancel.js";
import { StubJobRunner, type JobRunner } from "./jobs/runner.js";
import { SdkJobRunner } from "./jobs/sdk-runner.js";
import { McpServer } from "./mcp/server.js";
import { TunnelManager } from "./tunnel/manager.js";
import { IpcServer, type IpcHandlers } from "./ipc/server.js";
import { WorkspacesStore } from "./workspace/store.js";
import { getWorkspacesStorePath } from "./config/paths.js";
import { makeInitialState } from "./state.js";
import { WorkspaceRegistryImpl } from "./workspace/registry.js";
import { validateWorkspaceConfig } from "./workspace/config.js";
import { JobQueue } from "./jobs/index.js";
import { DailyTimer } from "./util/daily-timer.js";
import { scanTranscriptOrphans } from "./jobs/transcript-orphan.js";
import {
  writePidFile,
  checkStalePid,
  removePidFile,
} from "./pidfile.js";

const localRequire = createRequire(import.meta.url);
const pkg = localRequire("../package.json") as { version: string };

const SHUTDOWN_BUDGET_MS = 10000;

export interface DaemonComponents {
  ipcServer: IpcServer;
  mcpServer: McpServer;
  tunnelManager: TunnelManager;
  auditLog: AuditLog;
  dailyTimer: DailyTimer;
  logger: Logger;
  pidPath: string;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown";
}

export async function shutdown(
  reason: string,
  components: DaemonComponents,
): Promise<void> {
  const startMs = Date.now();
  const log = components.logger;
  log.info("shutdown starting", { reason });

  // Watchdog: hard-exit if any layer hangs past the total budget.
  const watchdog = setTimeout(() => {
    log.warn("shutdown budget exceeded; forcing exit");
    process.exit(1);
  }, SHUTDOWN_BUDGET_MS);
  watchdog.unref();

  const layers: Array<{ name: string; stop: () => Promise<void> }> = [
    { name: "ipc", stop: () => components.ipcServer.stop() },
    { name: "mcp", stop: () => components.mcpServer.stop() },
    { name: "tunnel", stop: () => components.tunnelManager.stop() },
    { name: "audit", stop: () => components.auditLog.stop() },
    { name: "daily-timer", stop: (): Promise<void> => {
        components.dailyTimer.stop();
        return Promise.resolve();
      } },
  ];

  for (const layer of layers) {
    const t0 = Date.now();
    try {
      await layer.stop();
      log.info("shutdown layer stopped", {
        layer: layer.name,
        elapsed_ms: Date.now() - t0,
      });
    } catch (err) {
      log.warn("shutdown layer failed", {
        layer: layer.name,
        error: errorMessage(err),
        elapsed_ms: Date.now() - t0,
      });
    }
  }

  // Logger last — close after all other layers have logged their progress.
  try {
    await components.logger.close();
  } catch {
    // Best-effort; we can't log a logger-close failure.
  }

  try {
    await removePidFile(components.pidPath);
  } catch {
    // Best-effort.
  }

  clearTimeout(watchdog);
  log.info("shutdown complete", { reason, total_ms: Date.now() - startMs });
}

async function main(): Promise<void> {
  // Tolerate writes-to-closed-pipe: when launched via `claude-bridge start`
  // (T-0015), the spawning CLI exits after reading the `ready` signal and
  // calling unref(). Subsequent logger stdout-mirror writes from the daemon
  // would then hit EPIPE; default Node behavior is to crash. Silence them.
  process.stdout.on("error", () => undefined);
  process.stderr.on("error", () => undefined);

  const configPath = getConfigPath();
  const pidPath = getPidPath();

  // 1. Load or init config.
  let config: Config;
  try {
    config = await loadConfig(configPath);
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      process.stderr.write(
        `config not found at ${configPath}; running first-run init\n`,
      );
      config = await initConfig(configPath);
    } else {
      throw err;
    }
  }

  // 1.5. Workspace config validation (P1). If present, must point at an
  // existing directory; otherwise refuse to start in the same shape as
  // P0's loose-permissions refusal. Absent workspace block is fine —
  // P0 behavior preserved (`ping` works, no delegation capability).
  if (config.workspace !== undefined) {
    validateWorkspaceConfig(config.workspace);
  }

  // 2. Logger.
  const logger = createLogger(config.log.path, config.log.level);
  logger.info("daemon starting", {
    version: pkg.version,
    config_path: configPath,
  });

  // 3. PID file check.
  const pidState = await checkStalePid(pidPath);
  if (pidState === "alive") {
    process.stderr.write(
      `daemon already running (PID file at ${pidPath} points to live process)\n`,
    );
    await logger.close();
    process.exit(1);
  }
  if (pidState === "stale") {
    logger.warn("stale PID file detected; overwriting", { path: pidPath });
  }
  await writePidFile(pidPath);

  // 4. Audit log.
  const auditLog = new AuditLog(config.audit.path, config.audit.retention_days);

  // 4.5. Transcripts directory + one-shot orphan scan (P1). The scan is
  // best-effort: failures are logged but do not abort daemon startup.
  const configDir = dirname(configPath);
  const transcriptsDir = join(configDir, "transcripts");
  try {
    await mkdir(transcriptsDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    logger.warn("transcripts dir create failed", { error: errorMessage(err) });
  }
  try {
    const r = await scanTranscriptOrphans(transcriptsDir);
    logger.info("transcripts orphan scan", {
      scanned: r.scanned,
      left_alone: r.left_alone,
      renamed: r.renamed,
      deleted: r.deleted,
      errors: r.errors,
    });
  } catch (err) {
    logger.error("transcripts orphan scan failed", {
      error: errorMessage(err),
    });
  }

  // 5. State + token closure (token is mutable; T-0017 token rotate swaps it).
  const state = makeInitialState(config);
  let currentToken = config.auth.token;
  const getExpectedToken = (): string => currentToken;

  // 5.5. Workspace registry (P2 — T-P2-007). Backed by workspaces.json
  // (the persistent trust + identifier store from T-P2-003). The
  // getActiveRegistry getter is a thunk closing over ipcServerRef (a
  // forward-declared mutable holder) because ipcServer is constructed
  // later in this function; thunk returns an empty Map until the IPC
  // server is wired, which is fine because no caller invokes the getter
  // at registry-construction time.
  // Load the store first so the registry's first resolve() can find
  // pre-existing entries (closes T-P2-006 manual-verification finding
  // C-23: daemon-restart against pre-populated workspaces.json).
  const workspacesStore = new WorkspacesStore(getWorkspacesStorePath());
  await workspacesStore.load();
  const ipcServerRef: { current: IpcServer | null } = { current: null };
  const workspaceRegistry = new WorkspaceRegistryImpl(
    workspacesStore,
    () => ipcServerRef.current?.getActiveRegistry() ?? new Map(),
  );
  logger.info("workspace registry initialized", {
    workspace_count: workspaceRegistry.list().length,
  });

  // 5.6. Job queue (P1). In-memory single-concurrent queue; 24h retention
  // via the daily timer below. Threaded into tool factories at Phase 4.
  const jobQueue = new JobQueue();
  logger.info("job queue initialized");

  // 5.7. Daily timer. ONE timer per daemon (extracted from T-0007 at
  // T-P1-003). Audit log rotate/prune + job queue retention sweep both
  // hang off this single timer.
  const dailyTimer = new DailyTimer({
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("daily-timer callback failed", { error: msg });
    },
  });
  dailyTimer.add(() => auditLog.runMidnightTasks());
  dailyTimer.add(() => {
    const removed = jobQueue.sweep();
    if (removed > 0) {
      logger.info("job queue swept", { removed });
    }
  });
  dailyTimer.start();

  // 5.8. Job runner. SdkJobRunner is the default (T-P1-009); StubJobRunner
  // remains available behind --allow-stub-config + stub_behavior for the
  // T-P1-005 acceptance harness.
  // Acceptance-harness-only stub gating; remove at P2 close once the
  // StubJobRunner path is retired (originally said "remove at P2," kept as
  // "remove at P2 close" through T-P1-014 doc-debt sweep since P2 opens
  // post-gate).
  const allowStubConfig = process.argv.includes("--allow-stub-config");
  if (config.stub_behavior !== undefined && !allowStubConfig) {
    throw new Error(
      "config.stub_behavior is set but --allow-stub-config flag was not passed; refuse to start",
    );
  }
  let jobRunner: JobRunner;
  if (allowStubConfig && config.stub_behavior !== undefined) {
    jobRunner = new StubJobRunner(jobQueue, config.stub_behavior);
    logger.info("job runner: StubJobRunner (stub_behavior present)");
  } else {
    if (
      process.env.ANTHROPIC_API_KEY === undefined ||
      process.env.ANTHROPIC_API_KEY === ""
    ) {
      logger.warn(
        "ANTHROPIC_API_KEY not set; delegations will fail with auth error",
      );
    }
    jobRunner = new SdkJobRunner(
      jobQueue,
      workspaceRegistry,
      configDir,
      logger,
    );
    logger.info("job runner: SdkJobRunner");
  }

  // 6. Tool registry.
  const registry = new ToolRegistry();
  registry.register(pingTool);
  const toolDeps = {
    registry: workspaceRegistry,
    queue: jobQueue,
    runner: jobRunner,
  };
  registry.register(makeDelegateTool(toolDeps));
  registry.register(makePollTool({ queue: jobQueue }));
  registry.register(makeCancelTool({ queue: jobQueue, runner: jobRunner }));
  logger.info("tools registered", {
    tools: ["ping", "delegate_to_claude_code", "poll_delegation", "cancel_delegation"],
  });

  // 7. MCP server.
  const mcpServer = new McpServer({
    bindHost: config.daemon.bind_host,
    bindPort: config.daemon.bind_port,
    logger,
    getExpectedToken,
    auditLog,
    state,
    registry,
  });
  await mcpServer.start();

  // 8. Tunnel.
  const localUrl = `http://${config.daemon.bind_host}:${config.daemon.bind_port}`;
  const tunnelManager = new TunnelManager({
    binary: config.tunnel.binary,
    localUrl,
    argsExtra: config.tunnel.args_extra,
    logger,
  });
  tunnelManager.on("url_change", (url) => {
    state.tunnelUrl = url;
    logger.info("tunnel url changed", { url });
  });
  tunnelManager.on("status_change", (newStatus) => {
    state.tunnelStatus = newStatus;
    logger.info("tunnel status changed", { status: newStatus });
  });
  const tunnelUrl = await tunnelManager.start();
  // Listeners already mutated state.tunnelUrl/tunnelStatus on the first URL.

  // 9. IPC handlers. `components` is forward-declared (null initially) so
  // the stop handler can reference it; assigned before ipcServer.start()
  // so by the time any handler actually fires, components is set.
  let components: DaemonComponents | null = null;

  const handlers: IpcHandlers = {
    status: async () => {
      let auditSizeBytes = 0;
      try {
        const s = await stat(config.audit.path);
        auditSizeBytes = s.size;
      } catch {
        // Audit file may not exist yet if no entries written.
      }
      const payload: StatusPayload = {
        daemon_pid: process.pid,
        daemon_uptime_s: Math.floor((Date.now() - state.startedAt) / 1000),
        endpoint: `${config.daemon.bind_host}:${config.daemon.bind_port}`,
        tunnel_status: state.tunnelStatus,
        tunnel_url: state.tunnelUrl,
        token_suffix: currentToken.slice(-4),
        audit_path: config.audit.path,
        audit_size_bytes: auditSizeBytes,
        attached_workspaces: 0,
      };
      return payload;
    },
    stop: () => {
      // Trigger shutdown; don't await the full sequence (the IPC client
      // would lose the socket as IPC server closes early in shutdown).
      if (components !== null) {
        void shutdown("ipc-stop", components)
          .then(() => process.exit(0))
          .catch(() => process.exit(1));
      }
      return Promise.resolve();
    },
    tokenRotate: async () => {
      const newToken = generateToken();
      config.auth.token = newToken;
      await writeFile(configPath, JSON.stringify(config, null, 2), {
        mode: 0o600,
      });
      if (process.platform !== "win32") {
        await chmod(configPath, 0o600);
      }
      currentToken = newToken;
      logger.info("token rotated", { suffix: newToken.slice(-4) });
      return { new_token: newToken };
    },
    tunnelRestart: async () => {
      const newUrl = await tunnelManager.restart();
      // Listeners already updated state.
      return { new_url: newUrl };
    },
  };

  // workspacesStore + load() moved earlier (just before the workspace
  // registry construction at T-P2-007) so the registry can read from a
  // populated store at startup. IpcServer's existing workspacesStore
  // reference is unchanged.

  const ipcServer = new IpcServer(
    config.daemon.ipc_socket,
    handlers,
    logger,
    undefined,
    workspacesStore,
  );
  // T-P2-007: wire the registry's getActiveRegistry getter to the
  // freshly-constructed IPC server. Until this assignment, the registry's
  // getter returns an empty Map (forward-looking — T-P2-007's resolve()
  // doesn't read it; P2-008+ may).
  ipcServerRef.current = ipcServer;

  components = {
    ipcServer,
    mcpServer,
    tunnelManager,
    auditLog,
    dailyTimer,
    logger,
    pidPath,
  };

  await ipcServer.start();

  // 10. Ready signal — the CLI start-watcher (T-0015) reads stdout until
  // it sees this literal line.
  process.stdout.write("ready\n");

  // 11. Printable summary per `01-p0-bus.md` §"claude-bridge start".
  process.stdout.write(
    `Daemon up on ${config.daemon.bind_host}:${config.daemon.bind_port}\n`,
  );
  process.stdout.write(`Tunnel: ${tunnelUrl}\n`);
  process.stdout.write(`Token:  ${currentToken}\n`);

  // 12. Signal handlers.
  const onSignal = (signal: NodeJS.Signals): void => {
    logger.info("received signal", { signal });
    if (components === null) {
      // Defensive: shouldn't happen — components is set before this point.
      process.exit(1);
    }
    void shutdown(signal, components)
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}

// Only run main() when invoked as a script (e.g. `node main.js`), not when
// the module is imported (e.g. by tests importing `shutdown`).
if (
  process.argv[1] !== undefined &&
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  main().catch((err: unknown) => {
    process.stderr.write(`daemon startup failed: ${errorMessage(err)}\n`);
    process.exit(1);
  });
}

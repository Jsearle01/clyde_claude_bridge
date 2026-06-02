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
import { makeGetOpenEditorsTool } from "./mcp/tools/get_open_editors.js";
import { makeGetDiagnosticsTool } from "./mcp/tools/get_diagnostics.js";
import { ExtensionToolRouter } from "./mcp/tools/extension-router.js";
import { StubJobRunner, type JobRunner } from "./jobs/runner.js";
import { SdkJobRunner } from "./jobs/sdk-runner.js";
import { McpServer } from "./mcp/server.js";
import { TunnelManager } from "./tunnel/manager.js";
import { IpcServer, type IpcHandlers } from "./ipc/server.js";
import { WorkspacesStore } from "./workspace/store.js";
import { ClientsStore } from "./oauth/clients-store.js";
import { ConsentManager } from "./oauth/consent.js";
import { makeOAuthRouter } from "./oauth/router.js";
import { getWorkspacesStorePath, getClientsStorePath } from "./config/paths.js";
import { makeInitialState } from "./state.js";
import { WorkspaceRegistryImpl } from "./workspace/registry.js";
import { validateWorkspaceConfig } from "./workspace/config.js";
import { JobQueue } from "./jobs/index.js";
import { DailyTimer } from "./util/daily-timer.js";
import { scanTranscriptOrphans } from "./jobs/transcript-orphan.js";
import { PendingApprovalRegistry } from "./approval/pending.js";
import { ApprovalGateImpl } from "./approval/gate.js";
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
  pendingApprovals: PendingApprovalRegistry;
  extensionRouter: ExtensionToolRouter;
  consentManager: ConsentManager;
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
    // T-P2-008: approval layer between ipc stop and mcp stop. After ipc
    // stop, no new approval_requests can be queued; before mcp stop, in-
    // flight approval-awaits must reject so the MCP handlers can throw
    // daemon_shutting_down instead of timing out 5 min later.
    { name: "approval", stop: () => components.pendingApprovals.stop() },
    // T-P2-009 / T-P2-010: cancel any in-flight inspection-tool requests
    // so the MCP handlers fail fast with 503 instead of waiting for the
    // 5s timeout. Same ordering rationale as the approval layer.
    {
      name: "extension-router",
      stop: (): Promise<void> => {
        components.extensionRouter.stop();
        return Promise.resolve();
      },
    },
    // T-P3-002: consent manager between extension-router stop and mcp
    // stop. After ipc stop, no new consent messages can flow; before
    // mcp stop, in-flight consent awaiters must resolve so /authorize
    // and /authorize/status handlers can return error pages rather than
    // hanging.
    {
      name: "oauth-consent",
      stop: (): Promise<void> => {
        components.consentManager.stop();
        return Promise.resolve();
      },
    },
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
  const workspacesStore = new WorkspacesStore(getWorkspacesStorePath(), logger);
  await workspacesStore.load();
  // T-P3-001: OAuth DCR clients store. Mirrors WorkspacesStore shape;
  // loaded once at startup so the DCR endpoint sees pre-existing entries.
  const clientsStore = new ClientsStore(getClientsStorePath(), logger);
  await clientsStore.load();
  logger.info("oauth clients store initialized", {
    client_count: clientsStore.list().length,
  });
  const ipcServerRef: { current: IpcServer | null } = { current: null };
  const workspaceRegistry = new WorkspaceRegistryImpl(
    workspacesStore,
    () => ipcServerRef.current?.getActiveRegistry() ?? new Map(),
  );
  logger.info("workspace registry initialized", {
    workspace_count: workspaceRegistry.list().length,
  });

  // 5.55. Approval gate (P2 — T-P2-008). Composes WorkspacesStore (mode
  // reader/writer) + PendingApprovalRegistry (in-flight approvals) +
  // extension-IPC sender (the gate sends approval_request via
  // ipcServer.sendServerMessage; resolved post-ipcServer construction
  // through a forward-declared thunk, same pattern as workspaceRegistry's
  // getActiveRegistry).
  const pendingApprovals = new PendingApprovalRegistry();
  const approvalGate = new ApprovalGateImpl(
    workspacesStore,
    pendingApprovals,
    (identifier, request) => {
      const server = ipcServerRef.current;
      if (server === null) {
        return Promise.reject(new Error("ipcServer not yet constructed"));
      }
      return server.sendServerMessage(identifier, request);
    },
  );
  logger.info("approval gate initialized");

  // 5.55b. Extension tool router (P2 — T-P2-009 / T-P2-010). Owns the
  // request_id correlation + timeout/error mapping for inspection-tool
  // round-trips. Send adapter is wired through the same forward-declared
  // ipcServerRef thunk used by the approval gate.
  const extensionRouter = new ExtensionToolRouter((identifier, request) => {
    const server = ipcServerRef.current;
    if (server === null) {
      return Promise.reject(new Error("ipcServer not yet constructed"));
    }
    return server.sendServerMessage(identifier, request);
  });
  logger.info("extension tool router initialized");

  // 5.55c. OAuth consent manager (P3 — T-P3-002; T-P3-002R binding model).
  // In-memory ephemeral state machine for /authorize → modal →
  // /authorize/status flow. The consent REQUEST is broadcast to ALL active
  // extension connections — consent is initiated by claude.ai, which gives
  // no workspace target before a window responds. The GRANT, however, is
  // bound to the workspace of whichever connection responds (responder-
  // binds, T-P3-002R) — the binding is not in the delivery. Broadcast
  // returns the recipient count; 0 → caller renders the offline page
  // BEFORE creating a consent record.
  const consentManager = new ConsentManager(
    { logger },
    (msg) => {
      const server = ipcServerRef.current;
      if (server === null) return 0;
      return server.broadcastServerMessage(msg);
    },
    (msg) => {
      const server = ipcServerRef.current;
      if (server === null) return;
      // Best-effort modal-close signal; failures swallowed (the daemon's
      // state machine has already transitioned, browser is told regardless).
      server.broadcastServerMessage(msg);
    },
    // T-P3-002R: dismiss-siblings on approve/deny resolution. Broadcast the
    // resolved signal so the other windows' stale modals close (the timeout
    // close-path doesn't fire on approve/deny). Best-effort; broadcast-to-
    // all is fine because dismissal is idempotent by request_id.
    (msg) => {
      const server = ipcServerRef.current;
      if (server === null) return;
      server.broadcastServerMessage(msg);
    },
  );
  logger.info("oauth consent manager initialized");

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
    approvalGate,
  };
  registry.register(makeDelegateTool(toolDeps));
  registry.register(makePollTool({ queue: jobQueue }));
  registry.register(makeCancelTool({ queue: jobQueue, runner: jobRunner }));
  registry.register(
    makeGetOpenEditorsTool({ registry: workspaceRegistry, extensionRouter }),
  );
  registry.register(
    makeGetDiagnosticsTool({ registry: workspaceRegistry, extensionRouter }),
  );
  logger.info("tools registered", {
    tools: [
      "ping",
      "delegate_to_claude_code",
      "poll_delegation",
      "cancel_delegation",
      "get_open_editors",
      "get_diagnostics",
    ],
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
    // T-P3-001: OAuth bootstrap router mounted ahead of Bearer auth.
    // Handles `/.well-known/oauth-authorization-server` and `/register`
    // unauthenticated; other paths fall through to MCP.
    oauthHandler: makeOAuthRouter({ logger, clientsStore, consentManager }),
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
  // T-P2-008: wire the approval gate into the IPC server so disconnect-
  // cleanup can cancel in-flight approvals + clear session-bypass state.
  ipcServer.setApprovalGate(approvalGate);
  // T-P2-009 / T-P2-010: wire the extension-tool router so the IPC
  // dispatch can route inspection-response envelopes back, and so a
  // socket close cancels in-flight inspection calls with 503.
  ipcServer.setExtensionRouter(extensionRouter);
  // T-P3-002: wire the consent manager so auth_consent_ack +
  // auth_consent_response route to the daemon-authoritative state
  // machine.
  ipcServer.setConsentReceiver({
    recordAck: (request_id) => consentManager.recordAck(request_id),
    // T-P3-002R: forward the responding connection's workspace (recovered
    // by the IPC server from the responder's socket) so an approve binds
    // the grant to that workspace.
    recordDecision: (request_id, decision, bound_workspace) =>
      consentManager.recordDecision(request_id, decision, bound_workspace),
  });

  components = {
    ipcServer,
    mcpServer,
    tunnelManager,
    auditLog,
    dailyTimer,
    pendingApprovals,
    extensionRouter,
    consentManager,
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

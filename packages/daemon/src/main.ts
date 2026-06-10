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
import { join } from "node:path";
import type { Config, StatusPayload } from "@claude-bridge/shared";
import { loadConfig, ConfigNotFoundError } from "./config/load.js";
import { initConfig } from "./config/init.js";
import {
  getConfigDir,
  getConfigPath,
  getPidPath,
  getTunnelPidPath,
} from "./config/paths.js";
import { reclaimOrphanTunnel } from "./tunnel/reclaim.js";
import { DropRecovery } from "./tunnel/drop-recovery.js";
import { randomUUID } from "node:crypto";
import { generateToken } from "./config/token.js";
import { createLogger, type Logger } from "./log/logger.js";
import { AuditLog } from "./audit/log.js";
import { makeInteractionLog, InteractionRecorder } from "./audit/interaction.js";
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
import { TokenStore } from "./oauth/token-store.js";
import { ConsentManager } from "./oauth/consent.js";
import { makeOAuthRouter } from "./oauth/router.js";
import {
  getWorkspacesStorePath,
  getClientsStorePath,
  getTokensStorePath,
} from "./config/paths.js";
import { makeInitialState } from "./state.js";
import {
  computeDaemonResources,
  isIpcAddressLive,
  ExplicitPortInUseError,
  type DaemonResources,
} from "./workspace/resources.js";
import {
  advertPath as getAdvertPath,
  writeAdvert,
  removeAdvert,
  sweepAdverts,
  isAdvertLive,
} from "./workspace/advert.js";
import type { DaemonAdvert } from "@claude-bridge/shared";
import { WorkspaceRegistryImpl } from "./workspace/registry.js";
import { JobQueue } from "./jobs/index.js";
import { DailyTimer } from "./util/daily-timer.js";
import { scanTranscriptOrphans } from "./jobs/transcript-orphan.js";
import { PendingApprovalRegistry } from "./approval/pending.js";
import { ApprovalGateImpl } from "./approval/gate.js";
import { connect as netConnect } from "node:net";
import {
  writePidFile,
  writePidValue,
  checkStalePid,
  readPidFromFile,
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
  interactionRecorder: InteractionRecorder;
  logger: Logger;
  pidPath: string;
  // P3′-2a: this daemon's own advert file, removed on graceful exit. null in
  // legacy/no-`--workspace` mode (no advert written).
  advertPath: string | null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown";
}

// P3′-1a: read a `--flag <value>` pair from argv. The CLI `start` command
// forwards the operator's (already-validated) --workspace/--name through to
// the spawned daemon; returns undefined when the flag is absent (e.g. a
// direct/acceptance-harness invocation), in which case the daemon skips the
// identity line and keeps its prior behavior untouched.
function getDaemonArgValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return undefined;
  return process.argv[i + 1];
}

// P3′-1b: parse the optional `--port <n>` override. Absent → undefined
// (auto-allocate). Present-but-not-a-valid-port → throw a clear startup error
// (main()'s catch maps it to a non-zero exit).
function parsePortArg(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`--port must be an integer 1-65535, got '${raw}'`);
  }
  return n;
}

// CB-DAEMON-LIFECYCLE-FIX (a): authoritative single-instance probe. The TCP
// bind port is the only reliable cross-platform single-bind lock — the win32
// named pipe permits multiple listeners (so the pipe can't guard), and
// pid-file liveness is presence-only (pid reuse and win32 EPERM both
// misreport "alive"). A successful CONNECT to the bind address means a daemon
// already owns the port → the caller refuses and leaves the incumbent
// untouched. ECONNREFUSED/timeout ⟹ the port is free ⟹ no live daemon.
export function isDaemonPortListening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port });
    let settled = false;
    const done = (listening: boolean): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

export async function shutdown(
  reason: string,
  components: DaemonComponents,
): Promise<void> {
  const startMs = Date.now();
  const log = components.logger;
  log.info("shutdown starting", { reason });

  // P3′-2a/3-fix: remove our own advert FIRST — before any slow layer teardown
  // (tunnel/cloudflared can run long) and before the watchdog can hard-exit.
  // The advert is the "I'm here" beacon; clearing it is the earliest, cheapest
  // shutdown action so discovery stops seeing a corpse the instant we begin to
  // exit. (Was last, after every layer + the pid file — routinely skipped when
  // the drain raced the budget, leaving a stale advert.)
  if (components.advertPath !== null) {
    try {
      await removeAdvert(components.advertPath);
    } catch {
      // Best-effort — a stale advert is swept by the next daemon boot anyway.
    }
  }

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
    { name: "interaction-log", stop: () => components.interactionRecorder.stop() },
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
  // (advert removal moved to the FIRST shutdown action — see top of shutdown())

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

  // 0.5. P3′-1b: per-daemon resource resolution. When `claude-bridge start`
  // forwards --workspace/--name, derive a per-daemon config-dir + IPC pipe +
  // (below) port from the canonical identity, so two daemons for two workspaces
  // never collide on disk, IPC channel, or port. Without --workspace (the
  // acceptance harness / a direct `node main.js`), fall back to the flat legacy
  // layout — unchanged. No auto-migration of old flat state (clean cutover).
  const workspaceArg = getDaemonArgValue("--workspace");
  const nameArg = getDaemonArgValue("--name");
  const portArg = parsePortArg(getDaemonArgValue("--port"));

  let resources: DaemonResources | null = null;
  let configDir: string;
  let ipcAddressOverride: string | undefined;
  if (workspaceArg !== undefined && nameArg !== undefined) {
    resources = computeDaemonResources(workspaceArg, nameArg, getConfigDir());
    configDir = resources.configDir;
    ipcAddressOverride = resources.ipcAddress;
  } else {
    configDir = getConfigDir();
    ipcAddressOverride = undefined; // legacy: server's addressFor() chooses
  }
  const configPath = getConfigPath(configDir);
  const pidPath = getPidPath(configDir);

  // 1. Load or init config (under the resolved per-daemon / legacy config-dir).
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

  // 1.5. P3′-1b (scope c): `config.workspace` reading RETIRED. `--workspace`
  // is the single source of truth for the daemon's workspace; the old
  // config.workspace validation no longer runs at startup (no dual source).
  // The schema field remains accepted-but-ignored for back-compat;
  // validateWorkspaceConfig is now unreferenced by the startup path.

  // 2. Logger.
  const logger = createLogger(config.log.path, config.log.level);
  logger.info("daemon starting", {
    version: pkg.version,
    config_path: configPath,
  });

  // 2.3. P3′-1c (ITEM 1): identity-keyed single-instance lock, acquired EARLY —
  // before any port / MCP work — so a refused same-workspace start has ZERO
  // side effects (incumbent's files + process untouched). A LIVE same-identity
  // incumbent is, by definition, listening on this daemon's per-daemon IPC
  // pipe/socket; connect-probe it. LIVENESS (not bare pid-file presence)
  // decides refuse-vs-reclaim: a crashed incumbent's pipe is OS-released, so
  // the probe fails and the new start reclaims (AC-1c-2). On a LIVE incumbent,
  // refuse and leave it untouched (AC-1c-1, the refuse-incumbent decision).
  // Legacy/no-`--workspace` mode keeps the port-based guard (step 3 below).
  if (resources !== null && (await isIpcAddressLive(resources.ipcAddress))) {
    const existingPid = await readPidFromFile(pidPath);
    const pidPart = existingPid !== null ? ` (pid ${existingPid})` : "";
    process.stderr.write(
      `Daemon for this workspace is already running${pidPart} ` +
        `(identity ${resources.identity}); it remains active. ` +
        `Use \`claude-bridge stop\` first if you intend to replace it.\n`,
    );
    logger.warn("refusing start: live same-identity incumbent", {
      identity: resources.identity,
      ipc: resources.ipcAddress,
      existing_pid: existingPid,
    });
    await logger.close();
    process.exit(1);
  }

  // 2.5. P3′-1c (ITEM 2): port. Explicit --port → pre-check; if taken,
  // ExplicitPortInUseError (no retry past the operator's choice; AC-1c-5).
  // Auto (per-daemon, no --port) → the BIND retries (McpServer autoAllocate)
  // so this is just the scan origin and the concurrent-start TOCTOU is closed
  // at bind time (AC-1c-4). Legacy → the configured port, single bind.
  let autoAllocate = false;
  if (portArg !== undefined) {
    if (await isDaemonPortListening(config.daemon.bind_host, portArg)) {
      throw new ExplicitPortInUseError(portArg);
    }
    config.daemon.bind_port = portArg;
  } else if (resources !== null) {
    autoAllocate = true; // start port stays config.daemon.bind_port (scan origin)
  }
  // The actually-bound port is written back after mcpServer.start() (it may
  // differ from the scan origin when autoAllocate retried).

  // 3. Legacy single-instance guard (per-daemon mode uses the identity lock at
  //    2.3 instead). Unchanged behavior for the acceptance harness / direct
  //    invocation without --workspace.
  if (resources === null) {
    if (
      await isDaemonPortListening(config.daemon.bind_host, config.daemon.bind_port)
    ) {
      const existingPid = await readPidFromFile(pidPath);
      const pidPart = existingPid !== null ? ` (pid ${existingPid})` : "";
      process.stderr.write(
        `Daemon already running${pidPart}; it remains active. ` +
          `Use \`claude-bridge stop\` first if you intend to replace it.\n`,
      );
      await logger.close();
      process.exit(1);
    }
  }
  // Stale pid diagnostics + (over)write — both modes. A pid file present here
  // is from a crashed/reclaimed incumbent (the live one was refused above).
  const pidState = await checkStalePid(pidPath);
  if (pidState === "alive") {
    logger.warn(
      "pid file reports a live pid but no live daemon owns this identity/port; treating as stale (pid reuse or unclean exit)",
      { path: pidPath },
    );
  } else if (pidState === "stale") {
    logger.warn("stale PID file detected; overwriting", { path: pidPath });
  }
  await writePidFile(pidPath);

  // 4. Audit log.
  const auditLog = new AuditLog(config.audit.path, config.audit.retention_days);

  // 4.5. Transcripts directory + one-shot orphan scan (P1). The scan is
  // best-effort: failures are logged but do not abort daemon startup.
  // `configDir` is the per-daemon (or legacy flat) dir resolved at step 0.5.
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
  const workspacesStore = new WorkspacesStore(
    getWorkspacesStorePath(configDir),
    logger,
  );
  await workspacesStore.load();
  // T-P3-001: OAuth DCR clients store. Mirrors WorkspacesStore shape;
  // loaded once at startup so the DCR endpoint sees pre-existing entries.
  const clientsStore = new ClientsStore(getClientsStorePath(configDir), logger);
  await clientsStore.load();
  logger.info("oauth clients store initialized", {
    client_count: clientsStore.list().length,
  });
  // T-P3-004a: durable access-token store (the binding's persistent home).
  // Loaded once at startup; sweeps expired tokens on load.
  const tokenStore = new TokenStore(
    getTokensStorePath(configDir),
    Date.now,
    logger,
  );
  await tokenStore.load();
  logger.info("oauth token store initialized", {
    token_count: tokenStore.size(),
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
      if (server === null) return { delivered: 0, totalActive: 0 };
      // T-P3-004b: broadcast the consent request only to UNBOUND windows
      // (a window already bound to a client can't accept a fresh binding).
      const result = server.broadcastServerMessageToUnbound(msg, (id) =>
        tokenStore.hasActiveBindingFor(id),
      );
      // P3′-4 (always-takeover): if it reached an unbound window, or there are
      // no windows at all, we're done (fresh bind, or offline). Otherwise every
      // active window is already bound — instead of refusing
      // (no_unbound_workspace, the pre-P3′-4 behavior), deliver a TAKEOVER
      // consent to the bound window(s): the same consent plus that window's own
      // OLD-binding disclosure so the modal can ask the user to replace it.
      if (result.delivered > 0 || result.totalActive === 0) return result;
      const takeoverDelivered = server.broadcastTakeoverToBound(
        (id) => tokenStore.hasActiveBindingFor(id),
        (identifier) => {
          const old = tokenStore.takeoverDisclosureFor(identifier);
          if (old === null) return null;
          // The token record holds only client_id; resolve the old client's
          // display name from the clients store ("" is fine — the modal's
          // formatClientLabel falls back to the client_id prefix).
          const client_name =
            clientsStore.findByClientId(old.client_id)?.client_name ?? "";
          return {
            ...msg,
            takeover: {
              client_id: old.client_id,
              client_name,
              issued_at: old.issued_at,
              expires_at: old.expires_at,
            },
          };
        },
      );
      return { delivered: takeoverDelivered, totalActive: result.totalActive };
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
    // T-P3-003: binding-established, TARGETED to the bound workspace's
    // connection (the winning window) so its status bar surfaces the
    // binding. sendServerMessage rejects if no active connection for that
    // identifier; best-effort, so swallow.
    (identifier, msg) => {
      const server = ipcServerRef.current;
      if (server === null) return;
      void server.sendServerMessage(identifier, msg).catch(() => {
        // best-effort — the window may have disconnected between approve
        // and this send; the status-bar refresh is non-critical.
      });
    },
  );
  logger.info("oauth consent manager initialized");

  // CB-SMOKE-READINESS-BATCH: the single 004b unbind/revoke capability —
  // tear down a workspace's durable token(s) AND any un-redeemed auth code
  // bound to it. Shared by the extension's unbind_workspace (setBindingRevoker
  // below) and the operator's `claude-bridge unbind` (the unbindBinding
  // handler) so both paths revoke identically — no reimplementation.
  const revokeBindingForWorkspace = async (
    identifier: string,
  ): Promise<number> => {
    const codes = consentManager.revokeAuthCodesByWorkspace(identifier);
    const tokens = await tokenStore.revokeByWorkspace(identifier);
    logger.info("oauth binding revoked (unbind)", {
      identifier,
      tokens_revoked: tokens,
      auth_codes_revoked: codes,
    });
    return tokens;
  };

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

  // 5.75. T-P3-007: interaction log — the daemon-authoritative, Clyde-
  // untamperable accountability spine (~/.claude-bridge/interaction.jsonl,
  // reusing AuditLog; in the 006-self-protected dir). Wired into the runner
  // (terminal + floor/push events) and the delegate handler (dispatch + gate).
  const interactionLog = makeInteractionLog(
    configDir,
    config.audit.retention_days,
  );
  const interactionRecorder = new InteractionRecorder(interactionLog);

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
      interactionRecorder,
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
    // T-P3-007: accountability log — the delegate handler emits
    // gate_decision + delegation_dispatched (binding/granularity live here).
    interactionRecorder,
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

  // 7. MCP server. P3′-1c: autoAllocate makes the BIND the port allocation
  // (retry-on-EADDRINUSE from bind_port) in per-daemon mode without an explicit
  // --port — closing the concurrent-start race. The bound port is read back
  // below.
  const mcpServer = new McpServer({
    bindHost: config.daemon.bind_host,
    bindPort: config.daemon.bind_port,
    autoAllocate,
    logger,
    getExpectedToken,
    auditLog,
    state,
    registry,
    // T-P3-001: OAuth bootstrap router mounted ahead of Bearer auth.
    // Handles `/.well-known/oauth-authorization-server`, `/register`,
    // `/authorize`, `/authorize/status`, and (T-P3-004a) `/token`
    // unauthenticated; other paths fall through to MCP.
    oauthHandler: makeOAuthRouter({
      logger,
      clientsStore,
      consentManager,
      tokenStore,
      // CB-DAEMON-LIFECYCLE-FIX (c2): let /authorize's offline page tell
      // "connected but unregistered" from "no extension here".
      countConnectedExtensions: () =>
        ipcServerRef.current?.countConnectedExtensions() ?? 0,
    }),
    // T-P3-004a: resolve OAuth access tokens to their binding at the auth
    // layer, so a bound token is enforced to its workspace.
    lookupOAuthToken: (token) => {
      const b = tokenStore.lookup(token);
      // T-P3-005: carry the token's default granularity so the gate can
      // read the binding-default (resolution: operation → default → per_call).
      return b === null
        ? null
        : { bound_workspace: b.bound_workspace, granularity: b.granularity };
    },
  });
  await mcpServer.start();

  // 7.1. P3′-1c: write back the actually-bound port (autoAllocate may have
  // retried past taken ports) so the tunnel URL, status payload, and the
  // identity log all reflect reality.
  const boundPort = mcpServer.getBoundPort();
  if (boundPort !== null) config.daemon.bind_port = boundPort;

  // 7.2. Identity → hash → physical-resources mapping (P3′-1a identity + 1b
  // config-dir/pipe + the 1c actually-bound port). Currency-positive line
  // (007 lesson) and the debug key for the opaque <hash> dir.
  if (resources !== null) {
    logger.info("daemon identity", {
      identity: resources.identity,
      name: resources.name,
      workspace_path: resources.display_path,
      hash: resources.hash,
      config_dir: resources.configDir,
      bind_port: config.daemon.bind_port,
      ipc: resources.ipcAddress,
    });
  }

  // 8. Tunnel.
  // T-TUNNEL-1 (AC-T-3, PRIMARY): before launching our own cloudflared, reclaim
  // any orphan a prior NON-graceful exit left behind (hard-kill bypasses
  // shutdown() on win32, so clean-on-exit never ran). Read tunnel.pid; if that
  // process is still alive, kill it. Best-effort; never blocks startup.
  const tunnelPidPath = getTunnelPidPath(configDir);
  await reclaimOrphanTunnel(tunnelPidPath, logger);
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
  // T-TUNNEL-1: persist the owned cloudflared pid on every (re)spawn, clear on
  // graceful stop — so a future daemon can reclaim it (above) if we die hard.
  tunnelManager.on("pid_change", (pid) => {
    void (pid === null
      ? removePidFile(tunnelPidPath)
      : writePidValue(tunnelPidPath, pid)
    ).catch((err: unknown) => {
      logger.warn("failed to persist tunnel pid", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
  // T-TUNNEL-1 (B): operator-gated drop recovery. A drop-respawn emits
  // url_pending (NOT url_change) — held out of state.tunnelUrl until the operator
  // confirms via the modal (never silent-adopt a rotated url).
  const dropRecovery = new DropRecovery({
    adopt: (url) => {
      state.tunnelUrl = url; // confirm → the new url becomes live
      logger.info("tunnel url changed", { url, via: "drop-adopt" });
    },
    teardown: async () => {
      await tunnelManager.stop(); // deny → tear the respawn down, sit tunnel-less
      state.tunnelUrl = null;
    },
    sendRequest: (req) => {
      const server = ipcServerRef.current;
      if (server === null) return false;
      // Reuse the consent daemon-initiated-modal channel: broadcast to all
      // connected extensions. delivered>0 ⇒ surfaced; 0 ⇒ stays pending, fires
      // on next connect.
      return (
        server.broadcastServerMessage({
          kind: "tunnel_drop_request",
          request_id: req.request_id,
          new_url: req.new_url,
        }) > 0
      );
    },
    genRequestId: () => randomUUID(),
    logger,
  });
  tunnelManager.on("url_pending", (url) => {
    dropRecovery.onDropRespawn(url);
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
      // CB-DAEMON-LIFECYCLE-FIX: surface the active registered extension
      // sessions (the diagnostic lens for the doubled-daemon split). Read
      // through ipcServerRef (assigned before any handler can fire).
      const activeRegistry =
        ipcServerRef.current?.getActiveRegistry() ??
        new Map<string, { identifier: string; pid: number }>();
      const connected_extensions = [...activeRegistry.entries()].map(
        ([abs_path, entry]) => ({
          identifier: entry.identifier,
          pid: entry.pid,
          abs_path,
        }),
      );
      const payload: StatusPayload = {
        daemon_pid: process.pid,
        daemon_uptime_s: Math.floor((Date.now() - state.startedAt) / 1000),
        endpoint: `${config.daemon.bind_host}:${config.daemon.bind_port}`,
        tunnel_status: state.tunnelStatus,
        tunnel_url: state.tunnelUrl,
        // T-TUNNEL-1 (B): a dropped tunnel's respawned url awaiting confirm —
        // surfaced so an operator with no extension connected still learns of it.
        pending_tunnel_url: dropRecovery.pendingUrl(),
        token_suffix: currentToken.slice(-4),
        audit_path: config.audit.path,
        audit_size_bytes: auditSizeBytes,
        attached_workspaces: connected_extensions.length,
        connected_extensions,
        // CB-SMOKE-READINESS-BATCH: surface the active OAuth bindings (from
        // tokens.json) so a real bind is VISIBLE in `status`. Distinct from the
        // daemon Bearer token (token_suffix above).
        oauth_bindings: tokenStore.listBindings(),
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
    // CB-SMOKE-READINESS-BATCH: `claude-bridge unbind`. Resolve {target, all}
    // against the durable token store, then tear down the matching binding(s)
    // via the SAME 004b revoke capability the extension uses. Reports each
    // binding cleared (empty = no match → CLI prints "no such binding").
    unbindBinding: async ({ target, all }) => {
      const bindings = tokenStore.listBindings();
      // The natural key is the bound_workspace identifier (the binding's
      // durable home + what status shows); we ALSO accept an exact client_id
      // or a client_id PREFIX (status truncates the id), for operator
      // convenience. `--all` ignores the target and clears everything.
      const matches = all
        ? bindings
        : bindings.filter(
            (b) =>
              b.bound_workspace === target ||
              b.client_id === target ||
              (target !== null &&
                target.length >= 8 &&
                b.client_id.startsWith(target)),
          );

      // Group by bound_workspace so we revoke each workspace once (a workspace
      // may have >1 live token). Null-bound (non-binding) tokens can't be
      // revoked by workspace; they're swept by the --all revokeAll() below.
      const byWorkspace = new Map<string, string>(); // ws → a client_id (for the report)
      for (const b of matches) {
        if (b.bound_workspace !== null && !byWorkspace.has(b.bound_workspace)) {
          byWorkspace.set(b.bound_workspace, b.client_id);
        }
      }

      const unbound: Array<{
        client_id: string;
        bound_workspace: string | null;
        tokens_revoked: number;
      }> = [];
      for (const [ws, client_id] of byWorkspace) {
        const tokens_revoked = await revokeBindingForWorkspace(ws);
        // Tell the (now-unbound) window so it clears its status-bar binding.
        // Best-effort targeted send — the window may be closed.
        ipcServerRef.current
          ?.sendServerMessage(ws, { kind: "binding_cleared", bound_workspace: ws })
          .catch(() => undefined);
        unbound.push({ client_id, bound_workspace: ws, tokens_revoked });
      }

      // --all also sweeps any leftover non-binding (null-bound) tokens so
      // tokens.json ends fully empty (the smoke's invariant).
      if (all) {
        const swept = await tokenStore.revokeAll();
        if (swept > 0 && byWorkspace.size === 0) {
          unbound.push({
            client_id: "(non-binding tokens)",
            bound_workspace: null,
            tokens_revoked: swept,
          });
        }
      }
      return { unbound };
    },
  };

  // workspacesStore + load() moved earlier (just before the workspace
  // registry construction at T-P2-007) so the registry can read from a
  // populated store at startup. IpcServer's existing workspacesStore
  // reference is unchanged.

  // P3′-1b: in per-daemon mode pass the hash-derived IPC address as the
  // addressOverride so the server listens on the per-daemon pipe/socket (the
  // win32 server's addressFor() would otherwise force the shared legacy pipe).
  // In legacy mode ipcAddressOverride is undefined → unchanged behavior.
  const ipcServer = new IpcServer(
    config.daemon.ipc_socket,
    handlers,
    logger,
    ipcAddressOverride,
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
  // T-P3-004b: wire the binding revoker so unbind_workspace tears down the
  // durable token AND any un-redeemed auth code bound to that workspace.
  ipcServer.setBindingRevoker({ revoke: revokeBindingForWorkspace });
  // P3′-5: wire the binding-default granularity setter ("Set approval mode").
  ipcServer.setGranularitySetter({
    set: (identifier, value) =>
      tokenStore.setGranularityForWorkspace(identifier, value),
  });
  // T-TUNNEL-1 (B): wire the drop-recovery decision receiver + the connect hook
  // (re-fire a pending drop modal when an extension connects).
  ipcServer.setTunnelDropReceiver({
    onDecision: (request_id, decision) => {
      void dropRecovery.onDecision(request_id, decision);
    },
  });
  ipcServer.setOnExtensionConnect(() => {
    dropRecovery.fireIfPending();
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
    interactionRecorder,
    logger,
    pidPath,
    // P3′-2a: own advert path (per-daemon mode only), removed on graceful exit.
    advertPath:
      resources !== null
        ? getAdvertPath(getConfigDir(), resources.hash)
        : null,
  };

  await ipcServer.start();

  // 9.5. P3′-2a: advert lifecycle. The IPC pipe is now live, so the advert's
  // `pipe` is a real rendezvous. WRITE (overwrite = reclaim-own, AC-2a-3) our
  // advert to the shared `daemons/` dir, then SWEEP every OTHER daemon's advert
  // confirmed dead by failed retry-gated handshake (AC-2a-4). Both best-effort:
  // an advert failure must not abort an otherwise-healthy daemon. Per-daemon
  // mode only (legacy/no-`--workspace` writes no advert).
  if (resources !== null) {
    const advert: DaemonAdvert = {
      canonical_workspace: resources.identity,
      name: resources.name,
      pipe: resources.ipcAddress,
      port: config.daemon.bind_port,
      pid: process.pid,
      started_at: new Date().toISOString(),
    };
    try {
      const written = await writeAdvert(getConfigDir(), resources.hash, advert);
      logger.info("advert written", { path: written });
    } catch (err) {
      logger.warn("advert write failed", { error: errorMessage(err) });
    }
    try {
      const swept = await sweepAdverts(
        getConfigDir(),
        (pipe) => isAdvertLive(pipe),
        { selfHash: resources.hash, logger },
      );
      logger.info("advert sweep complete", {
        swept: swept.swept.length,
        kept: swept.kept.length,
      });
    } catch (err) {
      logger.warn("advert sweep failed", { error: errorMessage(err) });
    }
  }

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

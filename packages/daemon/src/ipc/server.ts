// Local IPC server for CLI ↔ daemon traffic. Cross-platform:
// Unix domain socket at `config.daemon.ipc_socket`, Windows named pipe at
// `\\.\pipe\claude-bridge`. Newline-delimited JSON per `protocol.ts`.
//
// Q005 closure: stale-socket cleanup on Unix uses connect-first probe before
// unlink; collision on either platform surfaces as IpcSocketBusyError.
//
// CC-2 (cross-platform paths/IPC), CC-3 (mode 0o600 on Unix), CC-6 (schema
// validation at the dispatch boundary via IpcRequestSchema.safeParse).

import { createServer, connect, type Server, type Socket } from "node:net";
import { unlink, chmod, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  IpcRequestSchema,
  type IpcRequest,
  type IpcResponse,
  type IpcServerMessage,
  type StatusPayload,
  type OperationGranularity,
} from "@claude-bridge/shared";
import {
  encodeMessage,
  decodeMessage,
  IpcProtocolError,
  NEWLINE,
} from "./protocol.js";
import type { Logger } from "../log/logger.js";
import type { WorkspacesStore } from "../workspace/store.js";
import { generateIdentifier } from "../workspace/identifier.js";
import type { ApprovalGate } from "../approval/gate.js";
import type { ExtensionToolRouter } from "../mcp/tools/extension-router.js";

const WINDOWS_PIPE_PATH = "\\\\.\\pipe\\claude-bridge";

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === code
  );
}

// Single source of truth for the platform-specific address transform.
// Tests bypass via the IpcServer constructor's `addressOverride` arg.
function addressFor(socketPath: string): string {
  if (process.platform === "win32") {
    return WINDOWS_PIPE_PATH;
  }
  return socketPath;
}

export interface IpcHandlers {
  status(): Promise<StatusPayload>;
  stop(): Promise<void>;
  // T-BEARER-1: tokenRotate removed — no static Bearer to rotate.
  tunnelRestart(): Promise<{ new_url: string }>;
  // CB-SMOKE-READINESS-BATCH: CLI-initiated unbind (`claude-bridge unbind`).
  // Optional so existing handler constructions (tests) keep compiling; when
  // absent the dispatch returns an error. Production wiring (main.ts) resolves
  // the target against the token store and revokes via the 004b capability.
  unbindBinding?(args: {
    target: string | null;
    all: boolean;
  }): Promise<{
    unbound: Array<{
      client_id: string;
      bound_workspace: string | null;
      tokens_revoked: number;
    }>;
  }>;
}

// IPC protocol-version constants (distinct from package version).
// Bump independently from package version when the wire protocol changes.
// Synthetic mismatch test passes alternate values directly to checkVersion;
// production callers use these.
export const IPC_DAEMON_VERSION = "1.0";
export const IPC_MIN_SUPPORTED = "1.0";

export interface ConnectionState {
  role: "cli" | "extension";
  version: string;
  pid: number;
  hello_at: number;
}

// Pure function: returns null on accept, structured error payload on reject.
// P2 implementation is string equality; replace with semver comparison in
// P3+ if the wire-version vocabulary grows.
export function checkVersion(
  client_version: string,
  daemon_version: string,
  min_supported: string,
): { reason: string; message: string } | null {
  if (client_version === daemon_version) return null;
  return {
    reason: "version_mismatch",
    message:
      `version mismatch: client ${client_version}, daemon ${daemon_version}, min supported ${min_supported}`,
  };
}

export class IpcSocketBusyError extends Error {
  constructor(public readonly path: string) {
    super(`IPC socket busy at ${path}`);
    this.name = "IpcSocketBusyError";
  }
}

// Per-socket entry in the active workspace registry. Populated on
// successful register_workspace; cleared on deregister_workspace or
// socket close. Keyed in the Map by abs_path; pid is the extension's
// VS Code process id (sent in the hello message via ConnectionState).
// T-P2-007: exported so the workspace registry can type-import it for
// a read-only-Map accessor (registry doesn't mutate; just reads
// connection state across the activeRegistry boundary).
export interface ActiveRegistration {
  socket: Socket;
  identifier: string;
  pid: number;
}

export class IpcServer {
  private readonly address: string;
  private readonly handlers: IpcHandlers;
  private readonly logger: Logger;
  private readonly workspacesStore: WorkspacesStore | null;
  // T-P2-008: optional approval gate. Wired in main.ts. When absent
  // (legacy daemon-construction without gate), set_workspace_mode and
  // approval_response requests respond with a protocol_error.
  private approvalGate: ApprovalGate | null = null;
  // T-P3-002: optional consent receiver. When absent, auth_consent_*
  // messages are silently dropped (the daemon-authoritative state
  // machine treats this the same as a late arrival).
  private consentReceiver: {
    recordAck: (request_id: string) => void;
    recordDecision: (
      request_id: string,
      decision: "approve" | "deny" | "dismiss",
      // T-P3-002R: the responding connection's workspace identifier
      // (responder-binds), or null if the responder had no resolvable
      // workspace.
      bound_workspace: string | null,
    ) => void;
  } | null = null;
  // T-TUNNEL-1 (B): optional drop-recovery receiver (the operator's confirm/deny
  // on a tunnel_drop_request) + a connect hook (re-fire a pending drop modal
  // when an extension connects). Wired by main.ts.
  private tunnelDropReceiver: {
    onDecision: (request_id: string, decision: "confirm" | "deny") => void;
  } | null = null;
  private onExtensionConnect: (() => void) | null = null;
  // T-P3-004b: optional binding revoker. Wired by main.ts to tear down a
  // workspace's OAuth token(s) + transient auth codes on unbind. When
  // absent, unbind_workspace responds with revoked_count 0.
  private bindingRevoker:
    | { revoke: (identifier: string) => Promise<number> }
    | null = null;
  // P3′-5: optional binding-default granularity setter (the "Set approval mode"
  // switch). Wired in main.ts to TokenStore.setGranularityForWorkspace. When
  // absent, set_granularity responds with updated 0.
  private granularitySetter:
    | { set: (identifier: string, value: OperationGranularity) => Promise<number> }
    | null = null;
  // T-P2-009 / T-P2-010: optional extension-tool router. Wired in
  // main.ts. When absent, inbound inspection-tool response/error
  // envelopes are silently dropped (the daemon has nothing pending to
  // resolve). The router is also notified on disconnect so any
  // in-flight inspection request rejects immediately.
  private extensionRouter: ExtensionToolRouter | null = null;
  private server: Server | null = null;
  private closed = false;
  // Per-connection state populated after a successful hello exchange.
  // Until a socket has an entry here, the dispatch path accepts only
  // `kind: "hello"` and rejects everything else with reason "protocol_error".
  private readonly connectionState = new Map<Socket, ConnectionState>();
  // Active workspace registry — abs_path → holder. Populated on
  // register_workspace; cleared on deregister or socket close.
  private readonly activeRegistry = new Map<string, ActiveRegistration>();

  // T-P2-007: read-only view onto activeRegistry for the workspace
  // registry. ReadonlyMap typecast keeps the registry honest — it can
  // observe connection state but can't mutate IPC server state.
  public getActiveRegistry(): ReadonlyMap<string, ActiveRegistration> {
    return this.activeRegistry;
  }

  // CB-DAEMON-LIFECYCLE-FIX (c2): count of extension connections that have
  // completed the hello handshake (whether or not they registered a trusted
  // workspace). Lets the /authorize offline page distinguish "no extension is
  // talking to THIS daemon at all" (count 0) from "an extension IS connected
  // here but has no trusted/registered workspace" (count > 0 while
  // activeRegistry is empty — i.e. no folder open, or Trust not completed).
  public countConnectedExtensions(): number {
    let n = 0;
    for (const state of this.connectionState.values()) {
      if (state.role === "extension") n += 1;
    }
    return n;
  }

  // T-P2-008: post-construction approval-gate wire-up. Called by main.ts
  // after the gate is constructed (the gate needs the IpcServer in turn
  // to send approval_request messages, so order is: ipcServer → gate →
  // ipcServer.setApprovalGate(gate)).
  public setApprovalGate(gate: ApprovalGate): void {
    this.approvalGate = gate;
  }

  // T-P3-002: consent receiver. Wired by main.ts after the
  // ConsentManager is constructed. Routes auth_consent_ack +
  // auth_consent_response inbound from extensions to the manager;
  // late arrivals are silently discarded by the manager per the
  // daemon-authoritative race-resolution invariant.
  public setConsentReceiver(receiver: {
    recordAck: (request_id: string) => void;
    recordDecision: (
      request_id: string,
      decision: "approve" | "deny" | "dismiss",
      bound_workspace: string | null,
    ) => void;
  }): void {
    this.consentReceiver = receiver;
  }

  // T-TUNNEL-1 (B): wire the drop-recovery decision receiver (handles
  // tunnel_drop_response) and the extension-connect hook (re-fires a pending
  // drop modal). Both optional; absent in pre-tunnel-feature/test daemons.
  public setTunnelDropReceiver(receiver: {
    onDecision: (request_id: string, decision: "confirm" | "deny") => void;
  }): void {
    this.tunnelDropReceiver = receiver;
  }

  public setOnExtensionConnect(cb: () => void): void {
    this.onExtensionConnect = cb;
  }

  // T-P3-004b: wire the binding revoker (token/auth-code teardown for a
  // workspace). Called by the unbind_workspace handler.
  public setBindingRevoker(revoker: {
    revoke: (identifier: string) => Promise<number>;
  }): void {
    this.bindingRevoker = revoker;
  }

  // P3′-5: wire the binding-default granularity setter. Called by the
  // set_granularity handler.
  public setGranularitySetter(setter: {
    set: (identifier: string, value: OperationGranularity) => Promise<number>;
  }): void {
    this.granularitySetter = setter;
  }

  // T-P2-009 / T-P2-010: post-construction extension-router wire-up.
  // The router needs IpcServer.sendServerMessage as its send adapter
  // (wired by main.ts inside the router's constructor), so the router
  // is constructed after IpcServer but installed back here so the
  // socket-level dispatch can resolve inbound responses.
  public setExtensionRouter(router: ExtensionToolRouter): void {
    this.extensionRouter = router;
  }

  // T-P2-008: send a daemon-initiated message to the connection
  // associated with `identifier`. Throws if no active connection exists
  // for that workspace. Used by ApprovalGate to deliver approval_request.
  public sendServerMessage(
    identifier: string,
    message: IpcServerMessage,
  ): Promise<void> {
    const entry = this.findActiveByIdentifier(identifier);
    if (entry === null) {
      return Promise.reject(
        new Error(`no active extension connection for workspace ${identifier}`),
      );
    }
    return new Promise((resolve, reject) => {
      entry.entry.socket.write(encodeMessage(message), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // T-P3-002: broadcast a daemon-initiated message to ALL active
  // extension connections (across all registered workspaces). Returns
  // the number of recipients written to. Used by the OAuth consent flow
  // — the consent request is per-(client_id), not per-workspace, so any
  // online extension can surface the modal.
  //
  // Best-effort: a write error on one socket does not prevent writes to
  // the others. The returned count reflects sockets the daemon
  // ATTEMPTED to write to (the OS write buffer succeeded); delivery to
  // userspace is the OS's job.
  public broadcastServerMessage(message: IpcServerMessage): number {
    let count = 0;
    const encoded = encodeMessage(message);
    for (const entry of this.activeRegistry.values()) {
      try {
        entry.socket.write(encoded);
        count += 1;
      } catch (err) {
        this.logger.warn("ipc broadcast: socket write failed", {
          identifier: entry.identifier,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return count;
  }

  // T-P3-004b: broadcast only to UNBOUND windows (the consent-request
  // filter). `isBound(identifier)` is read live against the token store.
  // Returns `delivered` (unbound recipients written to) and `totalActive`
  // (all active connections) so the caller can distinguish "no windows
  // online" from "all windows already bound".
  public broadcastServerMessageToUnbound(
    message: IpcServerMessage,
    isBound: (identifier: string) => boolean,
  ): { delivered: number; totalActive: number } {
    let delivered = 0;
    let totalActive = 0;
    const encoded = encodeMessage(message);
    for (const entry of this.activeRegistry.values()) {
      totalActive += 1;
      if (isBound(entry.identifier)) continue;
      try {
        entry.socket.write(encoded);
        delivered += 1;
      } catch (err) {
        this.logger.warn("ipc broadcast(unbound): socket write failed", {
          identifier: entry.identifier,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { delivered, totalActive };
  }

  // P3′-4 (takeover delivery): the inversion of the unbound filter. Deliver to
  // BOUND windows — for each active window whose workspace is already bound,
  // build a PER-WINDOW message via makeMessage(identifier) (the consent plus
  // that window's own old-binding disclosure) and write it. A null from
  // makeMessage skips that window. Under daemon-per-workspace this is the one
  // paired window; the per-window build is what lets each carry its own
  // takeover record. Returns the count written to.
  public broadcastTakeoverToBound(
    isBound: (identifier: string) => boolean,
    makeMessage: (identifier: string) => IpcServerMessage | null,
  ): number {
    let delivered = 0;
    for (const entry of this.activeRegistry.values()) {
      if (!isBound(entry.identifier)) continue;
      const message = makeMessage(entry.identifier);
      if (message === null) continue;
      try {
        entry.socket.write(encodeMessage(message));
        delivered += 1;
      } catch (err) {
        this.logger.warn("ipc takeover: socket write failed", {
          identifier: entry.identifier,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return delivered;
  }

  constructor(
    socketPath: string,
    handlers: IpcHandlers,
    logger: Logger,
    addressOverride?: string,
    workspacesStore?: WorkspacesStore,
  ) {
    this.address = addressOverride ?? addressFor(socketPath);
    this.handlers = handlers;
    this.logger = logger;
    this.workspacesStore = workspacesStore ?? null;
  }

  async start(): Promise<void> {
    if (process.platform !== "win32") {
      await this.cleanupStaleSocket();
    }

    const server = createServer((socket) => {
      this.handleConnection(socket);
    });

    server.on("error", (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn("ipc server error", { error: msg });
    });

    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      const onError = (err: unknown): void => {
        server.off("listening", onListening);
        if (isErrnoCode(err, "EADDRINUSE")) {
          reject(new IpcSocketBusyError(this.address));
        } else {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      server.once("listening", onListening);
      server.once("error", onError);
      server.listen(this.address);
    });

    if (process.platform !== "win32") {
      // chmod after listen succeeds so the socket file is owner-only.
      try {
        await chmod(this.address, 0o600);
      } catch {
        // Best-effort — if chmod fails the socket is still functional.
      }
    }

    this.server = server;
  }

  private async cleanupStaleSocket(): Promise<void> {
    let exists = true;
    try {
      await stat(this.address);
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) {
        exists = false;
      } else {
        throw err;
      }
    }
    if (!exists) return;

    const probe = await this.probeConnect();
    if (probe === "alive") {
      throw new IpcSocketBusyError(this.address);
    }
    if (probe === "stale") {
      try {
        await unlink(this.address);
      } catch (err) {
        if (!isErrnoCode(err, "ENOENT")) throw err;
      }
      this.logger.info("ipc: cleaned up stale socket", { path: this.address });
      return;
    }
    // probe === "uncertain" — refuse to clobber.
    throw new IpcSocketBusyError(this.address);
  }

  private probeConnect(): Promise<"alive" | "stale" | "uncertain"> {
    return new Promise((resolve) => {
      const client = connect(this.address);
      const cleanup = (): void => {
        client.removeAllListeners();
        client.destroy();
      };
      client.once("connect", () => {
        cleanup();
        resolve("alive");
      });
      client.once("error", (err: unknown) => {
        cleanup();
        if (
          isErrnoCode(err, "ECONNREFUSED") ||
          isErrnoCode(err, "ENOENT")
        ) {
          resolve("stale");
        } else {
          resolve("uncertain");
        }
      });
    });
  }

  private handleConnection(socket: Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIdx = buffer.indexOf(NEWLINE);
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        void this.dispatchLine(socket, line);
        newlineIdx = buffer.indexOf(NEWLINE);
      }
    });

    socket.on("error", (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn("ipc socket error", { error: msg });
      this.connectionState.delete(socket);
      this.removeActiveRegistrationsForSocket(socket);
      socket.destroy();
    });

    socket.on("close", () => {
      this.connectionState.delete(socket);
      this.removeActiveRegistrationsForSocket(socket);
    });

    socket.on("end", () => {
      socket.end();
    });
  }

  private async dispatchLine(socket: Socket, line: string): Promise<void> {
    let request: IpcRequest;
    try {
      const parsed = decodeMessage(line);
      const result = IpcRequestSchema.safeParse(parsed);
      if (!result.success) {
        await this.writeResponse(socket, {
          kind: "error",
          message: "protocol: unknown request kind",
        });
        return;
      }
      request = result.data;
    } catch (err) {
      if (err instanceof IpcProtocolError) {
        await this.writeResponse(socket, {
          kind: "error",
          message: `protocol: ${err.reason}`,
        });
        return;
      }
      // Anything else is unexpected — surface and close the socket via the
      // error handler.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn("ipc dispatch error", { error: msg });
      return;
    }

    // Hello gate: until a socket has ConnectionState, only `hello` is
    // accepted. Anything else returns error with reason "protocol_error"
    // and closes the socket (T-P2-002).
    const state = this.connectionState.get(socket);
    if (state === undefined) {
      if (request.kind !== "hello") {
        await this.writeResponse(socket, {
          kind: "error",
          message: "expected hello as first message",
          reason: "protocol_error",
        });
        socket.end();
        return;
      }
      const mismatch = checkVersion(
        request.version,
        IPC_DAEMON_VERSION,
        IPC_MIN_SUPPORTED,
      );
      if (mismatch !== null) {
        await this.writeResponse(socket, {
          kind: "error",
          message: mismatch.message,
          reason: mismatch.reason,
        });
        socket.end();
        return;
      }
      this.connectionState.set(socket, {
        role: request.role,
        version: request.version,
        pid: request.pid,
        hello_at: Date.now(),
      });
      // P3′-2b: machine-verified extension currency. The build-id rides the
      // hello; logging it here is the structural "running == built" check that
      // retires the manual reload-eyeball (redeploy-currency item).
      if (request.role === "extension") {
        this.logger.info("extension build connected", {
          build_id: request.build_id ?? "(none — pre-2b extension)",
          pid: request.pid,
        });
        // T-TUNNEL-1 (B): an extension just connected — if a tunnel drop is
        // pending an operator decision, surface it now (the no-extension-at-
        // drop-time fallback fires here). Best-effort; fired after hello_ok.
        this.onExtensionConnect?.();
      }
      await this.writeResponse(socket, {
        kind: "hello_ok",
        daemon_version: IPC_DAEMON_VERSION,
        min_supported: IPC_MIN_SUPPORTED,
        // CB-DAEMON-LIFECYCLE-FIX: the daemon's own pid, so the extension can
        // display which daemon it's bound to (doubled-daemon visibility).
        daemon_pid: process.pid,
      });
      return;
    }

    // State exists — hello already happened. Reject a second hello on the
    // same connection (defensive; shouldn't happen with well-behaved clients).
    if (request.kind === "hello") {
      await this.writeResponse(socket, {
        kind: "error",
        message: "hello already exchanged on this connection",
        reason: "protocol_error",
      });
      return;
    }

    // Workspace requests are handled inline because they need per-socket
    // access (active registry binding); short-circuit before the standard
    // handler switch.
    try {
      const handled = await this.maybeHandleWorkspaceRequest(socket, state, request);
      if (handled) return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.writeResponse(socket, { kind: "error", message }).catch(
        (writeErr: unknown) => {
          const wmsg =
            writeErr instanceof Error ? writeErr.message : String(writeErr);
          this.logger.warn("ipc write error", { error: wmsg });
        },
      );
      return;
    }

    try {
      const response = await this.handleRequest(request);
      await this.writeResponse(socket, response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.writeResponse(socket, { kind: "error", message }).catch(
        (writeErr: unknown) => {
          const wmsg =
            writeErr instanceof Error ? writeErr.message : String(writeErr);
          this.logger.warn("ipc write error", { error: wmsg });
        },
      );
    }
  }

  private async handleRequest(request: IpcRequest): Promise<IpcResponse> {
    switch (request.kind) {
      case "status": {
        const payload = await this.handlers.status();
        return { kind: "status_ok", payload };
      }
      case "stop": {
        await this.handlers.stop();
        return { kind: "stop_ok" };
      }
      // T-BEARER-1: token_rotate removed.
      case "tunnel_restart": {
        const { new_url } = await this.handlers.tunnelRestart();
        return { kind: "tunnel_restart_ok", new_url };
      }
      case "unbind_binding": {
        // CB-SMOKE-READINESS-BATCH: CLI unbind. A top-level (non-socket-scoped)
        // request, unlike the extension's unbind_workspace — the daemon owns
        // the token store, so the operator can tear down a binding from any
        // shell. The no-args footgun is refused CLI-side; here we trust the
        // validated {target, all}.
        if (this.handlers.unbindBinding === undefined) {
          return {
            kind: "error",
            message: "unbind not supported by this daemon",
            reason: "protocol_error",
          };
        }
        const { unbound } = await this.handlers.unbindBinding({
          target: request.target,
          all: request.all,
        });
        return { kind: "unbind_binding_ok", unbound };
      }
      case "hello":
      case "register_workspace":
      case "confirm_trust":
      case "deregister_workspace":
      case "set_workspace_mode":
      case "approval_response":
      case "get_open_editors_response":
      case "get_diagnostics_response":
      case "extension_tool_error":
      case "auth_consent_ack":
      case "auth_consent_response":
      case "unbind_workspace":
      case "set_granularity":
      case "tunnel_drop_response": {
        // These are handled inline in dispatchLine (workspace cases need
        // per-socket access; hello is handled in the gate above). They
        // never reach this switch.
        throw new Error(`unreachable: ${request.kind} in handleRequest`);
      }
    }
  }

  private removeActiveRegistrationsForSocket(socket: Socket): void {
    const stalePaths: string[] = [];
    const staleIdentifiers: string[] = [];
    for (const [path, entry] of this.activeRegistry) {
      if (entry.socket === socket) {
        stalePaths.push(path);
        staleIdentifiers.push(entry.identifier);
      }
    }
    for (const path of stalePaths) {
      this.activeRegistry.delete(path);
    }
    // T-P2-008: cancel any pending approvals for these workspaces and
    // clear session-bypass state. The approval gate's cancelByWorkspace
    // rejects each pending awaitApproval with "extension_reconnected".
    if (this.approvalGate !== null) {
      for (const identifier of staleIdentifiers) {
        this.approvalGate.cancelByWorkspace(identifier, "extension_reconnected");
      }
    }
    // T-P2-009 / T-P2-010: cancel any in-flight inspection requests so
    // the calling MCP tool fails fast with 503 rather than waiting for
    // the 5s timeout. ExtensionToolRouter is identifier-agnostic for now
    // (one workspace per daemon is the common case); a per-identifier
    // hook can land if multi-workspace racing becomes common.
    if (staleIdentifiers.length > 0 && this.extensionRouter !== null) {
      this.extensionRouter.cancelAll("extension disconnected");
    }
  }

  private findActiveByIdentifier(identifier: string): {
    abs_path: string;
    entry: ActiveRegistration;
  } | null {
    for (const [abs_path, entry] of this.activeRegistry) {
      if (entry.identifier === identifier) return { abs_path, entry };
    }
    return null;
  }

  // T-P3-002R: reverse lookup — the workspace identifier registered on a
  // given socket, or null if the socket holds no active registration
  // (e.g. a connected-but-unregistered connection answering a broadcast
  // consent). Same `entry.socket === socket` match used by
  // removeActiveRegistrationsForSocket. Used by the responder-binds path
  // to recover which workspace a consent response came from.
  private findWorkspaceIdentifierBySocket(socket: Socket): string | null {
    for (const entry of this.activeRegistry.values()) {
      if (entry.socket === socket) return entry.identifier;
    }
    return null;
  }

  // Returns true when the response was written and the caller should
  // short-circuit (workspace request handled). Returns false when the
  // request is not a workspace request and normal dispatch should proceed.
  private async maybeHandleWorkspaceRequest(
    socket: Socket,
    state: ConnectionState,
    request: IpcRequest,
  ): Promise<boolean> {
    // T-P2-008: approval_response and set_workspace_mode also flow
    // through this handler. They share the per-socket access pattern
    // (state validation + workspaces-store + active-registry).
    // T-P2-009 / T-P2-010: get_*_response and extension_tool_error
    // envelopes also flow through here — they route to the extension
    // router and write no response back.
    if (
      request.kind !== "register_workspace" &&
      request.kind !== "confirm_trust" &&
      request.kind !== "deregister_workspace" &&
      request.kind !== "set_workspace_mode" &&
      request.kind !== "approval_response" &&
      request.kind !== "get_open_editors_response" &&
      request.kind !== "get_diagnostics_response" &&
      request.kind !== "extension_tool_error" &&
      request.kind !== "auth_consent_ack" &&
      request.kind !== "auth_consent_response" &&
      request.kind !== "unbind_workspace" &&
      request.kind !== "set_granularity" &&
      request.kind !== "tunnel_drop_response"
    ) {
      return false;
    }
    // T-P3-002: consent messages route to the consent manager. No daemon
    // ack — the manager funnels them through its single state-transition
    // primitive; late arrivals are silently discarded there.
    if (request.kind === "auth_consent_ack") {
      this.consentReceiver?.recordAck(request.request_id);
      return true;
    }
    if (request.kind === "auth_consent_response") {
      // T-P3-002R (responder-binds): recover the responding connection's
      // workspace from the active registry (the socket is in scope here)
      // and thread it into recordDecision so an approve binds the grant to
      // that workspace. null when the socket holds no registration — the
      // manager guards that as a non-binding approve.
      const bound_workspace = this.findWorkspaceIdentifierBySocket(socket);
      this.consentReceiver?.recordDecision(
        request.request_id,
        request.decision,
        bound_workspace,
      );
      return true;
    }
    // T-TUNNEL-1 (B): the operator's drop-recovery decision. Asymmetric (no
    // ack); stale/unknown ids discarded by the receiver.
    if (request.kind === "tunnel_drop_response") {
      this.tunnelDropReceiver?.onDecision(request.request_id, request.decision);
      return true;
    }
    // approval_response is processed in a dedicated path below — it
    // routes to the gate and writes no response.
    if (request.kind === "approval_response") {
      if (this.approvalGate !== null) {
        this.approvalGate.resolveApproval(
          request.delegation_id,
          request.decision,
        );
      }
      return true;
    }
    // T-P2-009 / T-P2-010: inspection-tool responses route to the
    // extension router via request_id correlation. No daemon ack — the
    // tool's pending promise resolves with the response payload.
    if (request.kind === "get_open_editors_response") {
      this.extensionRouter?.resolveResponse(request);
      return true;
    }
    if (request.kind === "get_diagnostics_response") {
      this.extensionRouter?.resolveResponse(request);
      return true;
    }
    if (request.kind === "extension_tool_error") {
      this.extensionRouter?.resolveError(request.request_id, request.message);
      return true;
    }
    if (request.kind === "set_workspace_mode") {
      if (this.approvalGate === null) {
        await this.writeResponse(socket, {
          kind: "error",
          message: "approval gate not configured on this daemon",
          reason: "protocol_error",
        });
        return true;
      }
      if (this.workspacesStore === null) {
        await this.writeResponse(socket, {
          kind: "error",
          message: "workspaces store not configured on this daemon",
          reason: "protocol_error",
        });
        return true;
      }
      const entry = this.workspacesStore.findByIdentifier(request.identifier);
      if (entry === null) {
        await this.writeResponse(socket, {
          kind: "error",
          message: `no workspace registered with identifier '${request.identifier}'`,
          reason: "no_workspace_registered",
        });
        return true;
      }
      // Authorization: only the connection that holds this workspace's
      // active registration may change its mode. Prevents one extension
      // from flipping another window's mode.
      const found = this.findActiveByIdentifier(request.identifier);
      if (found === null || found.entry.socket !== socket) {
        await this.writeResponse(socket, {
          kind: "error",
          message: `set_workspace_mode: identifier ${request.identifier} not held by this connection`,
          reason: "protocol_error",
        });
        return true;
      }
      await this.approvalGate.setModeForWorkspace(
        request.identifier,
        request.mode,
      );
      await this.writeResponse(socket, { kind: "set_workspace_mode_ok" });
      return true;
    }

    // T-P3-004b: unbind — tear down this workspace's OAuth binding/token.
    if (request.kind === "unbind_workspace") {
      // Authorization: only the connection that holds this workspace's
      // active registration may unbind it (same guard as set_workspace_mode).
      const found = this.findActiveByIdentifier(request.identifier);
      if (found === null || found.entry.socket !== socket) {
        await this.writeResponse(socket, {
          kind: "error",
          message: `unbind_workspace: identifier ${request.identifier} not held by this connection`,
          reason: "protocol_error",
        });
        return true;
      }
      let revoked = 0;
      if (this.bindingRevoker !== null) {
        revoked = await this.bindingRevoker.revoke(request.identifier);
      }
      // Tell the (now-unbound) window so it clears its status-bar binding.
      // Best-effort targeted send; the ok reply below is the authoritative
      // confirmation the extension awaits.
      this.sendServerMessage(request.identifier, {
        kind: "binding_cleared",
        bound_workspace: request.identifier,
      }).catch(() => {
        // window may have closed between request and this send — non-fatal.
      });
      await this.writeResponse(socket, {
        kind: "unbind_workspace_ok",
        revoked_count: revoked,
      });
      return true;
    }

    // P3′-5: set the binding-default granularity (the "Set approval mode"
    // switch). Same per-socket authorization as unbind — only the connection
    // holding this workspace's registration may set its ceiling.
    if (request.kind === "set_granularity") {
      const found = this.findActiveByIdentifier(request.identifier);
      if (found === null || found.entry.socket !== socket) {
        await this.writeResponse(socket, {
          kind: "error",
          message: `set_granularity: identifier ${request.identifier} not held by this connection`,
          reason: "protocol_error",
        });
        return true;
      }
      if (this.granularitySetter !== null) {
        await this.granularitySetter.set(request.identifier, request.value);
      }
      await this.writeResponse(socket, {
        kind: "set_granularity_ok",
        granularity: request.value,
      });
      return true;
    }

    if (this.workspacesStore === null) {
      await this.writeResponse(socket, {
        kind: "error",
        message: "workspaces store not configured on this daemon",
        reason: "protocol_error",
      });
      return true;
    }
    const store = this.workspacesStore;

    if (request.kind === "register_workspace") {
      const existing = this.activeRegistry.get(request.abs_path);
      if (existing !== undefined && existing.socket !== socket) {
        await this.writeResponse(socket, {
          kind: "error",
          message: `Workspace path already registered by another VS Code window (pid ${existing.pid})`,
          reason: "path_already_registered",
        });
        return true;
      }
      const trusted = store.findByPath(request.abs_path);
      if (trusted !== null) {
        this.activeRegistry.set(request.abs_path, {
          socket,
          identifier: trusted.identifier,
          pid: this.pidFromState(state),
        });
        await this.writeResponse(socket, {
          kind: "register_workspace_ok",
          identifier: trusted.identifier,
          name: trusted.name,
          abs_path: trusted.abs_path,
          trusted_at: trusted.trusted_at,
          was_already_trusted: true,
          mode: trusted.mode ?? "per_call",
        });
        return true;
      }
      await this.writeResponse(socket, {
        kind: "register_workspace_needs_trust",
        abs_path: request.abs_path,
      });
      return true;
    }

    if (request.kind === "confirm_trust") {
      // Re-check active registry (another window may have raced in
      // between needs_trust and confirm_trust on this socket).
      const existing = this.activeRegistry.get(request.abs_path);
      if (existing !== undefined && existing.socket !== socket) {
        await this.writeResponse(socket, {
          kind: "error",
          message: `Workspace path already registered by another VS Code window (pid ${existing.pid})`,
          reason: "path_already_registered",
        });
        return true;
      }
      // Re-check the store (another connection may have written trust).
      const alreadyTrusted = store.findByPath(request.abs_path);
      if (alreadyTrusted !== null) {
        this.activeRegistry.set(request.abs_path, {
          socket,
          identifier: alreadyTrusted.identifier,
          pid: this.pidFromState(state),
        });
        await this.writeResponse(socket, {
          kind: "register_workspace_ok",
          identifier: alreadyTrusted.identifier,
          name: alreadyTrusted.name,
          abs_path: alreadyTrusted.abs_path,
          trusted_at: alreadyTrusted.trusted_at,
          was_already_trusted: true,
          mode: alreadyTrusted.mode ?? "per_call",
        });
        return true;
      }
      // Generate identifier from the on-disk folder name; the request's
      // `name` is the user-facing label stored in the entry.
      const folderName = basename(request.abs_path) || "workspace";
      const identifier = generateIdentifier(folderName, (candidate) => {
        return store.findByIdentifier(candidate) !== null;
      });
      const entry = await store.addTrustedEntry({
        abs_path: request.abs_path,
        identifier,
        name: request.name,
      });
      this.activeRegistry.set(request.abs_path, {
        socket,
        identifier: entry.identifier,
        pid: this.pidFromState(state),
      });
      await this.writeResponse(socket, {
        kind: "register_workspace_ok",
        identifier: entry.identifier,
        name: entry.name,
        abs_path: entry.abs_path,
        trusted_at: entry.trusted_at,
        was_already_trusted: false,
        mode: entry.mode ?? "per_call",
      });
      return true;
    }

    // deregister_workspace
    const found = this.findActiveByIdentifier(request.identifier);
    if (found === null || found.entry.socket !== socket) {
      await this.writeResponse(socket, {
        kind: "error",
        message: `deregister: identifier ${request.identifier} not held by this connection`,
        reason: "protocol_error",
      });
      return true;
    }
    this.activeRegistry.delete(found.abs_path);
    await this.writeResponse(socket, { kind: "deregister_workspace_ok" });
    return true;
  }

  // ConnectionState carries pid from the hello message (T-P2-002 ext +
  // T-P2-003 widening). For extension connections this is the VS Code
  // process pid; for CLI connections it's whichever shell sent the hello.
  // Surfaced in path_already_registered error messages so users can find
  // the holding window in Task Manager.
  private pidFromState(state: ConnectionState): number {
    return state.pid;
  }

  private writeResponse(socket: Socket, response: IpcResponse): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.write(encodeMessage(response), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const server = this.server;
    if (server !== null) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      this.server = null;
    }
    if (process.platform !== "win32") {
      try {
        await unlink(this.address);
      } catch {
        // Best-effort. The socket may already be gone if stop ran after a
        // failed start, or if cleanupStaleSocket already removed it.
      }
    }
  }
}

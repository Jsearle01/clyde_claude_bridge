// T-P2-008 AC-21 integration test: full approval round-trip exercised
// against the daemon's IpcServer + ApprovalGate over an in-memory socket
// pair. A fake extension client performs hello + register_workspace, then
// waits for an approval_request and replies with approval_response.
// Daemon delegate handler completes the enqueue.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { connect, type Socket } from "node:net";
import { IpcServer } from "../../src/ipc/server.js";
import type { IpcHandlers } from "../../src/ipc/server.js";
import { WorkspacesStore } from "../../src/workspace/store.js";
import { PendingApprovalRegistry } from "../../src/approval/pending.js";
import { ApprovalGateImpl } from "../../src/approval/gate.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { StubJobRunner } from "../../src/jobs/runner.js";
import { makeDelegateTool } from "../../src/mcp/tools/delegate.js";
import {
  ToolRegistry,
  type ToolContext,
} from "../../src/mcp/dispatch.js";
import { AuditLog } from "../../src/audit/log.js";
import { WorkspaceRegistryImpl } from "../../src/workspace/registry.js";
import type { Logger } from "../../src/log/logger.js";
import type { DaemonState } from "../../src/state.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};

const stubState: DaemonState = {
  version: "0.1.0",
  startedAt: Date.now(),
  tunnelStatus: "up",
  tunnelUrl: null,
  config: {} as never,
};

// Pick a non-collision socket path / pipe for this test run.
function makeSocketPath(dir: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\cb-approval-test-${process.pid}-${Date.now()}`;
  }
  return join(dir, "test.sock");
}

interface PendingResponse {
  resolve: (msg: unknown) => void;
  reject: (err: Error) => void;
}

interface FakeExtensionClient {
  socket: Socket;
  hello(): Promise<void>;
  send(msg: unknown): void;
  nextMessage(): Promise<unknown>;
  awaitApprovalRequest(): Promise<{
    kind: string;
    delegation_id: string;
    identifier: string;
  }>;
  close(): void;
}

function connectFakeExtension(address: string): Promise<FakeExtensionClient> {
  return new Promise((resolveOuter, rejectOuter) => {
    const socket = connect(address);
    socket.setEncoding("utf8");
    let buffer = "";
    const queue: unknown[] = [];
    const pending: PendingResponse[] = [];
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const parsed: unknown = JSON.parse(line);
        const waiter = pending.shift();
        if (waiter !== undefined) {
          waiter.resolve(parsed);
        } else {
          queue.push(parsed);
        }
        idx = buffer.indexOf("\n");
      }
    });
    socket.on("connect", () => {
      const nextMessage = (): Promise<unknown> => {
        if (queue.length > 0) return Promise.resolve(queue.shift());
        return new Promise<unknown>((res, rej) => {
          pending.push({ resolve: res, reject: rej });
        });
      };
      const client: FakeExtensionClient = {
        socket,
        hello: async () => {
          socket.write(
            JSON.stringify({
              kind: "hello",
              version: "1.0",
              role: "extension",
              pid: 9999,
            }) + "\n",
          );
          const reply = (await nextMessage()) as { kind?: string };
          if (reply.kind !== "hello_ok") {
            throw new Error(`expected hello_ok, got ${JSON.stringify(reply)}`);
          }
        },
        send: (msg) => {
          socket.write(JSON.stringify(msg) + "\n");
        },
        nextMessage,
        awaitApprovalRequest: async () => {
          const m = (await nextMessage()) as {
            kind?: string;
            delegation_id?: string;
            identifier?: string;
          };
          if (
            m.kind !== "approval_request" ||
            m.delegation_id === undefined ||
            m.identifier === undefined
          ) {
            throw new Error(
              `expected approval_request, got ${JSON.stringify(m)}`,
            );
          }
          return {
            kind: m.kind,
            delegation_id: m.delegation_id,
            identifier: m.identifier,
          };
        },
        close: () => {
          socket.removeAllListeners();
          socket.destroy();
        },
      };
      resolveOuter(client);
    });
    socket.on("error", (err) => {
      rejectOuter(err);
    });
  });
}

describe("T-P2-008 AC-21 — full approval round-trip integration", () => {
  let tempDir: string;
  let address: string;
  let server: IpcServer;
  let auditLog: AuditLog;
  let store: WorkspacesStore;
  let pending: PendingApprovalRegistry;
  let gate: ApprovalGateImpl;
  let queue: JobQueue;
  let runner: StubJobRunner;
  let toolRegistry: ToolRegistry;
  let workspaceRegistry: WorkspaceRegistryImpl;
  let ipcRef: { current: IpcServer | null };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cb-int-approval-"));
    address = makeSocketPath(tempDir);
    await mkdir(dirname(address) || tempDir, { recursive: true });
    store = new WorkspacesStore(join(tempDir, "workspaces.json"));
    await store.load();
    await store.addTrustedEntry({
      abs_path: tempDir,
      identifier: "ws-int-aaaaaa",
      name: "Int",
    });
    pending = new PendingApprovalRegistry();
    ipcRef = { current: null };
    gate = new ApprovalGateImpl(store, pending, (id, req) => {
      const s = ipcRef.current;
      if (s === null) return Promise.reject(new Error("ipc server not wired"));
      return s.sendServerMessage(id, req);
    });
    workspaceRegistry = new WorkspaceRegistryImpl(
      store,
      () => ipcRef.current?.getActiveRegistry() ?? new Map(),
    );
    auditLog = new AuditLog(join(tempDir, "audit.jsonl"), 30);
    queue = new JobQueue();
    runner = new StubJobRunner(new JobQueue());
    toolRegistry = new ToolRegistry();
    toolRegistry.register(
      makeDelegateTool({
        registry: workspaceRegistry,
        queue,
        runner,
        approvalGate: gate,
      }),
    );
    const handlers: IpcHandlers = {
      status: () => Promise.reject(new Error("not used in test")),
      stop: () => Promise.resolve(),
      tokenRotate: () => Promise.reject(new Error("not used")),
      tunnelRestart: () => Promise.reject(new Error("not used")),
    };
    server = new IpcServer(address, handlers, silentLogger, address, store);
    server.setApprovalGate(gate);
    ipcRef.current = server;
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await pending.stop();
    await auditLog.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeCtx(): ToolContext {
    return {
      request_id: "req_intg0000",
      remote_addr: "tunnel",
      auditLog,
      logger: silentLogger,
      state: stubState,
    };
  }

  it("full round-trip: delegate → approval_request → approve → enqueue", async () => {
    // 1. Fake extension connects + hellos + registers workspace.
    const ext = await connectFakeExtension(address);
    await ext.hello();
    ext.send({ kind: "register_workspace", abs_path: tempDir, name: "Int" });
    const regReply = (await ext.nextMessage()) as { kind?: string };
    expect(regReply.kind).toBe("register_workspace_ok");

    // 2. Set workspace mode to per_call so the gate prompts.
    await gate.setModeForWorkspace("ws-int-aaaaaa", "per_call");

    // 3. Invoke delegate via the tool registry (simulates MCP-server path).
    const delegatePromise = toolRegistry.invoke(
      "delegate_to_claude_code",
      { prompt: "do the thing", workspace: "ws-int-aaaaaa" },
      makeCtx(),
    ) as Promise<{ job_id: string; status: string }>;

    // 4. Fake extension receives approval_request and replies with approve.
    const approval = await ext.awaitApprovalRequest();
    expect(approval.identifier).toBe("ws-int-aaaaaa");
    ext.send({
      kind: "approval_response",
      delegation_id: approval.delegation_id,
      decision: "approve",
    });

    // 5. Delegate handler completes with enqueue.
    const out = await delegatePromise;
    expect(out.status).toBe("queued");
    expect(out.job_id).toMatch(/^j_/);

    ext.close();
  }, 10_000);

  it("full round-trip: delegate → approval_request → deny → 403", async () => {
    const ext = await connectFakeExtension(address);
    await ext.hello();
    ext.send({ kind: "register_workspace", abs_path: tempDir, name: "Int" });
    await ext.nextMessage();
    await gate.setModeForWorkspace("ws-int-aaaaaa", "per_call");

    const delegatePromise = toolRegistry.invoke(
      "delegate_to_claude_code",
      { prompt: "do the thing", workspace: "ws-int-aaaaaa" },
      makeCtx(),
    );

    const approval = await ext.awaitApprovalRequest();
    ext.send({
      kind: "approval_response",
      delegation_id: approval.delegation_id,
      decision: "deny",
    });

    await expect(delegatePromise).rejects.toMatchObject({
      code: 403,
      reason: "delegation_denied",
    });

    ext.close();
  }, 10_000);

  it("set_workspace_mode IPC round-trip updates the store", async () => {
    const ext = await connectFakeExtension(address);
    await ext.hello();
    ext.send({ kind: "register_workspace", abs_path: tempDir, name: "Int" });
    await ext.nextMessage();

    ext.send({
      kind: "set_workspace_mode",
      identifier: "ws-int-aaaaaa",
      mode: "auto",
    });
    const reply = (await ext.nextMessage()) as { kind?: string };
    expect(reply.kind).toBe("set_workspace_mode_ok");

    expect(gate.getModeForWorkspace("ws-int-aaaaaa")).toBe("auto");
    const persisted = store.findByIdentifier("ws-int-aaaaaa");
    expect(persisted?.mode).toBe("auto");

    ext.close();
  }, 10_000);
});

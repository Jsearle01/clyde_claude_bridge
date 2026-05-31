// T-P2-011: pluggable mock VS Code extension. Drives the daemon's IPC
// the same way the real `packages/extension/src/ipc/client.ts` does:
// connects to the daemon's local IPC (Unix socket or Windows named pipe),
// sends `hello`, registers a workspace, then responds to daemon-initiated
// server messages (`approval_request`, `get_open_editors_request`,
// `get_diagnostics_request`) per the behavior config.
//
// Single-workspace per instance. Multi-workspace harness tests spawn
// multiple mock instances against the same daemon.
//
// IPC framing: newline-delimited JSON. Mirrors
// packages/daemon/src/ipc/protocol.ts.
//
// Windows: daemon hardcodes `\\.\pipe\claude-bridge` regardless of the
// `ipc_socket` config field. Caller passes `socketPath: null` to use the
// platform default, or an explicit path on Unix where it matters.

import { connect as netConnect } from "node:net";
import process from "node:process";

const WINDOWS_PIPE_PATH = "\\\\.\\pipe\\claude-bridge";
const MOCK_VERSION = "1.0";

function defaultSocketPath(explicit) {
  if (explicit !== null && explicit !== undefined) return explicit;
  if (process.platform === "win32") return WINDOWS_PIPE_PATH;
  throw new Error("non-Windows mock requires explicit socketPath");
}

// Pure encode/decode helpers — same shape as daemon's protocol.ts.
function encode(msg) {
  return JSON.stringify(msg) + "\n";
}

// startMockExtension returns once the workspace registration completes
// (or fails). Throws if the daemon refuses to trust a workspace whose
// behavior says `onTrustPrompt: "deny"`. After that, subsequent
// daemon-initiated messages are handled per behavior; the call log is
// queryable via `getReceivedCallLog()`.
//
// behavior:
//   socketPath: string | null
//   workspace: { abs_path: string, name?: string }
//   onTrustPrompt: "trust" | "deny" | "ignore"
//   onApproval: "approve" | "approve_session" | "deny" | "ignore"
//                | (request) => "approve" | "deny" | "approve_session" | "ignore"
//   onAuthConsent: "approve" | "deny" | "ack-only" | "ignore" | function
//                  "approve"  → ack + auth_consent_response{approve}
//                  "deny"     → ack + auth_consent_response{deny}
//                  "ack-only" → ack but never respond (drives decision-timeout)
//                  "ignore"   → no ack, no response (drives ack-timeout)
//                  function   → (request) => one of the above (string)
//   getOpenEditors: () => OpenEditor[]           // optional
//   getDiagnostics: (severities: string[]) => DiagnosticItem[]  // optional
//
// Returns { id, abs_path, stop(), getReceivedCallLog(), setApprovalBehavior(b) }.
// `id` is the daemon-assigned workspace identifier (only valid post-
// register_workspace_ok).
export async function startMockExtension(behavior) {
  const socketPath = defaultSocketPath(behavior.socketPath);
  const sock = netConnect(socketPath);
  sock.setEncoding("utf8");

  // Mutable per-instance state. callLog is the assertion surface.
  const state = {
    callLog: [],
    workspaceId: null,
    helloOk: false,
    pendingRegister: null,
    pendingConfirm: null,
    closed: false,
    approvalBehavior: behavior.onApproval ?? "deny",
  };

  let buffer = "";
  sock.on("data", (chunk) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      void handleLine(line);
      idx = buffer.indexOf("\n");
    }
  });

  sock.on("error", (err) => {
    state.closed = true;
    if (state.pendingRegister !== null) {
      state.pendingRegister.reject(err);
      state.pendingRegister = null;
    }
  });

  sock.on("close", () => {
    state.closed = true;
    if (state.pendingRegister !== null) {
      state.pendingRegister.reject(new Error("socket closed mid-register"));
      state.pendingRegister = null;
    }
  });

  function write(msg) {
    if (state.closed) {
      throw new Error("mock-extension: socket closed");
    }
    sock.write(encode(msg));
  }

  async function handleLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line.trim());
    } catch (err) {
      state.callLog.push({
        kind: "_parse_error",
        line,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    state.callLog.push(parsed);

    switch (parsed.kind) {
      case "hello_ok": {
        state.helloOk = true;
        // Now send register_workspace.
        write({
          kind: "register_workspace",
          abs_path: behavior.workspace.abs_path,
          name: behavior.workspace.name ?? "mock-ws",
        });
        return;
      }
      case "register_workspace_ok": {
        state.workspaceId = parsed.identifier ?? null;
        if (state.pendingRegister !== null) {
          state.pendingRegister.resolve({
            identifier: parsed.identifier,
            was_already_trusted: parsed.was_already_trusted ?? false,
          });
          state.pendingRegister = null;
        }
        return;
      }
      case "register_workspace_needs_trust": {
        // Honor the configured trust behavior.
        if (behavior.onTrustPrompt === "trust") {
          write({
            kind: "confirm_trust",
            abs_path: behavior.workspace.abs_path,
            name: behavior.workspace.name ?? "mock-ws",
          });
          return;
        }
        if (behavior.onTrustPrompt === "deny") {
          // Real extension closes the socket on deny; the daemon never
          // sees confirm_trust. Surface to caller as a deny outcome.
          if (state.pendingRegister !== null) {
            state.pendingRegister.resolve({
              identifier: null,
              trust_denied: true,
            });
            state.pendingRegister = null;
          }
          return;
        }
        // onTrustPrompt === "ignore" — never respond. Caller will time out.
        return;
      }
      case "error": {
        if (state.pendingRegister !== null) {
          state.pendingRegister.reject(
            new Error(
              `register failed: ${parsed.message ?? "unknown"} (reason=${parsed.reason ?? "n/a"})`,
            ),
          );
          state.pendingRegister = null;
        }
        return;
      }
      case "approval_request": {
        const decision = await resolveApprovalDecision(parsed);
        if (decision === "ignore") return;
        write({
          kind: "approval_response",
          delegation_id: parsed.delegation_id,
          decision,
        });
        return;
      }
      case "auth_consent_request": {
        const knob = await resolveAuthConsentDecision(parsed);
        if (knob === "ignore") return;
        // ack first (within the 3s window the daemon enforces). The
        // "approve" / "deny" / "ack-only" all ack; only "ignore"
        // skips the ack.
        write({
          kind: "auth_consent_ack",
          request_id: parsed.request_id,
        });
        if (knob === "ack-only") return;
        write({
          kind: "auth_consent_response",
          request_id: parsed.request_id,
          decision: knob,
        });
        return;
      }
      case "auth_consent_timeout": {
        // Daemon told us the decision timer fired. Best-effort modal-close
        // notification; mock-extension just acknowledges by logging via
        // the call log (no IPC reply expected). T-P3-003's real extension
        // will close its modal here.
        if (state.callLog !== undefined) {
          state.callLog.push({ kind: "auth_consent_timeout", request_id: parsed.request_id });
        }
        return;
      }
      case "get_open_editors_request": {
        const editors =
          behavior.getOpenEditors !== undefined
            ? behavior.getOpenEditors()
            : [];
        write({
          kind: "get_open_editors_response",
          request_id: parsed.request_id,
          editors,
        });
        return;
      }
      case "get_diagnostics_request": {
        const diagnostics =
          behavior.getDiagnostics !== undefined
            ? behavior.getDiagnostics(parsed.severities ?? [])
            : [];
        write({
          kind: "get_diagnostics_response",
          request_id: parsed.request_id,
          diagnostics,
        });
        return;
      }
      case "set_workspace_mode_ok": {
        if (state.pendingSetMode !== null && state.pendingSetMode !== undefined) {
          state.pendingSetMode.resolve();
          state.pendingSetMode = null;
        }
        return;
      }
      default:
        // Unknown kind — already logged. No-op.
        return;
    }
  }

  async function resolveApprovalDecision(request) {
    const behaviorValue = state.approvalBehavior;
    if (typeof behaviorValue === "function") {
      const r = behaviorValue(request);
      return r instanceof Promise ? await r : r;
    }
    return behaviorValue;
  }

  async function resolveAuthConsentDecision(request) {
    const behaviorValue = behavior.onAuthConsent ?? "deny";
    if (typeof behaviorValue === "function") {
      const r = behaviorValue(request);
      return r instanceof Promise ? await r : r;
    }
    return behaviorValue;
  }

  // Send hello immediately. The hello_ok response will trigger register.
  // Register completion is signaled via pendingRegister.
  const registerPromise = new Promise((resolve, reject) => {
    state.pendingRegister = { resolve, reject };
  });

  write({
    kind: "hello",
    version: MOCK_VERSION,
    role: "extension",
    pid: process.pid,
  });

  const registerResult = await registerPromise;
  if (registerResult.trust_denied) {
    // Caller asked for a trust denial; close the socket like the real
    // extension would after the user declines.
    sock.destroy();
    return {
      id: null,
      abs_path: behavior.workspace.abs_path,
      trust_denied: true,
      stop: () => Promise.resolve(),
      getReceivedCallLog: () => state.callLog.slice(),
      setApprovalBehavior: () => undefined,
    };
  }

  return {
    id: registerResult.identifier,
    abs_path: behavior.workspace.abs_path,
    trust_denied: false,
    stop: () => {
      return new Promise((resolve) => {
        if (state.closed) return resolve();
        sock.once("close", () => resolve());
        sock.destroy();
      });
    },
    getReceivedCallLog: () => state.callLog.slice(),
    setApprovalBehavior: (b) => {
      state.approvalBehavior = b;
    },
    // Send a set_workspace_mode IPC request and await the ack.
    setMode: (mode) => {
      return new Promise((resolve, reject) => {
        state.pendingSetMode = { resolve, reject };
        try {
          write({
            kind: "set_workspace_mode",
            identifier: state.workspaceId,
            mode,
          });
        } catch (err) {
          reject(err);
        }
      });
    },
  };
}

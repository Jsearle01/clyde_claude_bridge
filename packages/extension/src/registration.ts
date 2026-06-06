// Workspace registration flow invoked from extension activate. Talks to
// the daemon via IpcClient.request(); shows the trust modal when the
// daemon returns needs_trust; sends confirm_trust on user approval.
//
// State machine (T-P2-008.8 / C-29 fix — registration intent persists):
//   unregistered   -> registering     (calling register; also initial activate)
//   registering    -> registering     (transient connection or daemon failure;
//                                       state stays, retry on next connect)
//   registering    -> registered      (daemon returned ok)
//   registering    -> needs_trust     (daemon returned needs_trust)
//   registering    -> duplicate       (daemon returned path_already_registered)
//   needs_trust    -> registered      (user clicked Trust, ok returned)
//   needs_trust    -> trust_denied    (user clicked Don't trust or dismissed)
//   registered     -> unregistered    (explicit deregister)
//
// IpcClient retries connecting forever (no max retries). When a connection
// arrives while state === "registering", onConnectionStateChanged fires
// a fresh register attempt. The retry counter is exposed via getRetryCount
// for status-bar UX surfacing.

import type * as vscode from "vscode";
import type { WorkspaceMode } from "@claude-bridge/shared";
import type { ConnectionStateKind, IpcClient } from "./ipc/client.js";
import { showTrustPrompt } from "./trust-prompt.js";
import { diag } from "./diag.js";

export type RegistrationState =
  | "unregistered"
  | "registering"
  | "registered"
  | "needs_trust"
  | "trust_denied"
  | "duplicate";

export type RegistrationResult =
  | { state: "registered"; identifier: string; was_already_trusted: boolean }
  | { state: "duplicate"; existing_pid: number }
  | { state: "no_workspace" }
  | { state: "trust_denied" }
  | { state: "error"; message: string };

interface IpcResponseShape {
  kind?: string;
  identifier?: string;
  abs_path?: string;
  trusted_at?: string;
  was_already_trusted?: boolean;
  // T-P2-008: optional mode from register_workspace_ok response.
  mode?: WorkspaceMode;
  message?: string;
  reason?: string;
}

export class WorkspaceRegistration {
  private state: RegistrationState = "unregistered";
  private identifier: string | null = null;
  private existingPid: number | null = null;
  // T-P2-008: per-workspace approval mode. Read from register_workspace_ok
  // response (daemon defaults missing to "per_call"). Updated via
  // setCurrentMode after a successful set_workspace_mode IPC round-trip.
  // Separate field from RegistrationState — mode changes don't transition
  // the registration lifecycle, just the approval policy.
  private currentMode: WorkspaceMode = "per_call";
  // T-P2-008.8 (C-29 fix): retry counter for UX surfacing. Mirrors
  // IpcClient.onReconnectAttempt's value while registration is still
  // "registering". Reset to 0 on successful register or successful connect.
  // Status bar reads this via getRetryCount().
  private retryCount = 0;
  // T-P2-008.8: in-flight register attempt promise. When a register
  // request is awaiting daemon response, this guards against a second
  // concurrent attempt from a racing onConnectionStateChanged("connected")
  // event. Cleared in `.finally`.
  private inFlight: Promise<RegistrationResult> | null = null;
  // Inject the trust-prompt for testability. Production callers omit;
  // tests pass a deterministic fake.
  private readonly trustPromptImpl: (abs_path: string) => Promise<"trust" | "deny">;
  // T-P2-006: fires on each RegistrationState transition. Subscriber
  // receives the new state. Idempotent assigns are no-ops; errors
  // swallowed. Parallel to IpcClient.onStateChange (third instance of
  // the "settable single-subscriber callback field" pattern).
  public onStateChange?: (state: RegistrationState) => void;
  // T-P2-008.8: fires on each retry-count change. Status bar reads
  // retryCount on refresh; this callback prompts refresh. Single-subscriber
  // pattern (5th instance), errors swallowed.
  public onRetryCountChange?: (count: number) => void;

  constructor(
    private readonly ipcClient: IpcClient,
    private readonly workspaceFolder: vscode.WorkspaceFolder | undefined,
    trustPromptImpl?: (abs_path: string) => Promise<"trust" | "deny">,
  ) {
    this.trustPromptImpl = trustPromptImpl ?? showTrustPrompt;
  }

  getState(): RegistrationState {
    return this.state;
  }

  getIdentifier(): string | null {
    return this.identifier;
  }

  getExistingPid(): number | null {
    return this.existingPid;
  }

  // T-P2-008: per-workspace approval mode read accessor + writer. Reader
  // is consumed by the status-bar menu's "Change approval mode" item.
  // Writer is called from the menu's dispatch path after a successful
  // set_workspace_mode IPC round-trip.
  getCurrentMode(): WorkspaceMode {
    return this.currentMode;
  }

  setCurrentMode(mode: WorkspaceMode): void {
    this.currentMode = mode;
  }

  // T-P2-008.8: retry counter read accessor — consumed by the status bar.
  getRetryCount(): number {
    return this.retryCount;
  }

  // C-29 fix (T-P2-008.8): registration is the extension's only job; never
  // give up on transient connection failures. State only leaves
  // "registering" on success (→ "registered"), an explicit trust outcome
  // (→ "needs_trust" → "trust_denied" or → "registered"), a duplicate
  // detection (→ "duplicate"), or explicit deregister (→ "unregistered").
  // A transient `register_workspace` failure — request throw, daemon-side
  // error, or daemon-not-yet-connected — keeps state at "registering"; the
  // next onConnectionStateChanged("connected") event re-fires the attempt.
  //
  // register() kicks off the attempt and returns a promise that resolves
  // when the *current* attempt reaches an outcome (terminal or transient
  // failure). Callers awaiting register() see the first attempt's result;
  // the long-running re-attempt loop continues via onConnectionStateChanged.
  register(): Promise<RegistrationResult> {
    if (this.workspaceFolder === undefined) {
      this.setState("unregistered");
      return Promise.resolve({ state: "no_workspace" });
    }
    this.setState("registering");
    return this.attemptRegisterIfConnected();
  }

  // T-P2-008.8: connection-state subscriber. Wired by extension.ts to
  // IpcClient.onStateChange. When connection arrives AND we're still
  // trying to register (state === "registering"), fire a fresh register
  // attempt. Idempotent if an attempt is already in flight.
  onConnectionStateChanged(s: ConnectionStateKind): void {
    // CB-DAEMON-LIFECYCLE-FIX (c1): the daemon's activeRegistry is per-socket
    // and is dropped when our connection closes. If the connection drops while
    // we believe we're "registered", the daemon we reconnect to (a restarted
    // or — under the doubled-daemon bug — a DIFFERENT daemon) has no
    // registration for us, so consent fails extension_offline while our status
    // bar still shows "registered". Re-arm: on disconnect, return
    // "registered" → "registering" so the next "connected" transition
    // re-sends register_workspace and re-populates the daemon's registry —
    // automatically, with no manual window reload. User-decision states
    // (needs_trust / trust_denied / duplicate) are left untouched.
    if (s !== "connected") {
      if (this.state === "registered") {
        diag("registration: connection dropped while registered — re-arming", {
          identifier: this.identifier,
        });
        this.setState("registering");
      }
      return;
    }
    if (this.state !== "registering") return;
    // Connection just established — reset the retry counter so the UX
    // doesn't show "(retry N)" while the request is in flight.
    this.setRetryCount(0);
    diag("registration: re-attempt on connect", { retryCount: this.retryCount });
    void this.attemptRegisterIfConnected();
  }

  // T-P2-008.8: reconnect-attempt subscriber. Wired by extension.ts to
  // IpcClient.onReconnectAttempt. Only the counter is updated — the
  // re-attempt logic fires on the eventual "connected" transition.
  onReconnectAttempt(attempt: number): void {
    if (this.state !== "registering") return;
    this.setRetryCount(attempt);
  }

  private setRetryCount(n: number): void {
    if (this.retryCount === n) return;
    this.retryCount = n;
    if (this.onRetryCountChange !== undefined) {
      try {
        this.onRetryCountChange(n);
      } catch {
        // intentional swallow — subscriber failures must not break state machine
      }
    }
  }

  private attemptRegisterIfConnected(): Promise<RegistrationResult> {
    if (this.inFlight !== null) return this.inFlight;
    if (this.ipcClient.getConnectionState() !== "connected") {
      // Not connected yet. Stay in "registering"; the next
      // onConnectionStateChanged("connected") will fire a fresh attempt.
      return Promise.resolve({
        state: "error",
        message: `daemon not connected (state=${this.ipcClient.getConnectionState()})`,
      });
    }
    const attempt = this.doRegister();
    this.inFlight = attempt;
    void attempt.finally(() => {
      this.inFlight = null;
    });
    return attempt;
  }

  private async doRegister(): Promise<RegistrationResult> {
    if (this.workspaceFolder === undefined) {
      return { state: "no_workspace" };
    }
    const abs_path = this.workspaceFolder.uri.fsPath;
    const name = this.workspaceFolder.name;
    let response: IpcResponseShape;
    try {
      response = await this.ipcClient.request<IpcResponseShape>({
        kind: "register_workspace",
        abs_path,
        name,
      });
    } catch (err) {
      diag("registration: error", {
        error: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      // C-29 fix: stay in "registering". On the next connection-state
      // transition to "connected", the listener re-fires this method.
      return {
        state: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    return this.handleRegisterResponse(response, abs_path, name);
  }

  private async handleRegisterResponse(
    response: IpcResponseShape,
    abs_path: string,
    name: string,
  ): Promise<RegistrationResult> {
    if (response.kind === "register_workspace_ok") {
      // T-P2-006.5: identifier must be set before setState("registered")
      // because onStateChange subscribers (e.g. status bar) read it
      // synchronously when the callback fires. T-P2-008: same invariant
      // applies to currentMode (status-bar menu reads it).
      this.identifier = response.identifier ?? null;
      this.currentMode = response.mode ?? "per_call";
      this.setState("registered");
      return {
        state: "registered",
        identifier: response.identifier ?? "",
        was_already_trusted: response.was_already_trusted ?? false,
      };
    }
    if (response.kind === "register_workspace_needs_trust") {
      this.setState("needs_trust");
      const choice = await this.trustPromptImpl(abs_path);
      if (choice === "deny") {
        this.setState("trust_denied");
        return { state: "trust_denied" };
      }
      let confirmResponse: IpcResponseShape;
      try {
        confirmResponse = await this.ipcClient.request<IpcResponseShape>({
          kind: "confirm_trust",
          abs_path,
          name,
        });
      } catch (err) {
        diag("registration: error", {
          error: String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        // C-29 fix (T-P2-008.8): confirm_trust IPC failed transiently;
        // fall back to "registering" so the next connect retries the full
        // register flow. (UX caveat: the user will see the trust modal
        // again on retry. Acceptable for correctness; rarely reached.)
        this.setState("registering");
        return {
          state: "error",
          message: err instanceof Error ? err.message : String(err),
        };
      }
      if (confirmResponse.kind === "register_workspace_ok") {
        // T-P2-006.5: identifier must be set before setState("registered")
        // (see invariant comment at the first ok-branch above). T-P2-008:
        // same for currentMode.
        this.identifier = confirmResponse.identifier ?? null;
        this.currentMode = confirmResponse.mode ?? "per_call";
        this.setState("registered");
        return {
          state: "registered",
          identifier: confirmResponse.identifier ?? "",
          was_already_trusted: confirmResponse.was_already_trusted ?? false,
        };
      }
      // Confirm_trust returned an error (e.g., path_already_registered
      // surfaced via race with another window).
      return this.classifyErrorResponse(confirmResponse);
    }
    if (response.kind === "error") {
      return this.classifyErrorResponse(response);
    }
    // C-29 fix (T-P2-008.8): unexpected response kind is a transient
    // failure (likely a wire-version or schema drift); stay in
    // "registering" so the next connect retries.
    return {
      state: "error",
      message: `unexpected register response kind=${response.kind ?? "?"}`,
    };
  }

  private classifyErrorResponse(
    response: IpcResponseShape,
  ): RegistrationResult {
    if (response.reason === "path_already_registered") {
      const match = /pid (\d+)/.exec(response.message ?? "");
      const pid = match?.[1] !== undefined ? Number(match[1]) : 0;
      // T-P2-006.5: existingPid must be set before setState("duplicate")
      // because the duplicate-state render path (status bar tooltip)
      // reads it synchronously via the onStateChange callback.
      this.existingPid = pid;
      this.setState("duplicate");
      return { state: "duplicate", existing_pid: pid };
    }
    // C-29 fix (T-P2-008.8): daemon returned an unrecognized error
    // (not path_already_registered). Stay in "registering" so the next
    // connect retries — daemon-side transient inconsistency is the most
    // likely cause.
    return {
      state: "error",
      message: response.message ?? "unknown register error",
    };
  }

  async deregister(): Promise<void> {
    if (this.state !== "registered" || this.identifier === null) return;
    const id = this.identifier;
    this.identifier = null;
    this.setState("unregistered");
    if (this.ipcClient.getConnectionState() !== "connected") return;
    try {
      await this.ipcClient.request<IpcResponseShape>({
        kind: "deregister_workspace",
        identifier: id,
      });
    } catch {
      // Best-effort; nothing to do if the daemon has disappeared.
    }
  }

  // T-P2-006: single source of state mutation. Idempotent assigns are
  // no-ops; transitions fire onStateChange. Subscriber errors swallowed.
  private setState(next: RegistrationState): void {
    if (this.state === next) return;
    const prev = this.state;
    diag(`registration: state -> ${next}`, {
      from: prev,
      identifier: this.identifier,
      existingPid: this.existingPid,
    });
    this.state = next;
    if (this.onStateChange !== undefined) {
      try {
        this.onStateChange(next);
      } catch {
        // intentional swallow — subscriber failures must not break state machine
      }
    }
  }
}

// Workspace registration flow invoked from extension activate. Talks to
// the daemon via IpcClient.request(); shows the trust modal when the
// daemon returns needs_trust; sends confirm_trust on user approval.
//
// State machine:
//   unregistered   -> registering (calling register)
//   registering    -> registered          (daemon returned ok)
//   registering    -> needs_trust         (daemon returned needs_trust)
//   needs_trust    -> registered          (user clicked Trust, ok returned)
//   needs_trust    -> trust_denied        (user clicked Don't trust or dismissed)
//   registering    -> duplicate           (daemon returned path_already_registered)
//   registering    -> unregistered        (other error; surfaced to caller)

import type * as vscode from "vscode";
import type { IpcClient } from "./ipc/client.js";
import { showTrustPrompt } from "./trust-prompt.js";

const CONNECT_WAIT_TIMEOUT_MS = 5_000;

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
  message?: string;
  reason?: string;
}

export class WorkspaceRegistration {
  private state: RegistrationState = "unregistered";
  private identifier: string | null = null;
  private existingPid: number | null = null;
  // Inject the trust-prompt for testability. Production callers omit;
  // tests pass a deterministic fake.
  private readonly trustPromptImpl: (abs_path: string) => Promise<"trust" | "deny">;
  // T-P2-006: fires on each RegistrationState transition. Subscriber
  // receives the new state. Idempotent assigns are no-ops; errors
  // swallowed. Parallel to IpcClient.onStateChange (third instance of
  // the "settable single-subscriber callback field" pattern).
  public onStateChange?: (state: RegistrationState) => void;

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

  async register(): Promise<RegistrationResult> {
    if (this.workspaceFolder === undefined) {
      this.setState("unregistered");
      return { state: "no_workspace" };
    }
    this.setState("registering");
    await this.waitForConnected();
    if (this.ipcClient.getConnectionState() !== "connected") {
      this.setState("unregistered");
      return {
        state: "error",
        message: `daemon not connected (state=${this.ipcClient.getConnectionState()})`,
      };
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
      this.setState("unregistered");
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
      // synchronously when the callback fires.
      this.identifier = response.identifier ?? null;
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
        this.setState("unregistered");
        return {
          state: "error",
          message: err instanceof Error ? err.message : String(err),
        };
      }
      if (confirmResponse.kind === "register_workspace_ok") {
        // T-P2-006.5: identifier must be set before setState("registered")
        // (see invariant comment at the first ok-branch above).
        this.identifier = confirmResponse.identifier ?? null;
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
    this.setState("unregistered");
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
    this.setState("unregistered");
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

  private async waitForConnected(): Promise<void> {
    const deadline = Date.now() + CONNECT_WAIT_TIMEOUT_MS;
    while (
      Date.now() < deadline &&
      this.ipcClient.getConnectionState() !== "connected"
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }

  // T-P2-006: single source of state mutation. Idempotent assigns are
  // no-ops; transitions fire onStateChange. Subscriber errors swallowed.
  private setState(next: RegistrationState): void {
    if (this.state === next) return;
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

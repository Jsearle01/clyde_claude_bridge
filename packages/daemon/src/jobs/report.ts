// DelegationReport assembler. Consumes:
//   - Job + JobRunState (current job state from JobQueue)
//   - Before/after WorkspaceSnapshots (Phase 7)
//   - Transcript file path + writer-side truncation flag (Phase 6)
//   - ErrorDetail + duration_ms (from the runner)
//
// Produces a fully-populated DelegationReport matching the shared schema.
//
// TRANSCRIPT SHAPE — confirmed against @anthropic-ai/claude-agent-sdk
// 0.3.x at T-P1-009. The reader handles both shapes the SDK emits:
//
//   SDKAssistantMessage:
//     { type: "assistant", message: { content: ContentBlock[] | string }, ... }
//
//   SDKUserMessage:
//     { type: "user", message: { content: ContentBlock[] | string, role: "user" }, ... }
//
//   Metadata markers (writer-internal):
//     { type: "_truncated", ... }
//
//   Other SDK message types (SDKResultMessage, SDKSystemMessage,
//   SDKPartialAssistantMessage, etc.) pass through but are not
//   structurally walked — they tolerate as "unknown shape, skip for
//   summary/shell extraction" via the fail-soft path.
//
// Legacy flat shape (no `.message` nesting, content at top level) is
// ALSO tolerated for backward compatibility with hand-built fixtures
// and for any future SDK variant that emits the simpler form.
//
// ContentBlock variants the walker recognizes:
//   { type: "text", text: string }
//   { type: "tool_use", id: string, name: string, input: object }
//   { type: "tool_result", tool_use_id: string,
//     content: string | ContentBlock[], is_error?: boolean }
//   { type: "<unknown>", ... }                     // tolerated
//
// Diagnostics fields stay empty in P1 per design doc (Phase 2 extension).

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type {
  DelegationReport,
  ErrorDetail,
  ShellCommand,
} from "@claude-bridge/shared";
import { computeDiff } from "./diff.js";
import type { WorkspaceSnapshot } from "./snapshot.js";
import { transcriptUri } from "./transcript.js";
import type { Job, JobRunState } from "./types.js";

const SUMMARY_CAP = 2000;
const COMMAND_CAP = 512;
const EXIT_CODE_REGEX = /exit\s*code\s*[:=]\s*(-?\d+)/i;

// ---- internal message shape (post-parse) ----

interface TranscriptMessage {
  type: string;
  // SDK shape: assistant/user messages nest content under .message.content
  // (BetaMessage / MessageParam shape from Anthropic Messages API).
  message?: { content?: string | ContentBlock[]; [k: string]: unknown };
  // Legacy/fallback shape: content at top level. Used by hand-built
  // fixtures and any SDK variant that emits the simpler form.
  content?: string | ContentBlock[];
  [k: string]: unknown;
}

/** Returns the effective content for a transcript message, preferring
 * the SDK's nested `.message.content` shape when present, else falling
 * back to the legacy top-level `.content`. */
function effectiveContent(
  m: TranscriptMessage,
): string | ContentBlock[] | undefined {
  if (m.message !== undefined && m.message.content !== undefined) {
    return m.message.content;
  }
  return m.content;
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
  [k: string]: unknown;
}

export interface TranscriptDigest {
  summary: string;
  shell_commands: ShellCommand[];
  tool_calls_made: number;
  turns: number;
  parse_errors: number;
  transcript_truncation_reason: string | null;
}

function emptyDigest(): TranscriptDigest {
  return {
    summary: "",
    shell_commands: [],
    tool_calls_made: 0,
    turns: 0,
    parse_errors: 0,
    transcript_truncation_reason: null,
  };
}

function isTranscriptMessage(v: unknown): v is TranscriptMessage {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { type?: unknown }).type === "string"
  );
}

function asArray(content: string | ContentBlock[] | undefined): ContentBlock[] {
  if (content === undefined) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}

function extractExitCodeFromText(text: string): number | null {
  const m = EXIT_CODE_REGEX.exec(text);
  if (m === null) return null;
  const raw = m[1];
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

function extractExitCodeFromResult(result: ContentBlock): number | null {
  // tool_result.content may be string or array-of-blocks.
  const blocks = asArray(result.content);
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") {
      const code = extractExitCodeFromText(b.text);
      if (code !== null) return code;
    }
  }
  if (typeof result.content === "string") {
    return extractExitCodeFromText(result.content);
  }
  return null;
}

function extractCommand(input: Record<string, unknown> | undefined): string {
  if (input === undefined) return "";
  const cmd = (input as { command?: unknown }).command;
  if (typeof cmd === "string") return cmd.slice(0, COMMAND_CAP);
  // Fallback: serialize the whole input, truncate.
  return JSON.stringify(input).slice(0, COMMAND_CAP);
}

function findToolResult(
  messages: TranscriptMessage[],
  tool_use_id: string,
): ContentBlock | null {
  for (const m of messages) {
    for (const b of asArray(effectiveContent(m))) {
      if (b.type === "tool_result" && b.tool_use_id === tool_use_id) {
        return b;
      }
    }
  }
  return null;
}

function isAssistantClosingMessage(m: TranscriptMessage): boolean {
  if (m.type !== "assistant") return false;
  const content = effectiveContent(m);
  const blocks = asArray(content);
  if (blocks.length === 0 && typeof content === "string") return true;
  // Skip if any block is a tool_use — this is a tool-call turn, not a closer.
  const hasToolUse = blocks.some((b) => b.type === "tool_use");
  if (hasToolUse) return false;
  // Must have at least one text block (or content-as-string).
  return blocks.some((b) => b.type === "text" && typeof b.text === "string");
}

function buildSummaryFromMessage(m: TranscriptMessage): string {
  const content = effectiveContent(m);
  if (typeof content === "string") return content;
  const texts: string[] = [];
  for (const b of asArray(content)) {
    if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
  }
  return texts.join("\n");
}

function capSummary(s: string): string {
  if (s.length <= SUMMARY_CAP) return s;
  return s.slice(0, SUMMARY_CAP) + " ... <truncated>";
}

// ---- parseTranscript ----

export async function parseTranscript(
  transcript_path: string,
): Promise<TranscriptDigest> {
  if (!existsSync(transcript_path)) return emptyDigest();

  const messages: TranscriptMessage[] = [];
  let parse_errors = 0;
  let transcript_truncation_reason: string | null = null;

  const rl = createInterface({
    input: createReadStream(transcript_path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parse_errors++;
      continue;
    }
    if (!isTranscriptMessage(parsed)) {
      parse_errors++;
      continue;
    }
    // Metadata markers (underscore-prefixed type)
    if (parsed.type.startsWith("_")) {
      if (parsed.type === "_truncated") {
        transcript_truncation_reason = "transcript_size";
      }
      continue;
    }
    messages.push(parsed);
  }

  // Forward walk: turns + tool_calls + shell_commands.
  let turns = 0;
  let tool_calls_made = 0;
  const shell_commands: ShellCommand[] = [];

  for (const m of messages) {
    if (m.type === "assistant") turns++;
    for (const b of asArray(effectiveContent(m))) {
      if (b.type === "tool_use") {
        tool_calls_made++;
        if (typeof b.name === "string" && b.name.toLowerCase() === "bash") {
          const cmd = extractCommand(b.input);
          const id = typeof b.id === "string" ? b.id : "";
          const result = id !== "" ? findToolResult(messages, id) : null;
          const exit_code =
            result !== null ? extractExitCodeFromResult(result) : null;
          shell_commands.push({ cmd, exit_code });
        }
      }
    }
  }

  // Backward walk: summary.
  let summary = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m !== undefined && isAssistantClosingMessage(m)) {
      summary = capSummary(buildSummaryFromMessage(m));
      break;
    }
  }

  return {
    summary,
    shell_commands,
    tool_calls_made,
    turns,
    parse_errors,
    transcript_truncation_reason,
  };
}

// ---- assembleReport ----

export interface ReportAssemblyInput {
  job: Job;
  run_state: JobRunState;
  before_snapshot: WorkspaceSnapshot | null;
  after_snapshot: WorkspaceSnapshot | null;
  transcript_path: string | null;
  transcript_writer_truncated: boolean;
  error: ErrorDetail | null;
  duration_ms: number;
  turns_cap: number;
  workspace_root: string;
}

function statusToReportStatus(
  s: JobRunState["status"],
): "complete" | "failed" | "cancelled" {
  if (s === "complete" || s === "failed" || s === "cancelled") return s;
  // Defensive: caller is expected to pass terminal state. Map non-terminal
  // to "failed" with an explanatory error elsewhere.
  return "failed";
}

function statusStubSummary(
  status: "complete" | "failed" | "cancelled",
  error: ErrorDetail | null,
): string {
  switch (status) {
    case "complete":
      return "<completed without closing message>";
    case "failed":
      return `<failed: ${error?.message ?? "unknown error"}>`.slice(
        0,
        SUMMARY_CAP,
      );
    case "cancelled":
      return "<cancelled mid-turn>";
  }
}

function resolveTruncation(
  digest: TranscriptDigest,
  input: ReportAssemblyInput,
  diff: { truncated: boolean },
): { truncated: boolean; truncation_reason: string | null } {
  // Precedence: timeout > max_turns > transcript_size > workspace_size.
  if (input.error?.category === "timeout") {
    return { truncated: true, truncation_reason: "timeout" };
  }
  if (digest.turns >= input.turns_cap) {
    return { truncated: true, truncation_reason: "max_turns" };
  }
  if (
    input.transcript_writer_truncated ||
    digest.transcript_truncation_reason !== null
  ) {
    return { truncated: true, truncation_reason: "transcript_size" };
  }
  if (diff.truncated) {
    return { truncated: true, truncation_reason: "workspace_size" };
  }
  return { truncated: false, truncation_reason: null };
}

export async function assembleReport(
  input: ReportAssemblyInput,
): Promise<DelegationReport> {
  const digest =
    input.transcript_path !== null
      ? await parseTranscript(input.transcript_path)
      : emptyDigest();

  const diffResult =
    input.before_snapshot !== null && input.after_snapshot !== null
      ? await computeDiff(
          input.before_snapshot,
          input.after_snapshot,
          input.workspace_root,
        )
      : {
          files_created: [],
          files_modified: [],
          files_deleted: [],
          diff: "",
          diff_truncated: false,
          binary_files_changed: 0,
          truncated: false,
          truncation_reason: null,
        };

  const status = statusToReportStatus(input.run_state.status);
  const summary =
    digest.summary.length > 0 ? digest.summary : statusStubSummary(status, input.error);

  const trunc = resolveTruncation(digest, input, diffResult);

  return {
    job_id: input.job.id,
    workspace_id: input.job.workspace_id,
    status,
    summary,
    files_created: diffResult.files_created,
    files_modified: diffResult.files_modified,
    files_deleted: diffResult.files_deleted,
    diff: diffResult.diff,
    diff_truncated: diffResult.diff_truncated,
    diagnostics_before: [],
    diagnostics_after: [],
    diagnostics_delta: { added: [], resolved: [] },
    shell_commands: digest.shell_commands,
    tool_calls_made: digest.tool_calls_made,
    turns: digest.turns,
    duration_ms: input.duration_ms,
    truncated: trunc.truncated,
    truncation_reason: trunc.truncation_reason,
    transcript_uri:
      input.transcript_path !== null
        ? transcriptUri(input.transcript_path)
        : "",
    error: input.error,
  };
}

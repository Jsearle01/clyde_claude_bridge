// Streaming transcript writer for P1 delegation. Each running job writes
// its SDK messages to `${configDir}/transcripts/${job_id}.jsonl` via this
// writer. Default OS buffering — explicit flush only on `close()`. Live
// mid-job tailing is a P2 concern.
//
// CC-3: transcript files at 0600, transcripts directory at 0700. Mode is
// set on stream creation; Windows ignores Unix mode bits (set-but-ignored
// is the documented expectation per T-P1-002 pattern).
//
// Cap behavior: when an append would exceed `cap_bytes` for the first
// time, the writer appends a `_truncated` marker line (also counted
// against the cap) and refuses subsequent writes. Existing content stays
// valid JSONL. Phase 8's report assembler skips lines whose `type` starts
// with `_` (reserved for writer-internal records).

import { mkdirSync, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { WriteStream } from "node:fs";

const DEFAULT_CAP_BYTES = 50 * 1024 * 1024;

export interface AppendResult {
  written: boolean;
  truncated: boolean;
}

export interface TranscriptWriterOptions {
  cap_bytes?: number;
}

export class TranscriptWriter {
  readonly capBytes: number;
  private readonly stream: WriteStream;
  private _bytesWritten = 0;
  private _truncated = false;
  private _closed = false;
  private closeResult: Promise<void> | null = null;

  constructor(path: string, opts: TranscriptWriterOptions = {}) {
    this.capBytes = opts.cap_bytes ?? DEFAULT_CAP_BYTES;
    // Ensure parent directory exists; CC-3 mode 0700 on directory.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // CC-3 mode 0600 on file. Windows ignores the mode bits.
    this.stream = createWriteStream(path, { flags: "a", mode: 0o600 });
  }

  get bytesWritten(): number {
    return this._bytesWritten;
  }

  get truncated(): boolean {
    return this._truncated;
  }

  append(message: unknown): AppendResult {
    if (this._truncated) {
      return { written: false, truncated: true };
    }
    const line = JSON.stringify(message) + "\n";
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (this._bytesWritten + lineBytes > this.capBytes) {
      // Write a marker recording the truncation event. The marker itself
      // counts against the cap — if it can't fit fully, write whatever
      // fits and accept that final line may be partial (readers tolerate
      // unparseable trailing lines).
      const marker =
        JSON.stringify({
          type: "_truncated",
          reason: "transcript_size",
          bytes_at_cap: this._bytesWritten,
        }) + "\n";
      const markerBytes = Buffer.byteLength(marker, "utf8");
      const room = this.capBytes - this._bytesWritten;
      if (room > 0) {
        const toWrite =
          markerBytes <= room ? marker : marker.slice(0, room);
        this.stream.write(toWrite);
        this._bytesWritten += Buffer.byteLength(toWrite, "utf8");
      }
      this._truncated = true;
      return { written: false, truncated: true };
    }
    this.stream.write(line);
    this._bytesWritten += lineBytes;
    return { written: true, truncated: false };
  }

  close(): Promise<void> {
    if (this._closed && this.closeResult !== null) {
      return this.closeResult;
    }
    this._closed = true;
    this.closeResult = new Promise<void>((resolve, reject) => {
      this.stream.end((err: Error | null | undefined) => {
        if (err) reject(err);
        else resolve();
      });
    });
    return this.closeResult;
  }
}

/** Returns the on-disk path for a given job's transcript. */
export function transcriptPath(job_id: string, configDir: string): string {
  return join(configDir, "transcripts", `${job_id}.jsonl`);
}

/** Returns an RFC 8089-correct `file://` URI for a transcript path.
 * Uses Node's `url.pathToFileURL` so Windows paths get the proper
 * triple-slash form with forward slashes (e.g. `file:///C:/Users/...`). */
export function transcriptUri(transcriptPath: string): string {
  return pathToFileURL(transcriptPath).href;
}

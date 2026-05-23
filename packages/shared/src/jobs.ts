// Job state surface for P1 delegation. The JobStatus union is the wire
// contract for `delegate_to_claude_code` / `poll_delegation` /
// `cancel_delegation` responses; PartialProgress is the optional
// running-state payload returned by poll.

import { z } from "zod";

export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const TERMINAL_STATUSES: readonly JobStatus[] = [
  "complete",
  "failed",
  "cancelled",
] as const;

export function isTerminal(s: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

export const PartialProgressSchema = z
  .object({
    turns_so_far: z.number().int().nonnegative(),
    last_tool: z.string().nullable(),
    elapsed_ms: z.number().int().nonnegative(),
  })
  .strict();
export type PartialProgress = z.infer<typeof PartialProgressSchema>;

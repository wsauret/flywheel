/**
 * Subprocess payload types and schemas — canonical, single source of truth.
 *
 * Zod schemas define the shapes; static types are derived via z.infer.
 * All layers import from here.
 */

import { z } from "zod";

// SubprocessFailureReason — discriminated union of failure kinds

export const SubprocessFailureReasonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("timeout"), timeoutMs: z.number(), message: z.string() }),
  z.object({ kind: z.literal("exit_code"), exitCode: z.number(), message: z.string() }),
  z.object({ kind: z.literal("schema_error"), message: z.string() }),
  z.object({ kind: z.literal("api_error"), message: z.string() }),
  z.object({ kind: z.literal("rate_limited"), message: z.string() }),
  z.object({ kind: z.literal("transient"), message: z.string() }),
  z.object({ kind: z.literal("interrupted"), message: z.string() }),
  z.object({ kind: z.literal("handoff_missing"), message: z.string() }),
  z.object({ kind: z.literal("handoff_invalid"), message: z.string() }),
]);

export type SubprocessFailureReason = z.infer<typeof SubprocessFailureReasonSchema>;

// SubprocessResult — output of a subprocess execution

export const SubprocessResultSchema = z.object({
  output: z.string(),
  rawOutput: z.string().optional(),
  rawStderr: z.string().optional(),
  exitCode: z.number(),
  truncated: z.boolean(),
  durationMs: z.number(),
  failure: SubprocessFailureReasonSchema.optional(),
  sessionId: z.string().optional(),
  handoffPath: z.string(),
});

export type SubprocessResult = z.infer<typeof SubprocessResultSchema>;

// NDJSONEvent — a parsed NDJSON event from subprocess output

/** Known NDJSON event types from worker output. */
export type NDJSONEventType =
  // Claude Code stream-json types
  | "assistant"
  | "system"
  | "user"
  | "tool_result"
  | "result"
  // Legacy / alternate-engine types
  | "tool_use"
  | "text"
  | "step_finish"
  | "error"
  // Internal markers
  | "flywheel:subprocess_boundary"
  | "unknown";

/** A parsed NDJSON event. */
export interface NDJSONEvent {
  type: NDJSONEventType;
  data: Record<string, unknown>;
  raw: string;
}

/**
 * Subprocess payload types — canonical home for infra-layer consumption.
 *
 * These are pure TypeScript types (no Zod dependency). The Zod schemas
 * that validate these shapes live in orchestration/engines/subprocess/.
 */

// ---------------------------------------------------------------------------
// SubprocessFailureReason — discriminated union of failure kinds
// ---------------------------------------------------------------------------

export type SubprocessFailureReason =
  | { kind: "timeout"; timeoutMs: number; message: string }
  | { kind: "exit_code"; exitCode: number; message: string }
  | { kind: "schema_error"; message: string }
  | { kind: "api_error"; message: string }
  | { kind: "rate_limited"; message: string }
  | { kind: "transient"; message: string }
  | { kind: "interrupted"; message: string }
  | { kind: "handoff_missing"; message: string }
  | { kind: "handoff_invalid"; message: string };

// ---------------------------------------------------------------------------
// SubprocessResult — output of a subprocess execution
// ---------------------------------------------------------------------------

export type SubprocessResult = {
  output: string;
  rawOutput?: string;
  rawStderr?: string;
  exitCode: number;
  truncated: boolean;
  durationMs: number;
  failure?: SubprocessFailureReason;
  sessionId?: string;
  handoffPath: string;
};

// ---------------------------------------------------------------------------
// NDJSONEvent — a parsed NDJSON event from subprocess output
// ---------------------------------------------------------------------------

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

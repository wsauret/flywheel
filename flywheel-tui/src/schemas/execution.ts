import { z } from "zod";

/**
 * Shared execution status enum.
 *
 * Used for step/step status in state files. 5 values only.
 *
 * - `interrupted` = user/system cancellation, NOT a WorkerFailureReason kind.
 */
export const ExecutionStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "interrupted",
  "timeout",
]);

export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

/**
 * Session-level status enum — superset of ExecutionStatus.
 *
 * Adds `budget_exhausted` and `awaiting_user` for session lifecycle tracking.
 * Use `ExecutionStatus` for state file step/step status; use `SessionStatus`
 * for the broader session lifecycle.
 */
export const SessionStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "interrupted",
  "timeout",
  "budget_exhausted",
  "awaiting_user",
]);

export type SessionStatus = z.infer<typeof SessionStatusSchema>;

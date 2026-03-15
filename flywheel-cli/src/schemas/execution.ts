import { z } from "zod";

/**
 * Shared execution status enum.
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

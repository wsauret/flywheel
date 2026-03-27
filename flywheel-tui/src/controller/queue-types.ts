/**
 * Queue execution types — retained for queue-completion and shell compat.
 *
 * All execution goes through the queue-based step executor
 * (see src/queue/executor.ts).
 *
 * Retained types:
 *   - StepType (re-exported from queue/types.ts) — the sole type union
 *   - CompletedStepResult — lightweight step result for queue-completion compat
 *   - QueueResult — result shim used by queue-completion and shell
 *   - EndOfSessionGateCheck — end-of-session validation hook
 */

import type { EndOfSessionGateResult } from "./validation-state";
import type { StepType } from "../queue/types";

// Re-export StepType so existing consumers can import from here
export type { StepType };

/**
 * Lightweight result for a completed step — used in QueueResult.stepResults
 * to communicate which step types completed.
 */
export interface CompletedStepResult {
  workflow: string;
  completed: boolean;
}

/**
 * Result from queue execution, used by queue-completion and shell.
 *
 * @deprecated Prefer StepExecutorResult from src/queue/executor.ts for new code.
 * This shim is retained for handleQueueCompletion() and session-orchestrator.
 */
export interface QueueResult {
  completed: boolean;
  stepsCompleted: number;
  stepsTotal: number;
  reason?: string;
  stepResults: CompletedStepResult[];
}


/**
 * End-of-session gate check function.
 * Called after all steps complete successfully, before declaring queue completion.
 * Returns the gate result indicating whether all validation assertions passed.
 */
export type EndOfSessionGateCheck = () => Promise<EndOfSessionGateResult>;


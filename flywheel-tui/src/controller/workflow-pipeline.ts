/**
 * Workflow pipeline types — minimal remnant.
 *
 * Legacy stage types have been removed.
 * All execution now goes through the queue-based step executor
 * (see src/queue/executor.ts).
 *
 * Retained types:
 *   - WorkflowType — used across controller, session, memory, TUI layers
 *   - CompletedStepResult — lightweight step result for pipeline-completion compat
 *   - PipelineResult — compatibility shim used by pipeline-completion and shell
 *   - EndOfSessionGateCheck — end-of-session validation hook
 */

import type { EndOfSessionGateResult } from "./validation-state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid workflow types. */
export type WorkflowType = "work" | "plan" | "review" | "ship" | "debug" | "research" | "sprint";

/**
 * Lightweight result for a completed step — used in PipelineResult.stageResults
 * to communicate which step types completed.
 */
export interface CompletedStepResult {
  workflow: string;
  completed: boolean;
}

/**
 * Result from queue execution, adapted for pipeline-completion compatibility.
 * Used by handlePipelineCompletion() and session-orchestrator auto-archive.
 */
export interface PipelineResult {
  completed: boolean;
  stagesCompleted: number;
  stagesTotal: number;
  reason?: string;
  stageResults: CompletedStepResult[];
}

/**
 * End-of-session gate check function.
 * Called after all stages complete successfully, before declaring pipeline completion.
 * Returns the gate result indicating whether all validation assertions passed.
 */
export type EndOfSessionGateCheck = () => Promise<EndOfSessionGateResult>;


/**
 * Workflow pipeline types — retained for backward compatibility.
 *
 * The pipeline class has been removed. All execution now goes through
 * the queue-based step executor. These types remain because they are referenced
 * by pipeline-completion.ts, session-orchestrator.ts, shell-pipeline.ts, and
 * the queue-to-pipeline compatibility shim in flywheel-shell.tsx.
 */

import type { EndOfSessionGateResult } from "./validation-state";
import type { EscalationContext } from "../sprint/escalation-context";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid workflow types. */
export type WorkflowType = "work" | "plan" | "review" | "ship" | "debug" | "research" | "sprint";

export interface PipelineStage {
  workflow: WorkflowType;
  /** If true, present a gate question before proceeding to the next stage. */
  gateBeforeNext?: boolean;
}

export interface PipelineStageResult {
  workflow: WorkflowType;
  completed: boolean;
  planPath?: string;
  reason?: string;
  /** Escalation context from sprint stage — when present, triggers escalation logic. */
  escalationContext?: EscalationContext;
}

export interface PipelineResult {
  completed: boolean;
  stagesCompleted: number;
  stagesTotal: number;
  reason?: string;
  stageResults: PipelineStageResult[];
}

/**
 * Function that executes a single pipeline stage.
 * Injected for testability — production code provides a runner that
 * creates ExecutionLoop or WorkController internally.
 */
export type StageRunner = (
  stage: PipelineStage,
  args: Record<string, string>,
  signal: AbortSignal,
) => Promise<PipelineStageResult>;

/**
 * End-of-session gate check function.
 * Called after all stages complete successfully, before declaring pipeline completion.
 * Returns the gate result indicating whether all validation assertions passed.
 */
export type EndOfSessionGateCheck = () => Promise<EndOfSessionGateResult>;

// Pipeline class has been removed — see queue/executor.ts for the replacement.


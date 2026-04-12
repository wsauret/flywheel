// ---------------------------------------------------------------------------
// Step Dispatcher Helpers — pure data transformation functions
// ---------------------------------------------------------------------------
//
// Extracted from step-dispatcher.ts for SRP. These functions assemble,
// convert, and normalize data structures for the step dispatcher without
// depending on the dispatcher's closure state.
// ---------------------------------------------------------------------------

import type { Step, Queue } from "./types.js";
import type { StepType } from "../../infra/step-types.js";
import type { LastWorkerResult } from "../schemas.js";
import type { AccumulatedContext } from "./context-accumulator.js";
import type { DispatcherDecision } from "../../infra/workflow-types.js";
import type { StepContext } from "./step-context.js";
import type { EvalResult } from "./executor-types.js";
import type { MutationRequest, StepDispatchContext, StepDispatcherDecision } from "./step-dispatcher.js";
import { createEmptyStepContext } from "./step-context.js";
import { parseRawHandoff } from "./shared/handoff-parse.js";
import { randomUUID } from "crypto";

/** Known step types — used to validate dispatcher-provided types at the boundary. */
const VALID_STEP_TYPES = new Set<string>(["plan", "work", "review", "ship", "debug", "research", "verify", "gate"]);

function toStepType(raw: string): StepType {
  return VALID_STEP_TYPES.has(raw) ? (raw as StepType) : "work";
}

// ---------------------------------------------------------------------------
// buildCompactQueueState
// ---------------------------------------------------------------------------

/**
 * Build compact queue state for the dispatcher.
 * Shows all steps with their statuses to give the dispatcher
 * awareness of queue progress without sending full step data.
 */
export function buildCompactQueueState(
  queue: Queue,
  currentStepIndex: number,
): { completed_steps: number[]; current_step_index: number } {
  const completed: number[] = [];
  for (let i = 0; i < queue.steps.length; i++) {
    if (queue.steps[i].status === "completed") {
      completed.push(i);
    }
  }
  return {
    completed_steps: completed,
    current_step_index: currentStepIndex,
  };
}

// ---------------------------------------------------------------------------
// handoffToLastWorkerResult
// ---------------------------------------------------------------------------

/**
 * Convert a previous handoff to LastWorkerResult format.
 */
export function handoffToLastWorkerResult(
  handoff: Record<string, unknown>,
  stepIndex: number,
): LastWorkerResult {
  const parsed = parseRawHandoff(handoff);
  return {
    step: stepIndex,
    status: "completed",
    output_summary: parsed.summary,
    artifacts_produced: [...parsed.filesCreated, ...parsed.filesModified],
    tests_passed: parsed.testsPassed,
    decisions: parsed.decisions.length > 0 ? parsed.decisions : undefined,
    warnings: parsed.warnings.length > 0 ? parsed.warnings : undefined,
  };
}

// ---------------------------------------------------------------------------
// accumulatedToStepContext
// ---------------------------------------------------------------------------

/**
 * Convert accumulated context to StepContext for the dispatcher input.
 */
export function accumulatedToStepContext(
  accumulated: AccumulatedContext,
): StepContext {
  if (accumulated.totalSteps === 0) {
    return createEmptyStepContext();
  }

  const ctx = createEmptyStepContext();
  ctx.step_count = accumulated.totalSteps;

  // Convert summaries to StepContext format
  for (let i = 0; i < accumulated.summaries.length; i++) {
    const summary = accumulated.summaries[i];
    if (summary.decisions.length > 0) {
      ctx.cumulative_decisions.push({
        step_index: i,
        step_title: summary.stepTitle,
        decisions: summary.decisions,
      });
    }
    if (summary.issues.length > 0) {
      ctx.cumulative_issues.push({
        step_index: i,
        step_title: summary.stepTitle,
        issues: summary.issues,
      });
    }
    if (summary.artifacts.length > 0) {
      ctx.cumulative_artifacts.push({
        step_index: i,
        step_title: summary.stepTitle,
        artifacts: summary.artifacts,
      });
    }
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// buildPlanFromQueue
// ---------------------------------------------------------------------------

interface PlanStepCompact {
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  fileReferences?: string[];
  feature?: string;
}

/**
 * Build the plan steps array from queue steps (compact representation).
 * Uses the new step-based schema for the dispatcher.
 */
export function buildPlanFromQueue(
  queue: Queue,
  step: Step,
  sessionObjective?: string,
): { steps: PlanStepCompact[] } {
  const steps: PlanStepCompact[] = queue.steps.map((s) => ({
    title: s.title,
    description: s.description ?? s.title,
    acceptanceCriteria: s.acceptanceCriteria,
    fileReferences: s.fileReferences,
    feature: s.feature,
  }));

  // If session objective is provided, prepend it as context
  if (sessionObjective) {
    steps.unshift({
      title: "Session Objective",
      description: sessionObjective,
    });
  }

  return { steps };
}

// ---------------------------------------------------------------------------
// buildStepDescription
// ---------------------------------------------------------------------------

/**
 * Build step description — rich context string for the dispatcher.
 */
export function buildStepDescription(step: Step, context: StepDispatchContext): string {
  const parts: string[] = [];

  // Step description or title
  if (step.description) {
    parts.push(step.description);
  } else {
    parts.push(step.title);
  }

  // Dispatcher hint
  if (step.dispatcherHint) {
    parts.push(`[Hint: ${step.dispatcherHint}]`);
  }

  // Acceptance criteria for work steps
  if (step.acceptanceCriteria && step.acceptanceCriteria.length > 0) {
    parts.push("Acceptance criteria:");
    for (const ac of step.acceptanceCriteria) {
      parts.push(`- ${ac}`);
    }
  }

  // Template evaluation criteria for non-work steps
  if (step.evaluationCriteria) {
    parts.push(`Evaluation: ${step.evaluationCriteria}`);
  }

  // Tool scoping info
  if (step.toolScoping) {
    const scoping = step.toolScoping;
    const restrictions: string[] = [];
    if (!scoping.write) restrictions.push("no file writes");
    if (!scoping.edit) restrictions.push("no file edits");
    if (!scoping.bash) restrictions.push("no shell commands");
    if (restrictions.length > 0) {
      parts.push(`Tool restrictions: ${restrictions.join(", ")}`);
    }
  }

  // File references
  if (step.fileReferences && step.fileReferences.length > 0) {
    parts.push(`Relevant files: ${step.fileReferences.join(", ")}`);
  }

  // HITL response (if user provided input before this step)
  if (context.hitlResponse) {
    parts.push(`User input: ${context.hitlResponse}`);
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// injectAssessmentIntoContext
// ---------------------------------------------------------------------------

/**
 * Inject evaluator assessment into step context as warnings.
 */
export function injectAssessmentIntoContext(
  ctx: StepContext,
  assessment: EvalResult,
): void {
  const assessmentWarnings: string[] = [];

  if (assessment.reason) {
    assessmentWarnings.push(`Previous evaluator assessment: ${assessment.reason}`);
  }
  if (assessment.feedback) {
    assessmentWarnings.push(`Evaluator feedback: ${assessment.feedback}`);
  }
  if (assessment.suggestions && assessment.suggestions.length > 0) {
    assessmentWarnings.push(
      `Evaluator suggestions: ${assessment.suggestions.join("; ")}`,
    );
  }
  if (assessmentWarnings.length > 0) {
    ctx.cumulative_warnings.push({
      step_index: ctx.step_count,
      step_title: "Previous evaluator assessment",
      warnings: assessmentWarnings,
    });
  }
}

// ---------------------------------------------------------------------------
// normalizeDecision
// ---------------------------------------------------------------------------

/**
 * Normalize DispatcherDecision to StepDispatcherDecision.
 */
export function normalizeDecision(
  raw: DispatcherDecision,
  step: Step,
): StepDispatcherDecision {
  // Parse mutation requests from structured field
  const mutationRequests = (raw.mutation_requests ?? []).map(req => ({
    type: req.type as "insert_after" | "skip" | "remove",
    targetStepId: req.target_step_id,
    steps: req.steps?.map(s => ({
      id: randomUUID(),
      type: toStepType(s.type),
      title: s.title,
      status: "pending" as const,
      description: s.description,
      acceptanceCriteria: s.acceptance_criteria,
    })),
    reason: req.reason,
  }));

  // Merge tool scoping: step provides defaults, dispatcher can override
  let workerConfig = raw.worker_config ?? null;
  if (step.toolScoping && workerConfig && !workerConfig.tool_scoping) {
    // Step has tool scoping but dispatcher didn't override — apply step's
    workerConfig = { ...workerConfig, tool_scoping: step.toolScoping };
  } else if (step.toolScoping && !workerConfig) {
    // No worker config from dispatcher — create one with step's tool scoping
    workerConfig = { tool_scoping: step.toolScoping };
  }

  return {
    taskContent: raw.task_content,
    evaluationCriteria: raw.evaluation_criteria,
    workerConfig,
    contextToInline: raw.context_to_inline ?? [],
    contextFiles: raw.context_files,
    mutationRequests,
  };
}

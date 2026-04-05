// ---------------------------------------------------------------------------
// Step Dispatcher Helpers — pure data transformation functions
// ---------------------------------------------------------------------------
//
// Extracted from step-dispatcher.ts for SRP. These functions assemble,
// convert, and normalize data structures for the step dispatcher without
// depending on the dispatcher's closure state.
// ---------------------------------------------------------------------------

import type { Step, Queue } from "./types.js";
import type { LastWorkerResult } from "../schemas.js";
import type { AccumulatedContext } from "./context-accumulator.js";
import type { DispatcherDecision } from "../dispatcher/schemas.js";
import type { StepContext } from "./step-context.js";
import type { EvalResult } from "./executor.js";
import type { MutationRequest, StepDispatchContext, StepDispatcherDecision } from "./step-dispatcher.js";
import { createEmptyStepContext } from "./step-context.js";
import { randomUUID } from "crypto";

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
  const summary = typeof handoff.summary === "string"
    ? handoff.summary
    : JSON.stringify(handoff).slice(0, 500);

  const artifacts = Array.isArray(handoff.artifacts_produced)
    ? handoff.artifacts_produced.filter((a): a is string => typeof a === "string")
    : [];

  // Extract from nested artifacts object
  const artObj = handoff.artifacts;
  if (artObj && typeof artObj === "object") {
    const a = artObj as Record<string, unknown>;
    if (Array.isArray(a.files_created)) artifacts.push(...a.files_created.filter((f): f is string => typeof f === "string"));
    if (Array.isArray(a.files_modified)) artifacts.push(...a.files_modified.filter((f): f is string => typeof f === "string"));
  }

  const verification = handoff.verification as Record<string, unknown> | undefined;
  const testsPassed = verification?.tests_passed != null
    ? Boolean(verification.tests_passed)
    : null;

  const decisions = Array.isArray(handoff.decisions)
    ? handoff.decisions.filter((d): d is string => typeof d === "string")
    : undefined;

  const warnings = Array.isArray(handoff.warnings)
    ? handoff.warnings.filter((w): w is string => typeof w === "string")
    : undefined;

  return {
    step: stepIndex,
    status: "completed",
    output_summary: summary,
    artifacts_produced: artifacts,
    tests_passed: testsPassed,
    duration_seconds: 0,
    decisions,
    warnings,
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
  for (const summary of accumulated.summaries) {
    if (summary.decisions.length > 0) {
      ctx.cumulative_decisions.push({
        step_index: 0,
        step_title: summary.stepTitle,
        decisions: summary.decisions,
      });
    }
    if (summary.issues.length > 0) {
      ctx.cumulative_issues.push({
        step_index: 0,
        step_title: summary.stepTitle,
        issues: summary.issues,
      });
    }
    if (summary.artifacts.length > 0) {
      ctx.cumulative_artifacts.push({
        step_index: 0,
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
  fulfills?: string[];
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
    fulfills: s.fulfills,
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
// parseMutationRequests
// ---------------------------------------------------------------------------

/**
 * Parse mutation requests from dispatcher warnings field.
 * Format: "mutation:<type>:<target>:<title>:<reason>"
 */
function parseMutationRequests(warnings: string[] | undefined): MutationRequest[] {
  if (!warnings) return [];
  const requests: MutationRequest[] = [];

  for (const w of warnings) {
    if (!w.startsWith("mutation:")) continue;
    const parts = w.split(":");
    if (parts.length < 4) continue;

    const [_, type, target, ...rest] = parts;
    const reason = rest.join(":");

    if (type === "insert_after" && rest.length >= 2) {
      const title = rest[0];
      const insertReason = rest.slice(1).join(":");
      requests.push({
        type: "insert_after",
        targetStepId: target === "current" ? undefined : target,
        steps: [{ id: randomUUID(), type: "work", status: "pending", title, description: insertReason }],
        reason: insertReason,
      });
    } else if (type === "skip") {
      requests.push({ type: "skip", targetStepId: target, reason });
    } else if (type === "remove") {
      requests.push({ type: "remove", targetStepId: target, reason });
    }
  }

  return requests;
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
  // Parse mutation requests from warnings or use structured field
  const mutationRequests = raw.mutation_requests?.length 
    ? raw.mutation_requests.map(req => ({
        type: req.type as "insert_after" | "skip" | "remove",
        targetStepId: req.target_step_id,
        steps: req.steps?.map(s => ({
          id: randomUUID(),
          type: s.type as any,
          title: s.title,
          status: "pending" as const,
          description: s.description,
          acceptanceCriteria: s.acceptance_criteria,
        })),
        reason: req.reason,
      }))
    : parseMutationRequests(raw.warnings);

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
    sessionName: raw.session_name,
  };
}

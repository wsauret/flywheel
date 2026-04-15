// Step Dispatcher Helpers — pure data transformation functions
//
// Extracted from step-dispatcher.ts for SRP. These functions assemble,
// convert, and normalize data structures for the step dispatcher without
// depending on the dispatcher's closure state.

import type { Step, Queue } from "./types.js";
import type { LastWorkerResult, SessionBudgetStatus, AvailableContext } from "../schemas.js";
import type { DispatcherInput } from "../dispatcher/schemas.js";
import type { AccumulatedContext } from "./context-accumulator.js";
import type { DispatcherDecision } from "../../infra/workflow-types.js";
import type { StepContext } from "./step-context.js";
import type { EvalResult } from "./executor-types.js";
import type { MutationRequest, StepDispatchContext, StepDispatcherDecision } from "./step-dispatcher.js";
import type { MutationBudget } from "./guardrails.js";
import { createEmptyStepContext } from "./step-context.js";
import { parseRawHandoff } from "./shared/handoff-parse.js";
import { randomUUID } from "crypto";

/**
 * Build compact queue state for the dispatcher.
 * Shows all steps with their statuses to give the dispatcher
 * awareness of queue progress without sending full step data.
 */
function buildCompactQueueState(
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

/**
 * Convert a previous handoff to LastWorkerResult format.
 */
function handoffToLastWorkerResult(
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

/**
 * Convert accumulated context to StepContext for the dispatcher input.
 */
function accumulatedToStepContext(
  accumulated: AccumulatedContext,
): StepContext {
  if (accumulated.totalSteps === 0) {
    return createEmptyStepContext();
  }

  const ctx = createEmptyStepContext();
  ctx.step_count = accumulated.totalSteps;

  for (let i = 0; i < accumulated.summaries.length; i++) {
    const s = accumulated.summaries[i];
    const base = { step_index: i, step_title: s.stepTitle };
    if (s.decisions.length) ctx.cumulative_decisions.push({ ...base, decisions: s.decisions });
    if (s.issues.length) ctx.cumulative_issues.push({ ...base, issues: s.issues });
    if (s.artifacts.length) ctx.cumulative_artifacts.push({ ...base, artifacts: s.artifacts });
  }

  return ctx;
}

/**
 * Build the plan steps array from queue steps (compact representation).
 * Uses the new step-based schema for the dispatcher.
 */
function buildPlanFromQueue(queue: Queue) {
  const steps = queue.steps.map((s) => ({
    title: s.title,
    description: s.description ?? s.title,
    acceptanceCriteria: s.acceptanceCriteria,
    fileReferences: s.fileReferences,
    feature: s.feature,
  }));

  return { steps };
}

/**
 * Build step description — rich context string for the dispatcher.
 */
function buildStepDescription(step: Step): string {
  const parts: string[] = [step.description ?? step.title];

  if (step.dispatcherHint) parts.push(`[Hint: ${step.dispatcherHint}]`);

  if (step.acceptanceCriteria?.length) {
    parts.push("Acceptance criteria:", ...step.acceptanceCriteria.map(ac => `- ${ac}`));
  }

  if (step.evaluationCriteria) parts.push(`Evaluation: ${step.evaluationCriteria}`);

  if (step.toolScoping) {
    const r = [
      !step.toolScoping.write && "no file writes",
      !step.toolScoping.edit && "no file edits",
      !step.toolScoping.bash && "no shell commands",
    ].filter(Boolean);
    if (r.length) parts.push(`Tool restrictions: ${r.join(", ")}`);
  }

  if (step.fileReferences?.length) parts.push(`Relevant files: ${step.fileReferences.join(", ")}`);

  return parts.join("\n");
}

/**
 * Inject evaluator assessment into step context as warnings.
 */
function injectAssessmentIntoContext(ctx: StepContext, assessment: EvalResult): void {
  const warnings = [
    assessment.reason && `Previous evaluator assessment: ${assessment.reason}`,
    assessment.feedback && `Evaluator feedback: ${assessment.feedback}`,
    assessment.suggestions?.length && `Evaluator suggestions: ${assessment.suggestions.join("; ")}`,
  ].filter(Boolean) as string[];

  if (warnings.length) {
    ctx.cumulative_warnings.push({
      step_index: ctx.step_count,
      step_title: "Previous evaluator assessment",
      warnings,
    });
  }
}

/**
 * Normalize DispatcherDecision to StepDispatcherDecision.
 */
export function normalizeDecision(
  raw: DispatcherDecision,
  step: Step,
): StepDispatcherDecision {
  const mutationRequests: MutationRequest[] = [];
  for (const req of raw.mutation_requests ?? []) {
    if (!req.target_step_id) continue;
    if (req.type === "insert_after") {
      const steps = req.steps?.map(s => ({
        id: randomUUID(),
        type: "work" as const,
        title: s.title,
        status: "pending" as const,
        description: s.description,
        acceptanceCriteria: s.acceptance_criteria,
      }));
      if (!steps || steps.length === 0) continue;
      mutationRequests.push({ type: "insert_after", targetStepId: req.target_step_id, steps, reason: req.reason });
    } else {
      mutationRequests.push({ type: req.type, targetStepId: req.target_step_id, reason: req.reason });
    }
  }

  let workerConfig = raw.worker_config ?? null;
  if (step.toolScoping && !workerConfig?.tool_scoping) {
    workerConfig = { ...workerConfig, tool_scoping: step.toolScoping };
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

function toMutationBudgetWire(budget: MutationBudget) {
  return {
    max_queue_length: budget.maxQueueLength,
    current_queue_length: budget.currentQueueLength,
    remaining_queue_capacity: budget.remainingQueueCapacity,
    mutations_used_this_step: budget.mutationsUsedThisStep,
    mutations_remaining_this_step: budget.mutationsRemainingThisStep,
    total_session_inserts: budget.totalSessionInserts,
    session_inserts_remaining: budget.sessionInsertsRemaining,
    session_objective: budget.sessionObjective,
  };
}

/** Assemble the full DispatcherInput from step, queue, and session context. */
export function buildDispatcherInput(
  step: Step,
  queue: Queue,
  context: StepDispatchContext,
  currentIndex: number,
  options: {
    configContext: {
      maxEvalCycles: number;
      worktreePath: string;
      projectCwd: string;
      subprocessModel: string;
      dispatcherModel: string;
    };
    workflowId: string;
    sessionBudget: SessionBudgetStatus;
    availableContext: AvailableContext;
  },
): DispatcherInput {
  const stepDescription = buildStepDescription(step);

  const input: DispatcherInput = {
    plan: buildPlanFromQueue(queue),
    state: buildCompactQueueState(queue, currentIndex),
    workflow_id: options.workflowId,
    workflow: {
      name: step.type,
      step_number: currentIndex + 1,
      total_steps: queue.steps.length,
      step_description: stepDescription,
    },
    last_worker_result: context.previousHandoff
      ? handoffToLastWorkerResult(context.previousHandoff, currentIndex - 1)
      : null,
    config: {
      max_eval_cycles: options.configContext.maxEvalCycles,
      worktree_path: options.configContext.worktreePath,
      project_cwd: options.configContext.projectCwd,
      subprocess_model: options.configContext.subprocessModel,
      dispatcher_model: options.configContext.dispatcherModel,
    },
    session_budget: options.sessionBudget,
    available_context: options.availableContext,
    step_context: accumulatedToStepContext(context.accumulatedContext),
    mutation_budget: context.mutationBudget
      ? toMutationBudgetWire(context.mutationBudget)
      : undefined,
  };

  if (context.previousAssessment) {
    injectAssessmentIntoContext(input.step_context, context.previousAssessment);
  }

  return input;
}

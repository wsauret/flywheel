// ---------------------------------------------------------------------------
// Step Dispatcher — Real dispatcher integration for per-step execution
// ---------------------------------------------------------------------------
//
// Bridges the queue step executor with the existing DispatcherTransport.
// For each step, assembles a full DispatcherInput with:
//   - Step metadata (type, title, hint, tool scoping, acceptance criteria)
//   - Queue state (compact: step statuses)
//   - Previous handoff from last completed step
//   - Previous evaluator assessment
//   - Accumulated context from prior steps (windowed)
//   - Available context (L1 metadata from ContextIndexer)
//   - Budget remaining
//   - Session objective
//
// Returns a StepDispatcherDecision with:
//   - taskContent: crafted worker prompt
//   - evaluationCriteria: for evaluator (derived from acceptanceCriteria for work steps)
//   - workerConfig: model, timeout, tool scoping
//   - contextToInline: L2 file paths
//   - contextFiles: L3 file paths
//   - mutationRequests: queue mutations requested by dispatcher
//
// On transport failure: throws StepDispatcherError (caller marks step failed).
// ---------------------------------------------------------------------------

import type { Step, Queue } from "./types";
import type { DispatcherTransport } from "../dispatcher/transport";
import type {
  DispatcherInput,
  DispatcherDecision,
  DispatcherConfig,
  WorkflowInfo,
} from "../schemas/dispatcher";
import type { FlywheelEmitter } from "../events/event-bus";
import type {
  SessionBudgetStatus,
  AvailableContext,
  LastWorkerResult,
  EvaluationCriteria,
  WorkerConfig,
} from "../schemas/shared";
import type { AccumulatedContext, HandoffSummary } from "./context-accumulator";
import type { EvalResult } from "./executor";
import type { StepContext } from "../controller/step-context";
import { createEmptyStepContext } from "../controller/step-context";
import { Log } from "../utils/log";

const log = Log.create({ service: "step-dispatcher" });

// ---------------------------------------------------------------------------
// Types — Dispatcher context passed per-step
// ---------------------------------------------------------------------------

/** Context provided by the executor for each step dispatch. */
export interface StepDispatchContext {
  /** Windowed accumulated context from prior steps. */
  accumulatedContext: AccumulatedContext;
  /** Handoff data from the previous step (null if first step). */
  previousHandoff: Record<string, unknown> | null;
  /** Evaluator assessment from the previous step (null if first or no evaluator). */
  previousAssessment: EvalResult | null;
  /** HITL response from user (if step had HITL). */
  hitlResponse?: string | null;
  /** Mutation budget from guardrails (for budget visibility — VAL-GUARD-006). */
  mutationBudget?: import("./guardrails").MutationBudget | null;
}

// ---------------------------------------------------------------------------
// Types — Mutation requests
// ---------------------------------------------------------------------------

/** A mutation requested by the dispatcher. */
export interface MutationRequest {
  /** Mutation type. */
  type: "insert_after" | "skip" | "remove";
  /** Step ID to operate on (for skip/remove) or insert after. */
  targetStepId?: string;
  /** For insert_after: the step(s) to insert. */
  steps?: Array<{
    type: string;
    title: string;
    description?: string;
    acceptanceCriteria?: string[];
  }>;
  /** Why the mutation is requested. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Types — Dispatcher decision (normalized from raw DispatcherDecision)
// ---------------------------------------------------------------------------

/** Normalized decision from the step dispatcher. */
export interface StepDispatcherDecision {
  /** Crafted worker prompt. */
  taskContent: string;
  /** Evaluation criteria for the evaluator (null = no evaluation). */
  evaluationCriteria: EvaluationCriteria | null;
  /** Worker configuration overrides. */
  workerConfig: WorkerConfig | null;
  /** Files to inline into worker prompt (L2). */
  contextToInline: string[];
  /** Files the worker can read on demand (L3). */
  contextFiles: string[];
  /** Queue mutation requests from dispatcher. */
  mutationRequests: MutationRequest[];
  /** Session name suggestion (first step only). */
  sessionName?: string;
}

// ---------------------------------------------------------------------------
// Types — Options for createStepDispatcher
// ---------------------------------------------------------------------------

export interface StepDispatcherOptions {
  /** Dispatcher transport (subprocess or SDK). */
  transport: DispatcherTransport;
  /** Event emitter for dispatcher lifecycle events. */
  emitter: FlywheelEmitter;
  /** Workflow ID for event emission. */
  workflowId: string;
  /** Runtime config context for the dispatcher. */
  configContext: {
    maxEvalCycles: number;
    worktreePath: string;
    projectCwd: string;
    workerModel: string;
    dispatcherModel: string;
  };
  /** Session budget status. */
  sessionBudget: SessionBudgetStatus;
  /** Available context (L1 metadata). */
  availableContext: AvailableContext;
  /** Session objective / description. */
  sessionObjective?: string;
}

// ---------------------------------------------------------------------------
// StepDispatcher interface
// ---------------------------------------------------------------------------

export interface StepDispatcher {
  /** Dispatch a step: assemble input, invoke transport, parse decision. */
  dispatch(
    step: Step,
    queue: Queue,
    context: StepDispatchContext,
  ): Promise<StepDispatcherDecision>;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class StepDispatcherError extends Error {
  constructor(
    message: string,
    public readonly stepId: string,
    public readonly cause?: Error,
  ) {
    super(`dispatcher failed for step ${stepId}: ${message}`);
    this.name = "StepDispatcherError";
  }
}

// ---------------------------------------------------------------------------
// Helpers — assemble DispatcherInput from step context
// ---------------------------------------------------------------------------

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

/**
 * Build the plan steps array from queue steps (compact representation).
 * Uses the new step-based schema for the dispatcher.
 */
interface PlanStepCompact {
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  fileReferences?: string[];
  feature?: string;
  fulfills?: string[];
}

function buildPlanFromQueue(
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
        steps: [{ type: "work", title, description: insertReason }],
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
// createStepDispatcher — factory function
// ---------------------------------------------------------------------------

export function createStepDispatcher(options: StepDispatcherOptions): StepDispatcher {
  const {
    transport,
    emitter,
    workflowId,
    configContext,
    sessionBudget,
    availableContext,
    sessionObjective,
  } = options;

  async function dispatch(
    step: Step,
    queue: Queue,
    context: StepDispatchContext,
  ): Promise<StepDispatcherDecision> {
    const stepIndex = queue.steps.findIndex((s) => s.id === step.id);
    const currentIndex = stepIndex >= 0 ? stepIndex : queue.cursor;

    // Emit dispatcher:invoked
    emitter.dispatcherInvoked(workflowId, currentIndex);

    try {
      // --- Assemble DispatcherInput ---

      // Build step description incorporating all metadata
      const stepDescription = buildStepDescription(step, context);

      // Build workflow info
      const workflowInfo: WorkflowInfo = {
        name: step.type,
        step_number: currentIndex + 1,
        total_steps: queue.steps.length,
        step_description: stepDescription,
      };

      // Build dispatcher config
      const dispatcherConfig: DispatcherConfig = {
        max_eval_cycles: configContext.maxEvalCycles,
        worktree_path: configContext.worktreePath,
        project_cwd: configContext.projectCwd,
        worker_model: configContext.workerModel,
        dispatcher_model: configContext.dispatcherModel,
      };

      // Build compact queue state
      const queueState = buildCompactQueueState(queue, currentIndex);

      // Build plan representation from queue
      const plan = buildPlanFromQueue(queue, step, sessionObjective);

      // Convert previous handoff to LastWorkerResult
      const lastWorkerResult = context.previousHandoff
        ? handoffToLastWorkerResult(context.previousHandoff, currentIndex - 1)
        : null;

      // Convert accumulated context to StepContext
      const stepContext = accumulatedToStepContext(context.accumulatedContext);

      // Inject previous assessment into step context warnings
      if (context.previousAssessment) {
        injectAssessmentIntoContext(stepContext, context.previousAssessment);
      }

      // Build mutation budget for dispatcher visibility (VAL-GUARD-006)
      const mutationBudgetInput = context.mutationBudget
        ? {
            max_queue_length: context.mutationBudget.maxQueueLength,
            current_queue_length: context.mutationBudget.currentQueueLength,
            remaining_queue_capacity: context.mutationBudget.remainingQueueCapacity,
            mutations_used_this_step: context.mutationBudget.mutationsUsedThisStep,
            mutations_remaining_this_step: context.mutationBudget.mutationsRemainingThisStep,
            total_session_inserts: context.mutationBudget.totalSessionInserts,
            session_inserts_remaining: context.mutationBudget.sessionInsertsRemaining,
            session_objective: context.mutationBudget.sessionObjective,
          }
        : undefined;

      // Build the DispatcherInput
      const input: DispatcherInput = {
        plan,
        state: queueState,
        context: { files: step.fileReferences ?? [] },
        plan_truncated: false,
        history_truncated: false,
        workflow_id: workflowId,
        workflow: workflowInfo,
        last_worker_result: lastWorkerResult,
        config: dispatcherConfig,
        session_budget: sessionBudget,
        available_context: availableContext,
        step_context: stepContext,
        mutation_budget: mutationBudgetInput,
      };

      // --- Invoke transport ---
      log.info("dispatching step", {
        stepId: step.id,
        stepType: step.type,
        stepTitle: step.title,
        stepIndex: currentIndex,
      });

      const decision = await transport.invoke(input);

      log.info("dispatcher decision received", {
        stepId: step.id,
        taskContentLength: decision.task_content.length,
        contextFiles: decision.context_files.length,
        hasWorkerConfig: !!decision.worker_config,
        hasSessionName: !!decision.session_name,
      });

      // Emit dispatcher:completed
      emitter.dispatcherCompleted(workflowId, decision);

      // --- Parse and normalize decision ---
      return normalizeDecision(decision, step);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      log.warn("dispatcher failed for step", {
        stepId: step.id,
        stepType: step.type,
        reason,
      });

      // Emit dispatcher:failed
      emitter.dispatcherFailed(workflowId, reason);

      throw new StepDispatcherError(reason, step.id, error instanceof Error ? error : undefined);
    }
  }

  return { dispatch };
}

// ---------------------------------------------------------------------------
// Build step description — rich context string for the dispatcher
// ---------------------------------------------------------------------------

function buildStepDescription(step: Step, context: StepDispatchContext): string {
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
// Inject assessment into step context
// ---------------------------------------------------------------------------

function injectAssessmentIntoContext(
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
// Normalize DispatcherDecision → StepDispatcherDecision
// ---------------------------------------------------------------------------

function normalizeDecision(
  raw: DispatcherDecision,
  step: Step,
): StepDispatcherDecision {
  // Parse mutation requests from warnings
  const mutationRequests = parseMutationRequests(raw.warnings);

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

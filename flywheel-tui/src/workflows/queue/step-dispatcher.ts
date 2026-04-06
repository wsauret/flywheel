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

import type { Step, Queue } from "./types.js";
import type { DispatcherTransport } from "../dispatcher/transport.js";
import type {
  DispatcherInput,
  DispatcherConfig,
  WorkflowInfo,
} from "../dispatcher/schemas.js";
import type { FlywheelEmitter } from "../../infra/event-bus.js";
import type {
  SessionBudgetStatus,
  AvailableContext,
  EvaluationCriteria,
  WorkerConfig,
} from "../schemas.js";
import type { AccumulatedContext } from "./context-accumulator.js";
import type { EvalResult } from "./executor.js";
import { applyBudgetTruncation } from "../dispatcher/truncation.js";
import { Log } from "../../infra/log.js";
import { errorMessage } from "../../infra/error-message.js";
import {
  buildCompactQueueState,
  handoffToLastWorkerResult,
  accumulatedToStepContext,
  buildPlanFromQueue,
  buildStepDescription,
  injectAssessmentIntoContext,
  normalizeDecision,
} from "./step-dispatcher-helpers.js";

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
  steps?: import("./types").Step[];
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
    subprocessModel: string;
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
        subprocess_model: configContext.subprocessModel,
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

      // Safety valve — shared 100KB budget truncation on available_context
      applyBudgetTruncation(input);

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
      const reason = errorMessage(error);

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



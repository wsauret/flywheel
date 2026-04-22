// Step Dispatcher — Real dispatcher integration for per-step execution
//
// Bridges the queue step executor with the existing DispatcherTransport.
// For each step, assembles a full DispatcherInput with:
//   - Step metadata (type, title, description, hint, tool scoping, acceptance criteria)
//   - Queue state (compact: step statuses)
//   - Previous handoff from last completed step
//   - Previous evaluator assessment
//   - Accumulated context from prior steps (windowed)
//   - Available context (L1 metadata from ContextIndexer)
//   - Budget remaining
//
// On transport failure: throws StepDispatcherError (caller marks step failed).

import type { Step, Queue } from "./types.js";
import type { DispatcherTransport } from "../dispatcher/transport.js";
import type { EmitFn } from "../../infra/event-bus.js";
import type { SessionBudgetStatus, AvailableContext } from "../schemas.js";
import { applyBudgetTruncation } from "../dispatcher/truncation.js";
import { Log } from "../../infra/log.js";
import { errorMessage } from "../../infra/error-message.js";
import {
  buildDispatcherInput,
  normalizeDecision,
} from "./step-dispatcher-helpers.js";
import type { StepDispatchContext, StepDispatcherDecision, MutationRequest } from "./step-dispatcher-types.js";

const log = Log.create({ service: "step-dispatcher" });

interface StepDispatcherOptions {
  /** Dispatcher transport (engine-backed or pooled). */
  transport: DispatcherTransport;
  /** Event emitter for dispatcher lifecycle events. */
  emit: EmitFn;
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
}

interface StepDispatcher {
  /** Dispatch a step: assemble input, invoke transport, parse decision. */
  dispatch(
    step: Step,
    queue: Queue,
    context: StepDispatchContext,
  ): Promise<StepDispatcherDecision>;
}

export function createStepDispatcher(options: StepDispatcherOptions): StepDispatcher {
  const {
    transport,
    emit,
    workflowId,
    configContext,
    sessionBudget,
    availableContext,
  } = options;

  async function dispatch(
    step: Step,
    queue: Queue,
    context: StepDispatchContext,
  ): Promise<StepDispatcherDecision> {
    const stepIndex = queue.steps.findIndex((s) => s.id === step.id);
    const currentIndex = stepIndex >= 0 ? stepIndex : queue.cursor;

    emit("dispatcher:invoked", { workflowId, stepIndex: currentIndex });

    try {
      const input = buildDispatcherInput(step, queue, context, currentIndex, {
        configContext,
        workflowId,
        sessionBudget,
        availableContext,
      });

      applyBudgetTruncation(input);

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
      });

      emit("dispatcher:completed", { workflowId, decision });

      return normalizeDecision(decision, step);
    } catch (error) {
      const reason = errorMessage(error);

      log.warn("dispatcher failed for step", {
        stepId: step.id,
        stepType: step.type,
        reason,
      });

      emit("dispatcher:failed", { workflowId, reason });

      throw new Error(`dispatcher failed for step ${step.id}: ${reason}`, { cause: error instanceof Error ? error : undefined });
    }
  }

  return { dispatch };
}



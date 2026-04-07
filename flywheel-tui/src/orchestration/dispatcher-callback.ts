/**
 * Dispatcher callback factory — creates the step dispatcher function
 * with fallback to step metadata when the real dispatcher is unavailable.
 *
 * Extracted from queue-orchestrator.ts for SRP.
 */

import { createStepDispatcher, type StepDispatchContext, type MutationRequest } from "../workflows/queue/step-dispatcher"
import { Log } from "../infra/log"
import { errorMessage } from "../infra/error-message"
import type { ContextIndexer } from "./memory/indexer"
import type { FlywheelEmitter } from "../infra/event-bus"
import type { WorkflowDeps } from "./engines/workflow-deps"
import type { ContextAccumulator } from "../workflows/queue/context-accumulator"
import type { Step, Queue } from "../workflows/queue/types"
import type { DispatcherTransport } from "../workflows/dispatcher/transport"
import type { EvalResult } from "../workflows/queue/executor"

const log = Log.create({ service: "dispatcher-callback" })

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DispatcherCallbackDeps {
  deps: WorkflowDeps
  emitter: FlywheelEmitter
  workflowIdRef: { current: string }
  dispatcherTransport: DispatcherTransport | undefined
  contextIndexer: ContextIndexer
  contextAccumulator: ContextAccumulator
  projectCwd: string
  sessionObjective: string | undefined
  queue: Queue
  dispatcherModel: string | undefined
  subprocessModel: string | undefined
}

export interface DispatcherResult {
  prompt: string
  evaluationCriteria: unknown | null
  mutationRequests?: MutationRequest[]
  sessionName?: string
}

export type DispatcherFn = (
  step: Step,
  context: { previousHandoff?: Record<string, unknown>; previousAssessment?: EvalResult | null; hitlResponse?: string | null },
) => Promise<DispatcherResult>

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDispatcherCallback(opts: DispatcherCallbackDeps): DispatcherFn {
  const {
    deps, dispatcherTransport, contextIndexer, contextAccumulator,
    projectCwd, sessionObjective, queue, emitter, workflowIdRef,
    dispatcherModel, subprocessModel,
  } = opts

  // Build real StepDispatcher if transport is available
  const realDispatcher = dispatcherTransport
    ? createStepDispatcher({
        transport: dispatcherTransport,
        emitter,
        workflowId: workflowIdRef.current,
        configContext: {
          maxEvalCycles: deps.config.max_revisions ?? 1,
          worktreePath: projectCwd,
          projectCwd,
          subprocessModel: subprocessModel ?? "sonnet",
          dispatcherModel: dispatcherModel ?? "sonnet",
        },
        sessionBudget: { wall_clock_deadline: null, invocations_remaining: null, token_budget_remaining: null },
        availableContext: contextIndexer.getRelevantContext({ stepType: "plan", stepDescription: sessionObjective ?? "" }),
        sessionObjective,
      })
    : null

  return async (step, context) => {
    if (realDispatcher) {
      try {
        const dispatchContext: StepDispatchContext = {
          accumulatedContext: contextAccumulator.getContext(),
          previousHandoff: context.previousHandoff ?? null,
          previousAssessment: context.previousAssessment ?? null,
          hitlResponse: context.hitlResponse ?? null,
        }
        const decision = await realDispatcher.dispatch(step, queue, dispatchContext)
        return {
          prompt: decision.taskContent,
          evaluationCriteria: decision.evaluationCriteria,
          mutationRequests: decision.mutationRequests,
        }
      } catch (err) {
        log.warn("real dispatcher failed, falling back to step metadata", {
          stepId: step.id,
          error: errorMessage(err),
        })
      }
    }

    // Fallback: build prompt from step metadata
    const parts = [step.title]
    if (step.description) parts.push(step.description)
    if (step.acceptanceCriteria?.length) {
      parts.push("Acceptance criteria:", ...step.acceptanceCriteria.map(c => `- ${c}`))
    }
    if (step.evaluationCriteria) parts.push(`Evaluation: ${step.evaluationCriteria}`)
    return { prompt: parts.join("\n"), evaluationCriteria: null }
  }
}

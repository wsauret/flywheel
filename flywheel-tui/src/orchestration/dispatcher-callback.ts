import { createStepDispatcher } from "../workflows/queue/step-dispatcher.js"
import { buildStepMetadataPrompt } from "../workflows/queue/shared/step-prompt.js"
import { Log } from "../infra/log.js"
import { errorMessage } from "../infra/error-message.js"
import type { ContextIndexer } from "./memory/indexer.js"
import type { EmitFn } from "../infra/event-bus.js"
import type { ContextAccumulator } from "../workflows/queue/context-accumulator.js"
import type { Step, Queue } from "../workflows/queue/types.js"
import type { DispatcherTransport } from "../workflows/dispatcher/transport.js"
import type { DispatcherFn } from "../workflows/queue/executor-types.js"
import type { AvailableContext } from "../workflows/schemas.js"

const log = Log.create({ service: "dispatcher-callback" })

interface DispatcherCallbackDeps {
  maxRevisions: number | undefined
  emit: EmitFn
  workflowId: string
  dispatcherTransport: DispatcherTransport
  contextIndexer: ContextIndexer
  contextAccumulator: ContextAccumulator
  projectCwd: string
  queue: Queue
  workerModel: string
  dispatcherModel: string
  chatContext: string | undefined
}

export function createDispatcherCallback(opts: DispatcherCallbackDeps): DispatcherFn {
  const {
    maxRevisions, dispatcherTransport, contextIndexer, contextAccumulator,
    projectCwd, queue, emit, workflowId,
    workerModel, dispatcherModel, chatContext,
  } = opts

  const stepDispatcher = createStepDispatcher({
    transport: dispatcherTransport,
    emit,
    workflowId,
    configContext: {
      maxEvalCycles: maxRevisions ?? 1,
      worktreePath: projectCwd,
      projectCwd,
      workerModel,
      dispatcherModel,
    },
    sessionBudget: { wall_clock_deadline: null, invocations_remaining: null, token_budget_remaining: null },
    availableContext: chatContext
      ? { ...contextIndexer.getRelevantContext(), chatHistory: chatContext }
      : contextIndexer.getRelevantContext(),
  })

  return async (step, context, signal) => {
    try {
      const dispatchContext = {
        accumulatedContext: contextAccumulator.getContext(),
        previousHandoff: context.previousHandoff,
        previousAssessment: context.previousAssessment,
      }
      const decision = await stepDispatcher.dispatch(step, queue, dispatchContext, signal)
      if (decision.workerConfig?.self_review_items !== undefined) {
        step.selfReviewItems = decision.workerConfig.self_review_items
      }
      return {
        prompt: decision.taskContent,
        evaluationCriteria: decision.evaluationCriteria,
        mutationRequests: decision.mutationRequests,
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err
      if (signal?.aborted) throw err
      log.warn("dispatcher failed, falling back to step metadata", {
        stepId: step.id,
        error: errorMessage(err),
      })
    }

    let prompt = buildStepMetadataPrompt(step)
    if (step.evaluationCriteria) prompt += `\nEvaluation: ${step.evaluationCriteria}`
    return { prompt, evaluationCriteria: null }
  }
}

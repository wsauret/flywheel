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
  dispatcherTransport: DispatcherTransport | undefined
  contextIndexer: ContextIndexer
  contextAccumulator: ContextAccumulator
  projectCwd: string
  sessionObjective: string | undefined
  queue: Queue
  dispatcherModel: string | undefined
  subprocessModel: string | undefined
  chatContext: string | undefined
}

function mergeAvailableContext(base: AvailableContext, chatContext: string | undefined): AvailableContext {
  if (!chatContext) return base
  return { ...base, chatHistory: chatContext }
}

export function createDispatcherCallback(opts: DispatcherCallbackDeps): DispatcherFn {
  const {
    maxRevisions, dispatcherTransport, contextIndexer, contextAccumulator,
    projectCwd, sessionObjective, queue, emit, workflowId,
    dispatcherModel, subprocessModel, chatContext,
  } = opts

  const realDispatcher = dispatcherTransport
    ? createStepDispatcher({
        transport: dispatcherTransport,
        emit,
        workflowId,
        configContext: {
          maxEvalCycles: maxRevisions ?? 1,
          worktreePath: projectCwd,
          projectCwd,
          subprocessModel: subprocessModel ?? "sonnet",
          dispatcherModel: dispatcherModel ?? "sonnet",
        },
        sessionBudget: { wall_clock_deadline: null, invocations_remaining: null, token_budget_remaining: null },
        availableContext: mergeAvailableContext(
          contextIndexer.getRelevantContext(),
          chatContext,
        ),
        sessionObjective,
      })
    : null

  return async (step, context) => {
    if (realDispatcher) {
      try {
        const dispatchContext = {
          accumulatedContext: contextAccumulator.getContext(),
          previousHandoff: context.previousHandoff,
          previousAssessment: context.previousAssessment,
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

    let prompt = buildStepMetadataPrompt(step)
    if (step.evaluationCriteria) prompt += `\nEvaluation: ${step.evaluationCriteria}`
    return { prompt, evaluationCriteria: null }
  }
}

import { createStepDispatcher, type MutationRequest } from "../workflows/queue/step-dispatcher"
import { buildStepMetadataPrompt } from "../workflows/queue/shared/step-prompt"
import { Log } from "../infra/log"
import { errorMessage } from "../infra/error-message"
import type { ContextIndexer } from "./memory/indexer"
import type { EmitFn } from "../infra/event-bus"
import type { ContextAccumulator } from "../workflows/queue/context-accumulator"
import type { Step, Queue } from "../workflows/queue/types"
import type { DispatcherTransport } from "../workflows/dispatcher/transport"
import type { EvalResult } from "../workflows/queue/executor-types"
import type { AvailableContext } from "../workflows/schemas"

const log = Log.create({ service: "dispatcher-callback" })

export interface DispatcherCallbackDeps {
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

export interface DispatcherResult {
  prompt: string
  evaluationCriteria: unknown | null
  mutationRequests?: MutationRequest[]
  sessionName?: string
}

export type DispatcherFn = (
  step: Step,
  context: { previousHandoff?: Record<string, unknown>; previousAssessment?: EvalResult | null },
) => Promise<DispatcherResult>

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
          contextIndexer.getRelevantContext({ stepType: "work", stepDescription: sessionObjective ?? "" }),
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
          previousHandoff: context.previousHandoff ?? null,
          previousAssessment: context.previousAssessment ?? null,
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

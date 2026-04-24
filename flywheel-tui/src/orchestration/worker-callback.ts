import { buildScaffolding } from "../workflows/queue/shared/scaffolding.js"
import { formatChecklistNumbered } from "../workflows/queue/shared/quality-checklist.js"
import {
  buildWorkerHandoffPath,
  ensureSessionDir,
  resolveSessionDir,
} from "../infra/paths.js"
import { Log } from "../infra/log.js"
import type { Engine } from "./engines/core/types.js"
import type { AuthContext } from "../infra/auth/auth-context.js"
import type { EmitFn } from "../infra/event-bus.js"
import type { InjectionQueue } from "./injection-queue.js"
import type { Step } from "../workflows/queue/types.js"
import { toolScopingToActions } from "../infra/workflow-types.js"
import type { NDJSONEvent } from "../infra/ndjson-event-types.js"
import { createNDJSONEvent } from "../infra/ndjson-event-factory.js"
import type { AskHookServer } from "./ask-hook/server.js"
import { buildAskHookSettings } from "./ask-hook/config.js"
import type { ToolAction } from "../infra/workflow-types.js"
import { createRunnerContext } from "./runner-context.js"
const log = Log.create({ service: "worker-callback" })

const SELF_REVIEW_STEP_TYPES = new Set(["work", "debug"])

function buildSelfReviewMessage(items: readonly string[] | undefined): string | null {
  if (items && items.length === 0) return null
  return `Review your changes before completing:

${formatChecklistNumbered(items)}

If you find issues: fix them now.
If everything looks good: confirm in your handoff.`
}

function buildStepPrompt(
  step: Step,
  prompt: string,
  sessionId: string,
  projectCwd: string,
): { fullPrompt: string; handoffPath: string } {
  const handoffPath = buildWorkerHandoffPath(sessionId, step.type, step.id, projectCwd)
  const scaffolding = buildScaffolding(step, { handoffPath })
  const parts: string[] = []
  if (scaffolding.preamble) parts.push(scaffolding.preamble)
  parts.push(prompt)
  if (scaffolding.postamble) parts.push(scaffolding.postamble)
  const fullPrompt = parts.join("\n\n")

  return { fullPrompt, handoffPath }
}

interface WorkerCallbackDeps {
  engine: Engine
  auth: AuthContext
  model: string
  effort?: string
  emit: EmitFn
  workflowId: string
  sessionId: string
  projectCwd: string
  workerCwd?: string
  injectionQueue: InjectionQueue
  observerChain?: { onTurnComplete(): string[]; reset(): void }
  askHookServer?: AskHookServer | null
}

interface WorkerCallbackResult {
  output: string
  handoffPath: string
  durationMs: number
  sessionId: string | undefined
}

export function createWorkerCallback(
  opts: WorkerCallbackDeps,
): (step: Step, prompt: string, signal?: AbortSignal, resumeSessionId?: string) => Promise<WorkerCallbackResult> {
  const {
    engine, model, effort, auth,
    emit, workflowId, sessionId, projectCwd,
    injectionQueue, observerChain, askHookServer,
  } = opts

  return async (step: Step, prompt: string, signal?: AbortSignal, resumeSessionId?: string): Promise<WorkerCallbackResult> => {
    observerChain?.reset()

    const { fullPrompt, handoffPath } = buildStepPrompt(step, prompt, sessionId, projectCwd)
    ensureSessionDir(sessionId, projectCwd)

    if (SELF_REVIEW_STEP_TYPES.has(step.type)) {
      const message = buildSelfReviewMessage(step.selfReviewItems)
      if (message !== null) injectionQueue.enqueue(message)
    }

    {
      const boundaryPayload = {
        type: "flywheel:worker_boundary",
        timestamp: new Date().toISOString(),
        workflowId,
        stepId: step.id,
      }
      emit("engine:ndjson", {
        workflowId,
        ndjsonEvent: createNDJSONEvent("flywheel:worker_boundary", boundaryPayload),
      })
    }

    const askEnabled = step.allowAskUser === true && askHookServer != null
    let toolActions = step.toolScoping ? toolScopingToActions(step.toolScoping) : undefined
    if (askEnabled && toolActions) {
      const nextActions: ToolAction[] = [...toolActions]
      if (!nextActions.includes("ask_user")) nextActions.push("ask_user")
      toolActions = nextActions
    }

    emit("engine:started", { workflowId, stepIndex: 0 })

    const ctx = createRunnerContext({
      engine,
      model,
      auth,
      effort,
      toolActions,
      ...(askEnabled && askHookServer && {
        extraEnv: { FLYWHEEL_ASK_SOCKET: askHookServer.socketPath },
        claudeSettings: buildAskHookSettings(),
      }),
      cwd: opts.workerCwd ?? projectCwd,
      sessionDir: resolveSessionDir(sessionId, projectCwd),
      handoffPath,
      signal,
      resumeSessionId,
      onEvent: (event: NDJSONEvent) => {
        emit("engine:ndjson", { workflowId, ndjsonEvent: event })
      },
      onTurnComplete: () => {
        const observerMessages = observerChain?.onTurnComplete() ?? []
        for (const msg of observerMessages) injectionQueue.enqueue(msg)

        const delivered = injectionQueue.drain()
        if (delivered !== null) {
          log.info("turn-boundary injection sent to worker", { userSteering: delivered.userSteering })
          ctx.send(delivered.message)
          if (!delivered.userSteering) {
            emit("engine:injected", { workflowId, message: delivered.message, origin: "system" })
          }
        } else {
          ctx.end()
        }
      },
    })

    ctx.send(fullPrompt)
    const engineResult = await ctx.done

    return {
      output: engineResult.failure
        ? (engineResult.failure.kind === "exit_code" ? "failed" : engineResult.failure.kind)
        : "completed",
      handoffPath,
      durationMs: engineResult.durationMs,
      sessionId: engineResult.sessionId,
    }
  }
}

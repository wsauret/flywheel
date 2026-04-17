import { buildScaffolding } from "../workflows/queue/shared/scaffolding.js"
import { formatChecklistNumbered } from "../workflows/queue/shared/quality-checklist.js"
import {
  buildWorkerHandoffPath,
  ensureSessionDir,
} from "../infra/paths.js"
import { Log } from "../infra/log.js"
import type { Engine } from "./engines/core/types.js"
import type { EmitFn } from "../infra/event-bus.js"
import type { InjectionQueue } from "./injection-queue.js"
import type { Step } from "../workflows/queue/types.js"
import { toolScopingToToolNames } from "../infra/workflow-types.js"
import type { NDJSONEvent } from "../infra/ndjson-event-types.js"
import { createNDJSONEvent } from "../infra/ndjson-event-factory.js"
import type { AskHookServer } from "./ask-hook/server.js"
import { buildAskHookSettings } from "./ask-hook/config.js"
const log = Log.create({ service: "worker-callback" })

/** Step types that get self-review injection at the first turn boundary. */
const SELF_REVIEW_STEP_TYPES = new Set(["work", "debug"])

function buildSelfReviewMessage(items: readonly string[] | undefined): string | null {
  // Empty array = dispatcher deliberately skipped self-review.
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
  /** Resolved engine for the worker tier. */
  engine: Engine
  /** Resolved model for the worker tier (tier > session-level > engine default). */
  model: string
  /** Resolved effort for the worker tier. */
  effort?: string
  emit: EmitFn
  workflowId: string
  sessionId: string
  projectCwd: string
  /** Override the worker cwd. Defaults to projectCwd.
   * Used by /test (temp dir isolation) and git worktrees (branch-specific working dir).
   * Session metadata/persistence stays in projectCwd; only the worker process runs here. */
  workerCwd?: string
  injectionQueue: InjectionQueue
  /** Observer chain for stream observers — created by workflow-runner, fed via EventBus.
   *  Worker-callback owns reset (per-step) and turn-complete (injection). */
  observerChain?: { onTurnComplete(): string[]; reset(): void }
  /** Session-scoped ask-hook server. When a step has allowAskUser, its runner
   *  gets this server's socket path via env and the --settings hook config. */
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
    engine, model, effort,
    emit, workflowId, sessionId, projectCwd,
    injectionQueue, observerChain, askHookServer,
  } = opts

  return async (step: Step, prompt: string, signal?: AbortSignal, resumeSessionId?: string): Promise<WorkerCallbackResult> => {
    observerChain?.reset()

    const { fullPrompt, handoffPath } = buildStepPrompt(step, prompt, sessionId, projectCwd)
    ensureSessionDir(sessionId, projectCwd)

    // Pre-enqueue the self-review so it drains on the first turn boundary —
    // no mutable "already injected" flag needed.
    if (SELF_REVIEW_STEP_TYPES.has(step.type)) {
      const message = buildSelfReviewMessage(step.selfReviewItems)
      if (message !== null) injectionQueue.enqueue(message)
    }

    // Boundary marker for transcript segmentation per worker invocation
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

    // Steps that opt in to AskUserQuestion need the tool in the allow-list
    // (otherwise --tools restriction would block it) and the hook wired.
    // When the step didn't set toolScoping at all, Claude exposes every tool
    // and no extension is needed.
    const askEnabled = step.allowAskUser === true && askHookServer != null
    let tools = step.toolScoping ? toolScopingToToolNames(step.toolScoping) : undefined
    if (askEnabled && tools && !tools.includes("AskUserQuestion")) {
      tools = [...tools, "AskUserQuestion"]
    }

    const runner = engine.createRunner({
      model,
      effort,
      tools,
      ...(askEnabled && askHookServer && {
        extraEnv: { FLYWHEEL_ASK_SOCKET: askHookServer.socketPath },
        claudeSettings: buildAskHookSettings(),
      }),
      cwd: opts.workerCwd ?? projectCwd,
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
          runner.send(delivered.message)
          if (!delivered.userSteering) {
            emit("engine:injected", { workflowId, message: delivered.message, origin: "system" })
          }
        } else {
          runner.end()
        }
      },
    })

    runner.send(fullPrompt)
    const engineResult = await runner.done

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

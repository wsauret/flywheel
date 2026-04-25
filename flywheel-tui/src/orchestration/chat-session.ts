import { createOutputSession, type OutputSession } from "./output-session.js"
import type { BudgetTracker } from "./session/budget-tracker-types.js"
import { wireSessionSubscribers, type SessionInfra } from "./session/create-session-infra.js"
import { createChatControls } from "./chat-controls.js"
import { EventBus, createEmit, type EmitFn, type Unsubscribe } from "../infra/event-bus.js"
import type { SessionEntryBase } from "./session-store-types.js"
import type { AnyBlock } from "../infra/output-blocks.js"
import type { NDJSONEvent } from "../infra/ndjson-event-types.js"
import type { MetricsWriter } from "./session/create-session-infra.js"
import type { Engine, EngineResult } from "./engines/core/types.js"
import type { AuthContext } from "../infra/auth/auth-context.js"
import type { AskHookServer } from "./ask-hook/server.js"
import { buildAskHookSettings } from "./ask-hook/config.js"
import { ChatSessionState, type ChatCallbacks, type WorkerLifecycle } from "./chat-types.js"
import { createRunnerContext, type RunnerContext } from "./runner-context.js"

type ChatInfra = Pick<SessionInfra, "budgetTracker" | "transcriptWriter" | "traceCollector">
import { Log } from "../infra/log.js"
import { errorMessage } from "../infra/error-message.js"
import { resolveSessionDir } from "../infra/paths.js"

const log = Log.create({ service: "chat" })

export interface ChatSession {
  send(text: string): void
  sendToolResult(toolUseId: string, content: string, isError?: boolean): void
  answerQuestion(toolUseId: string, answers: Record<string, string>): void
  cancelQuestion(toolUseId: string): void
  interrupt(): void
  end(): void
  readonly budgetTracker: BudgetTracker
  readonly outputSession: OutputSession
}

export interface ChatSessionDeps {
  projectCwd: string
  engine: Engine
  model: string
  auth: AuthContext
  infra: ChatInfra
  eventBus: EventBus
  sessionId: string
  updateEntry: (patch: Partial<SessionEntryBase>) => void
  metricsWriter?: MetricsWriter
  onFlush?: () => void
  engineSessionId?: string
  priorBlocks?: readonly AnyBlock[]
  askHookServer?: AskHookServer
}

// "Prompt is too long" is unrecoverable — every resume reloads the same
// oversized session. Clear the session ID so the next send() starts fresh.
function handleContextOverflow(
  event: NDJSONEvent,
  state: ChatSessionState,
  session: OutputSession,
  callbacks: ChatCallbacks,
): void {
  if (event.type !== "result") return

  const isError = event.data.is_error === true || (typeof event.data.subtype === "string" && event.data.subtype !== "success")
  const resultText = typeof event.data.result === "string" ? event.data.result : ""
  if (isError && /prompt is too long/i.test(resultText)) {
    log.warn("prompt too long — resetting session", { engineSessionId: state.engineSessionId })
    state.clearSessionId()
    session.pushSystemMessage(
      "Conversation too long for context window. Next message will start a fresh conversation.",
      Date.now(),
    )
    session.flush()
    callbacks.onWaiting(false)
  }
}

interface SetupOutputSessionInput {
  budgetTracker: BudgetTracker
  state: ChatSessionState
  updateEntry: (patch: Partial<SessionEntryBase>) => void
  onFlush?: () => void
  priorBlocks?: readonly AnyBlock[]
}

function setupOutputSession(input: SetupOutputSessionInput): OutputSession {
  const { budgetTracker, state, updateEntry, onFlush, priorBlocks } = input

  // Suppress model activity outside a user-initiated turn to prevent
  // "ghost thinking" during idle reconnections or process startup.
  const activityGatedUpdateEntry = (patch: Partial<SessionEntryBase>) => {
    if (patch.modelActivity && patch.modelActivity !== "idle") {
      if (state.turnPhase === "idle") return
      if (state.turnPhase === "awaiting-response") state.activateTurn()
    }
    updateEntry(patch)
  }

  const session = createOutputSession({
    updateEntry: activityGatedUpdateEntry,
    priorBlocks,
    onFlush: () => {
      const ctx = budgetTracker.getContextUtilization()
      if (!state.contextWarningFired && ctx.percent >= 70) {
        state.markContextWarningFired()
        log.warn("context window 70% full", { percent: ctx.percent, promptTokens: ctx.promptTokens, contextWindow: ctx.contextWindow })
        session.pushSystemMessage(
          `Context window is ${ctx.percent}% full. Consider starting a new conversation with /new to avoid losing context.`,
          Date.now(),
        )
      }

      onFlush?.()
    },
  })
  return session
}

function createWorkerLifecycle(
  deps: Pick<ChatSessionDeps, "engine" | "model" | "projectCwd" | "sessionId" | "auth"> & { askHookServer: AskHookServer | null },
  emit: EmitFn,
  session: OutputSession,
  callbacks: ChatCallbacks,
  state: ChatSessionState,
): WorkerLifecycle {
  const { engine, model, projectCwd, sessionId, askHookServer, auth } = deps

  async function spawnWorker(resumeSessionId?: string, messageToSend?: string): Promise<void> {
    emit("engine:started", { workflowId: sessionId, stepIndex: 0 })
    if (messageToSend) state.beginTurn()

    // `ctx` is declared up-front so the done/error callbacks can compare it
    // against `state.runner` — the closure-scoped identity guard below
    // replaces the prior raw-runner equality check.
    let ctx: RunnerContext | null = null

    const handleRunnerDone = (result: EngineResult) => {
      if (result.sessionId) state.captureSessionId(result.sessionId)
      if (result.failure && result.failure.kind !== "aborted") {
        log.warn("chat runner failed", { kind: result.failure.kind, message: "message" in result.failure ? result.failure.message : undefined })
        const detail = "message" in result.failure ? `: ${result.failure.message}` : ""
        session.pushSystemMessage(`Failed to connect to model provider${detail}`, Date.now())
        session.flush()
      } else if (result.failure) {
        log.info("chat runner aborted")
      }

      const hadFailure = !!result.failure
      if (session.sessionId) state.captureSessionId(session.sessionId)
      session.flushParser()
      session.flush()

      // If a newer runner has taken over (e.g. after interrupt spawned its
      // replacement), this old context's cleanup must not touch shared state —
      // doing so would detach the active runner and flip the UI to idle while
      // the new runner is still working. Identity-scoped on `ctx` because
      // interrupt() synchronously detaches the old runner, spawnWorker runs
      // its sync prefix attaching the new ctx, and only afterward does this
      // stale promise callback fire — so `state.runner` is the new ctx here,
      // not null.
      if (state.runner !== ctx) {
        if (state.ended) callbacks.onEnded()
        return
      }

      state.detachRunner()

      // A runner resolving without a failure but with a non-idle turn phase
      // means the loop terminated without completing the turn — a true
      // unexpected exit. The in-process harness can't hit this path (every
      // exit goes through onTurnComplete or resolves with a failure), but
      // out-of-process engines can. Failures (api_error, aborted, etc.)
      // already surfaced their own message — reset state without re-spawning.
      const unexpectedExit = !hadFailure && state.turnPhase !== "idle"

      if (unexpectedExit) {
        log.warn("runner exited mid-turn — auto-reconnecting")
        state.completeTurn()
        callbacks.onWaiting(false)
        session.resetActivity()
        session.pushSystemMessage("Agent process exited unexpectedly. Reconnecting\u2026", Date.now())
        session.flush()

        if (!state.ended && state.engineSessionId) {
          callbacks.onWaiting(true)
          spawnWorker(state.engineSessionId, "Your process exited unexpectedly. Continue where you left off.").catch((err) => {
            log.warn("auto-reconnect after unexpected exit failed", { error: errorMessage(err) })
            callbacks.onWaiting(false)
          })
        }
      } else if (state.turnPhase !== "idle") {
        state.completeTurn()
        callbacks.onWaiting(false)
        session.resetActivity()
      }

      if (state.ended) callbacks.onEnded()
    }

    const handleRunnerError = (err: unknown) => {
      log.warn("chat process error", { error: errorMessage(err) })
      session.pushSystemMessage(`Failed to connect to model provider: ${errorMessage(err)}`, Date.now())
      session.flush()
      handleRunnerDone({ durationMs: 0, failure: { kind: "api_error", message: errorMessage(err) } })
    }

    ctx = createRunnerContext({
      engine,
      model,
      // Chat is conversational, not a sprint worker step. Default to "high"
      // instead of letting the adapter fall through to "max" — max-effort
      // adaptive thinking on every turn pushes time-to-first-token into the
      // multi-minute range with large prompts.
      effort: "high",
      cwd: projectCwd,
      sessionDir: resolveSessionDir(sessionId, projectCwd),
      resumeSessionId,
      auth,
      extraEnv: askHookServer ? { FLYWHEEL_ASK_SOCKET: askHookServer.socketPath } : undefined,
      claudeSettings: askHookServer ? buildAskHookSettings() : undefined,
      onEvent: (event) => {
        emit("engine:ndjson", { workflowId: sessionId, ndjsonEvent: event })
        if (event.type === "compaction") {
          const data = event.data as { state: string; duration_ms?: number }
          if (data.state === "start") {
            session.startCompaction(Date.now())
          } else {
            session.completeCompaction(data.state === "done", data.duration_ms ?? 0, Date.now())
          }
          session.flush()
          return
        }
        session.writeStdout(event.raw + "\n")
      },
      onTurnComplete: () => {
        if (session.sessionId) state.captureSessionId(session.sessionId)
        state.completeTurn()
        session.flushContextRun(Date.now())
        callbacks.onWaiting(false)
        session.resetActivity()
        session.flush()
        return null
      },
      takeNextQueued: () => session.takeNextQueued(),
      hasQueuedInput: () => session.hasQueued(),
      drainQueued: () => session.drainQueued(),
    })
    ctx.done.then(handleRunnerDone).catch(handleRunnerError)
    state.attachRunner(ctx)

    if (messageToSend) {
      session.notifySpawned(Date.now())
      ctx.send(messageToSend)
    }
  }

  return { spawnWorker }
}

export async function createChatSession(
  callbacks: ChatCallbacks,
  deps: ChatSessionDeps,
): Promise<ChatSession> {
  const {
    projectCwd, engine, model, infra,
    eventBus, sessionId, updateEntry: rawUpdateEntry,
    askHookServer,
  } = deps
  const emit = createEmit(eventBus)

  const state = new ChatSessionState(deps.engineSessionId)

  const eventUnsubs: Unsubscribe[] = []
  eventUnsubs.push(...wireSessionSubscribers(eventBus, emit, sessionId, infra, deps.metricsWriter))

  const session = setupOutputSession({
    budgetTracker: infra.budgetTracker, state,
    updateEntry: rawUpdateEntry,
    onFlush: deps.onFlush,
    priorBlocks: deps.priorBlocks,
  })

  eventUnsubs.push(
    eventBus.subscribeToType("engine:ndjson", (e) => {
      handleContextOverflow(e.ndjsonEvent, state, session, callbacks)
    }),
  )

  const lifecycle = createWorkerLifecycle(
    { engine, model, projectCwd, sessionId, auth: deps.auth, askHookServer: askHookServer ?? null },
    emit, session, callbacks, state,
  )

  const controls = createChatControls({
    lifecycle, session, callbacks, eventUnsubs, state,
  })

  function answerQuestion(toolUseId: string, answers: Record<string, string>): void {
    session.answerQuestion(toolUseId, answers)
    if (askHookServer) askHookServer.deliver(toolUseId, answers)
  }

  function cancelQuestion(toolUseId: string): void {
    session.cancelQuestion(toolUseId)
    if (askHookServer) askHookServer.cancel(toolUseId)
  }

  return {
    send: controls.send,
    sendToolResult: controls.sendToolResult,
    answerQuestion,
    cancelQuestion,
    interrupt: controls.interrupt,
    end: controls.end,
    budgetTracker: infra.budgetTracker,
    outputSession: session,
  }
}

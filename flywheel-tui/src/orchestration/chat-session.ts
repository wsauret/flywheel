import { createOutputSession, type OutputSession } from "./output-session.js"
import type { BudgetTracker } from "./session/budget-tracker-types.js"
import { wireSessionSubscribers, type SessionInfra } from "./session/create-session-infra.js"
import { createChatControls } from "./chat-controls.js"
import { EventBus, createEmit, type EmitFn, type Unsubscribe } from "../infra/event-bus.js"
import type { SessionEntryBase } from "./session-store-types.js"
import type { AnyBlock } from "../infra/output-blocks.js"
import type { NDJSONEvent } from "../infra/ndjson-event-types.js"
import type { MetricsWriter } from "./session/create-session-infra.js"
import type { Engine, EngineRunner } from "./engines/core/types.js"

type ChatInfra = Pick<SessionInfra, "budgetTracker" | "transcriptWriter" | "traceCollector">
import { Log } from "../infra/log.js"
import { errorMessage } from "../infra/error-message.js"

const log = Log.create({ service: "chat" })

export interface ChatCallbacks {
  onWaiting: (waiting: boolean) => void
  onError: (message: string) => void
  onEnded: () => void
}

export interface ChatSession {
  send(text: string): void
  interrupt(): void
  end(): void
  readonly budgetTracker: BudgetTracker
  readonly outputSession: OutputSession
}

// Three-state turn machine:
// - idle: no turn in flight, safe to end/reconnect
// - awaiting-response: message sent, waiting for first assistant chunk
// - agent-active: assistant is streaming, tools are running
// Consumers: activityGatedUpdateEntry (suppress ghost-thinking), handleWorkerExit
// (detect mid-turn crash), chat-controls send() (mark injections as pending).
type ChatTurnPhase = "idle" | "awaiting-response" | "agent-active"

// Why a class with private fields: the getters enforce read-only access from
// external code (chat-controls, worker lifecycle) while the named mutation
// methods (beginTurn, markEnded) provide semantic state transitions without
// exposing raw field assignments. Not a ref-bag — it's a state machine.
//
// Why _ended and _engineSessionId overlap with the store: these are
// runner-level guards used synchronously in chat-controls (send, interrupt,
// end) without awaiting a store read. The store's versions are the persistent
// source of truth; these are in-process guards that prevent operations on a
// runner that's already shutting down or needs to reconnect.
export class ChatSessionState {
  private _runner: EngineRunner | null = null
  private _ended = false
  private _engineSessionId: string | null
  private _turnPhase: ChatTurnPhase = "idle"
  private _contextWarningFired = false

  constructor(engineSessionId?: string) {
    this._engineSessionId = engineSessionId ?? null
  }

  get runner() { return this._runner }
  get ended() { return this._ended }
  get engineSessionId() { return this._engineSessionId }
  get turnPhase() { return this._turnPhase }
  get contextWarningFired() { return this._contextWarningFired }

  beginTurn() { this._turnPhase = "awaiting-response" }
  activateTurn() { this._turnPhase = "agent-active" }
  completeTurn() { this._turnPhase = "idle" }
  markEnded() { this._ended = true }
  markContextWarningFired() { this._contextWarningFired = true }
  captureSessionId(id: string) { this._engineSessionId = id }
  clearSessionId() { this._engineSessionId = null }
  attachRunner(runner: EngineRunner) { this._runner = runner }
  detachRunner() { this._runner = null }
}

export interface ChatSessionDeps {
  projectCwd: string
  engine: Engine
  model: string
  infra: ChatInfra
  eventBus: EventBus
  chatId: string
  updateEntry: (patch: Partial<SessionEntryBase>) => void
  metricsWriter?: MetricsWriter
  onFlush?: () => void
  engineSessionId?: string
  priorBlocks?: readonly AnyBlock[]
}

/**
 * Detect unrecoverable "Prompt is too long" from the engine. When the
 * accumulated conversation exceeds the context window, every resume
 * reloads the same oversized session and fails instantly. Clear the
 * session ID so the next send() spawns a fresh runner.
 */
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
  emit: EmitFn
  chatId: string
  state: ChatSessionState
  updateEntry: (patch: Partial<SessionEntryBase>) => void
  onFlush?: () => void
  priorBlocks?: readonly AnyBlock[]
}

function setupOutputSession(input: SetupOutputSessionInput): OutputSession {
  const { budgetTracker, emit, chatId, state, updateEntry, onFlush, priorBlocks } = input

  // Suppress model activity that arrives outside a user-initiated turn.
  // Prevents "ghost thinking" during idle reconnections or process startup.
  // Transitions from "awaiting-response" to "agent-active" on first non-idle activity.
  const activityGatedUpdateEntry = (patch: Partial<SessionEntryBase>) => {
    if (patch.modelActivity && patch.modelActivity !== "idle") {
      if (state.turnPhase === "idle") return
      if (state.turnPhase === "awaiting-response") state.activateTurn()
    }
    updateEntry(patch)
  }

  const session = createOutputSession({
    updateEntry: activityGatedUpdateEntry,
    emit,
    workflowId: chatId,
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
  // Why not `return createOutputSession(...)`: the onFlush callback references
  // `session` to push a context warning — the variable must be in scope.
  return session
}

export interface WorkerLifecycle {
  spawnWorker(resumeSessionId?: string, messageToSend?: string): Promise<void>
}

function createWorkerLifecycle(
  deps: Pick<ChatSessionDeps, "engine" | "model" | "projectCwd" | "chatId">,
  emit: EmitFn,
  session: OutputSession,
  callbacks: ChatCallbacks,
  state: ChatSessionState,
): WorkerLifecycle {
  const { engine, model, projectCwd, chatId } = deps

  async function spawnWorker(resumeSessionId?: string, messageToSend?: string): Promise<void> {
    emit("engine:started", { workflowId: chatId, stepIndex: 0 })
    if (messageToSend) state.beginTurn()

    const runner = engine.createRunner({
      model,
      cwd: projectCwd,
      resumeSessionId,
      onEvent: (event) => {
        // Emit to bus for infra subscribers (budget tracker, transcript writer)
        emit("engine:ndjson", { workflowId: chatId, ndjsonEvent: event })
        // Feed raw NDJSON to output session for rendering
        session.writeStdout(event.raw + "\n")
      },
      onTurnComplete: () => {
        if (session.sessionId) state.captureSessionId(session.sessionId)
        state.completeTurn()
        session.resolvePendingMessages()
        session.flushContextRun(Date.now())
        callbacks.onWaiting(false)
        session.resetActivity()
        session.flush()
      },
    })

    state.attachRunner(runner)

    // Only send content if there's a message — an idle runner waits for the
    // first send() rather than responding to a no-op greeting and exiting.
    if (messageToSend) {
      runner.send(messageToSend)
    }

    const handleRunnerDone = () => {
      if (session.sessionId) state.captureSessionId(session.sessionId)
      session.flushParser()
      session.flush()
      state.detachRunner()

      if (state.turnPhase !== "idle") {
        log.warn("runner exited mid-turn — auto-reconnecting")
        state.completeTurn()
        callbacks.onWaiting(false)
        session.resetActivity()
        session.pushSystemMessage("Agent process exited unexpectedly. Reconnecting\u2026", Date.now())
        session.flush()

        // Auto-reconnect and resume: spawn a new runner with a continue
        // prompt so the agent picks up where it left off instead of
        // sitting idle waiting for the user to notice.
        if (!state.ended && state.engineSessionId) {
          callbacks.onWaiting(true)
          spawnWorker(state.engineSessionId, "Your process exited unexpectedly. Continue where you left off.").catch((err) => {
            log.warn("auto-reconnect after unexpected exit failed", { error: errorMessage(err) })
            callbacks.onWaiting(false)
          })
        }
      }

      if (state.ended) callbacks.onEnded()
    }

    runner.done.then(
      (result) => {
        if (result.sessionId) state.captureSessionId(result.sessionId)
        handleRunnerDone()
      },
    ).catch((err) => {
      log.warn("chat process error", { error: errorMessage(err) })
      handleRunnerDone()
    })
  }

  return { spawnWorker }
}

export async function createChatSession(
  callbacks: ChatCallbacks,
  deps: ChatSessionDeps,
  initialMessage?: string,
): Promise<ChatSession> {
  const {
    projectCwd, engine, model, infra,
    eventBus, chatId, updateEntry: rawUpdateEntry,
  } = deps
  const emit = createEmit(eventBus)

  const state = new ChatSessionState(deps.engineSessionId)

  const eventUnsubs: Unsubscribe[] = []
  eventUnsubs.push(...wireSessionSubscribers(eventBus, emit, chatId, infra, deps.metricsWriter))

  const session = setupOutputSession({
    budgetTracker: infra.budgetTracker, emit, chatId, state,
    updateEntry: rawUpdateEntry,
    onFlush: deps.onFlush,
    priorBlocks: deps.priorBlocks,
  })

  eventUnsubs.push(
    eventBus.subscribeToType("engine:ndjson", (e) => {
      const event = e.ndjsonEvent

      if (event.type === "user") {
        session.resolvePendingMessages()
        return
      }

      handleContextOverflow(event, state, session, callbacks)
    }),
  )

  const lifecycle = createWorkerLifecycle(
    { engine, model, projectCwd, chatId },
    emit, session, callbacks, state,
  )

  const controls = createChatControls({
    lifecycle, session, callbacks, eventUnsubs, state,
  })

  const msg = initialMessage?.trim() || undefined
  if (msg) callbacks.onWaiting(true)

  await lifecycle.spawnWorker(state.engineSessionId ?? undefined, msg)

  return { send: controls.send, interrupt: controls.interrupt, end: controls.end, budgetTracker: infra.budgetTracker, outputSession: session }
}

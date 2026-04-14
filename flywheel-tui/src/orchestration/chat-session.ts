import { formatStdinMessage } from "./engines/subprocess/stdin-format.js"
import { getEngine } from "./engines/core/registry.js"
import { createOutputSession, type OutputSession } from "./output-session.js"
import type { BudgetTracker } from "./session/budget-tracker-types.js"
import { wireSessionSubscribers, type SessionInfra } from "./session/create-session-infra.js"
import { createChatControls } from "./chat-controls.js"
import { EventBus, createEmit, type EmitFn, type Unsubscribe } from "../infra/event-bus.js"
import type { ProcessSpawner, StdinHandle } from "./engines/subprocess/spawner.js"
import type { SessionEntryBase } from "./session-store-types.js"
import type { NDJSONEvent } from "../infra/subprocess-types.js"
import type { MetricsWriter } from "./session/create-session-infra.js"

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

type ChatTurnPhase = "idle" | "awaiting-response" | "agent-active"

// Why a class with private fields: the getters enforce read-only access from
// external code (chat-controls, worker lifecycle) while the named mutation
// methods (beginTurn, markEnded) provide semantic state transitions without
// exposing raw field assignments. Not a ref-bag — it's a state machine.
//
// Why _ended and _claudeSessionId overlap with the store: these are
// subprocess-level guards used synchronously in chat-controls (send, interrupt,
// end) without awaiting a store read. The store's versions are the persistent
// source of truth; these are in-process guards that prevent operations on a
// subprocess that's already shutting down or needs to reconnect.
export class ChatSessionState {
  private _stdinHandle: StdinHandle | null = null
  private _workerPid: number | undefined
  private _ended = false
  private _claudeSessionId: string | null
  private _turnPhase: ChatTurnPhase = "idle"
  private _contextWarningFired = false

  constructor(claudeSessionId?: string) {
    this._claudeSessionId = claudeSessionId ?? null
  }

  get stdinHandle() { return this._stdinHandle }
  get workerPid() { return this._workerPid }
  get ended() { return this._ended }
  get claudeSessionId() { return this._claudeSessionId }
  get turnPhase() { return this._turnPhase }
  get contextWarningFired() { return this._contextWarningFired }

  beginTurn() { this._turnPhase = "awaiting-response" }
  activateTurn() { this._turnPhase = "agent-active" }
  completeTurn() { this._turnPhase = "idle" }
  markEnded() { this._ended = true }
  markContextWarningFired() { this._contextWarningFired = true }
  captureSessionId(id: string) { this._claudeSessionId = id }
  clearSessionId() { this._claudeSessionId = null }
  attachWorker(pid: number | undefined, handle: StdinHandle | null) {
    this._workerPid = pid
    this._stdinHandle = handle
  }
  detachWorker() { this._stdinHandle = null }
}

export interface ChatSessionDeps {
  projectCwd: string
  engine: ReturnType<typeof getEngine>
  model: string
  spawner: ProcessSpawner
  infra: ChatInfra
  eventBus: EventBus
  chatId: string
  updateEntry: (patch: Partial<SessionEntryBase>) => void
  metricsWriter?: MetricsWriter
  onFlush?: () => void
  claudeSessionId?: string
}

/**
 * Detect unrecoverable "Prompt is too long" from Claude Code. When the
 * accumulated conversation exceeds the context window, every --resume
 * reloads the same oversized session and fails instantly. Clear the
 * session ID so the next send() spawns a fresh worker.
 */
function handlePromptTooLong(
  event: NDJSONEvent,
  state: ChatSessionState,
  session: OutputSession,
  callbacks: ChatCallbacks,
): void {
  if (event.type !== "result") return

  const isError = event.data.is_error === true || (typeof event.data.subtype === "string" && event.data.subtype !== "success")
  const resultText = typeof event.data.result === "string" ? event.data.result : ""
  if (isError && /prompt is too long/i.test(resultText)) {
    log.warn("prompt too long — resetting session", { claudeSessionId: state.claudeSessionId })
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
}

function setupOutputSession(input: SetupOutputSessionInput): OutputSession {
  const { budgetTracker, emit, chatId, state, updateEntry, onFlush } = input

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
  deps: Pick<ChatSessionDeps, "engine" | "model" | "spawner" | "projectCwd" | "chatId">,
  emit: EmitFn,
  session: OutputSession,
  callbacks: ChatCallbacks,
  state: ChatSessionState,
): WorkerLifecycle {
  const { engine, model, spawner, projectCwd, chatId } = deps
  const engineId = engine.metadata.id

  async function spawnWorker(resumeSessionId?: string, messageToSend?: string): Promise<void> {
    emit("subprocess:spawned", { workflowId: chatId, stepIndex: 0 })
    if (messageToSend) state.beginTurn()
    const engineCmd = engine.buildCommand({ model, resumeSessionId })

    // Only send content if there's a message — an empty pipe lets Claude idle and
    // wait rather than responding to a no-op greeting and potentially exiting.
    const initialContent = messageToSend ? formatStdinMessage(messageToSend) : undefined

    const spawnResult = await spawner.spawn(engineCmd.command, engineCmd.args, {
      cwd: projectCwd,
      stdin: initialContent,
      stdinPipe: true,
      onStdout: (chunk) => session.writeStdout(chunk),
      onStderr: (chunk) => {
        if (chunk.trim()) session.writeStderr(chunk, Date.now())
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

    state.attachWorker(spawnResult.pid, spawnResult.stdinHandle ?? null)

    const handleWorkerExit = () => {
      if (session.sessionId) state.captureSessionId(session.sessionId)
      session.flushParser()
      session.flush()
      state.detachWorker()

      if (state.turnPhase !== "idle") {
        log.warn("worker exited mid-turn — resetting session state")
        state.completeTurn()
        callbacks.onWaiting(false)
        session.resetActivity()
        session.pushSystemMessage("Agent process exited unexpectedly. Send a message to reconnect.", Date.now())
        session.flush()
      }

      if (state.ended) callbacks.onEnded()
    }

    spawnResult.result.then(handleWorkerExit).catch((err) => {
      log.warn("chat process error", { error: errorMessage(err) })
      handleWorkerExit()
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
    projectCwd, engine, model, spawner, infra,
    eventBus, chatId, updateEntry: rawUpdateEntry,
  } = deps
  const emit = createEmit(eventBus)

  const state = new ChatSessionState(deps.claudeSessionId)

  const eventUnsubs: Unsubscribe[] = []
  eventUnsubs.push(...wireSessionSubscribers(eventBus, emit, chatId, infra, deps.metricsWriter))

  const session = setupOutputSession({
    budgetTracker: infra.budgetTracker, emit, chatId, state,
    updateEntry: rawUpdateEntry,
    onFlush: deps.onFlush,
  })

  eventUnsubs.push(
    eventBus.subscribeToType("subprocess:ndjson", (e) => {
      const event = e.ndjsonEvent

      if (event.type === "user") {
        session.resolvePendingMessages()
        return
      }

      handlePromptTooLong(event, state, session, callbacks)
    }),
  )

  const lifecycle = createWorkerLifecycle(
    { engine, model, spawner, projectCwd, chatId },
    emit, session, callbacks, state,
  )

  const controls = createChatControls({
    lifecycle, session, callbacks, eventUnsubs, state,
  })

  const msg = initialMessage?.trim() || undefined
  if (msg) callbacks.onWaiting(true)

  await lifecycle.spawnWorker(state.claudeSessionId ?? undefined, msg)

  return { send: controls.send, interrupt: controls.interrupt, end: controls.end, budgetTracker: infra.budgetTracker, outputSession: session }
}

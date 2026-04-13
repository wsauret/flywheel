import { formatStdinMessage } from "./engines/subprocess/stdin-format"
import { getEngine } from "./engines/core/registry"
import { createOutputSession, type OutputSession } from "./output-session"
import type { BudgetTracker } from "./session/budget-tracker-types.js"
import { wireSessionSubscribers } from "./session/create-session-infra"
import type { TraceCollector } from "./session/trace-collector"
import type { TranscriptWriter } from "./session/transcript-writer"
import { createChatControls } from "./chat-controls"
import { EventBus, createEmit, type EmitFn, type Unsubscribe } from "../infra/event-bus"
import type { ProcessSpawner, StdinHandle } from "./engines/subprocess/spawner"
import type { SessionEntryBase } from "./session-store-types"
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

export type ChatTurnPhase = "idle" | "awaiting-response" | "agent-active"

export interface ChatSessionState {
  stdinHandle: StdinHandle | null
  workerPid: number | undefined
  ended: boolean
  claudeSessionId: string | null
  turnPhase: ChatTurnPhase
  contextWarningFired: boolean
}

export interface ChatSessionDeps {
  projectCwd: string
  engine: ReturnType<typeof getEngine>
  engineName: string
  model: string
  spawner: ProcessSpawner
  traceCollector: TraceCollector | null
  budgetTracker: BudgetTracker
  transcriptWriter: TranscriptWriter | null
  eventBus: EventBus
  chatId: string
  updateEntry: (patch: Partial<SessionEntryBase>) => void
  metricsWriter?: import("./session/create-session-infra").MetricsWriter
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
  event: import("../infra/subprocess-types").NDJSONEvent,
  state: ChatSessionState,
  session: OutputSession,
  callbacks: ChatCallbacks,
): void {
  if (event.type !== "result") return

  const isError = event.data.is_error === true || (typeof event.data.subtype === "string" && event.data.subtype !== "success")
  const resultText = typeof event.data.result === "string" ? event.data.result : ""
  if (isError && /prompt is too long/i.test(resultText)) {
    log.warn("prompt too long — resetting session", { claudeSessionId: state.claudeSessionId })
    state.claudeSessionId = null
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
      if (state.turnPhase === "awaiting-response") state.turnPhase = "agent-active"
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
        state.contextWarningFired = true
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

export interface WorkerLifecycle {
  spawnWorker(resumeSessionId?: string, messageToSend?: string): Promise<void>
}

interface WorkerLifecycleInput {
  engine: ReturnType<typeof getEngine>
  engineName: string
  model: string
  spawner: ProcessSpawner
  projectCwd: string
  emit: EmitFn
  chatId: string
  session: OutputSession
  callbacks: ChatCallbacks
  state: ChatSessionState
  rawUpdateEntry: (patch: Partial<SessionEntryBase>) => void
}

function createWorkerLifecycle(input: WorkerLifecycleInput): WorkerLifecycle {
  const { engine, engineName, model, spawner, projectCwd, emit, chatId, session, callbacks, state, rawUpdateEntry } = input

  async function spawnWorker(resumeSessionId?: string, messageToSend?: string): Promise<void> {
    emit("subprocess:spawned", { workflowId: chatId, stepIndex: 0 })
    if (messageToSend) state.turnPhase = "awaiting-response"
    const engineCmd = engine.buildCommand({ model, resumeSessionId })

    // Only send content if there's a message — an empty pipe lets Claude idle and
    // wait rather than responding to a no-op greeting and potentially exiting.
    const initialContent = messageToSend ? formatStdinMessage(messageToSend) : undefined

    const spawnResult = await spawner.spawn(engineCmd.command, engineCmd.args, {
      cwd: projectCwd,
      stdin: initialContent,
      stdinPipe: true,
      onStdout: (chunk) => session.writeStdout(chunk, engineName),
      onStderr: (chunk) => {
        if (chunk.trim()) session.writeStderr(chunk, Date.now())
      },
      onTurnComplete: () => {
        if (session.sessionId) state.claudeSessionId = session.sessionId
        state.turnPhase = "idle"
        session.resolvePendingMessages()
        session.flushContextRun(Date.now())
        callbacks.onWaiting(false)
        // Why explicit idle here: turn-complete is a lifecycle event, not a builder
        // activity change. The builder stops receiving events but doesn't know the
        // turn ended — it retains its last activity ("generating" / "tool_executing").
        rawUpdateEntry({ modelActivity: "idle" })
        session.flush()
      },
    })

    state.stdinHandle = spawnResult.stdinHandle ?? null
    state.workerPid = spawnResult.pid

    const handleWorkerExit = () => {
      if (session.sessionId) state.claudeSessionId = session.sessionId
      session.flushParser()
      session.flush()
      state.stdinHandle = null

      if (state.turnPhase !== "idle") {
        log.warn("worker exited mid-turn — resetting session state")
        state.turnPhase = "idle"
        callbacks.onWaiting(false)
        rawUpdateEntry({ modelActivity: "idle" }) // worker-exit: same lifecycle rationale as turn-complete above
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
    projectCwd, engine, engineName, model, spawner, traceCollector,
    budgetTracker, transcriptWriter, eventBus, chatId, updateEntry: rawUpdateEntry,
  } = deps
  const emit = createEmit(eventBus)

  const state: ChatSessionState = {
    stdinHandle: null,
    workerPid: undefined,
    ended: false,
    claudeSessionId: deps.claudeSessionId ?? null,
    turnPhase: "idle",
    contextWarningFired: false,
  }

  const eventUnsubs: Unsubscribe[] = []
  eventUnsubs.push(...wireSessionSubscribers(eventBus, emit, chatId, { budgetTracker, transcriptWriter, traceCollector }, deps.metricsWriter))

  const session = setupOutputSession({
    budgetTracker, emit, chatId, state,
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

  const lifecycle = createWorkerLifecycle({
    engine, engineName, model, spawner, projectCwd, emit, chatId,
    session, callbacks, state, rawUpdateEntry,
  })

  const controls = createChatControls({
    lifecycle, session, callbacks, eventUnsubs, state, rawUpdateEntry,
  })

  const hasInitialMessage = initialMessage != null && initialMessage.trim().length > 0
  if (hasInitialMessage) callbacks.onWaiting(true)

  await lifecycle.spawnWorker(state.claudeSessionId ?? undefined, hasInitialMessage ? initialMessage : undefined)

  return { send: controls.send, interrupt: controls.interrupt, end: controls.end, budgetTracker, outputSession: session }
}

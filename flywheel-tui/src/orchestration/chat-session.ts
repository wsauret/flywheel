/**
 * Chat Mode — Interactive back-and-forth with an engine process.
 *
 * Spawns an engine process with stdin pipe open. User sends messages, the
 * engine responds, pipe stays open for multi-turn conversation. Engine
 * selection is driven by flywheel.toml config via prepareWorkflowDeps().
 *
 * Uses OutputSession for rendering (same blocks as workflow mode).
 *
 * Worker lifecycle vs. chat session lifecycle are intentionally decoupled:
 * Claude Code's process may exit on its own (idle timeout) without ending the
 * TUI chat session. The session stays open and lazily reconnects via
 * --resume <sessionId> when the user sends the next message.
 *
 * Single responsibility: manage the chat process lifecycle and output pipeline.
 * The shell provides callbacks for state updates — chat doesn't know about UI.
 */

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

// ── Public interface ──

export interface ChatCallbacks {
  onWaiting: (waiting: boolean) => void
  onError: (message: string) => void
  onEnded: () => void
}

export interface ChatSession {
  /** Send a user message to Claude. */
  send(text: string): void
  /** Interrupt the active worker without ending the session. Next send() reconnects via --resume. */
  interrupt(): void
  /** End the chat session (close stdin pipe, stop process). */
  end(): void
  /** Get the budget tracker. */
  readonly budgetTracker: BudgetTracker
  /** Get the output session (for reading blocks). */
  readonly outputSession: OutputSession
}

// ── Chat turn state machine ──

/**
 * Discriminated phase for the chat subprocess turn lifecycle.
 *
 * Replaces the previous three separate booleans (agentActive,
 * userTurnInProgress, modelActivity gating) with a single authoritative value.
 *
 * - "idle": No user turn in progress. Non-idle modelActivity is suppressed.
 * - "awaiting-response": User sent a message, agent hasn't started yet.
 * - "agent-active": Agent is producing output (thinking/generating).
 */
export type ChatTurnPhase = "idle" | "awaiting-response" | "agent-active"

/** Mutable state shared across pipeline, worker lifecycle, and controls. */
export interface ChatSessionState {
  stdinHandle: StdinHandle | null
  workerPid: number | undefined
  ended: boolean
  /** Claude Code session ID — captured after first turn, used for --resume. */
  claudeSessionId: string | null
  /** Current turn phase — single source of truth for activity gating. */
  turnPhase: ChatTurnPhase
  contextWarningFired: boolean
}

// ── Factory ──

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

// ── Helpers ──
// setupOutputSession and createWorkerLifecycle are module-private
// decompositions that share mutable ChatSessionState with the main factory.
// createChatControls is extracted to chat-controls.ts.

// ── Helper: prompt-too-long recovery ──

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

// ── Helper 1: setupOutputSession ──

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
      // Context warning at 70%
      const ctx = budgetTracker.getContextUtilization()
      if (!state.contextWarningFired && ctx.percent >= 70) {
        state.contextWarningFired = true
        log.warn("context window 70% full", { percent: ctx.percent, promptTokens: ctx.promptTokens, contextWindow: ctx.contextWindow })
        session.pushSystemMessage(
          `Context window is ${ctx.percent}% full. Consider starting a new conversation with /new to avoid losing context.`,
          Date.now(),
        )
      }

      // Caller's onFlush (e.g. output persistence scheduling)
      onFlush?.()
    },
  })

  // Chat-specific NDJSON event handlers (user echo detection, context-too-long)
  // are wired to the EventBus in the main factory — not here, because they need
  // access to the outer eventBus instance.

  return session
}

// ── Helper 2: createWorkerLifecycle ──

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
  /** Raw (ungated) updateEntry — for setting idle which always passes through. */
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
        rawUpdateEntry({ modelActivity: "idle" })
        session.flush()
      },
    })

    state.stdinHandle = spawnResult.stdinHandle ?? null
    state.workerPid = spawnResult.pid

    // When the worker exits, keep the TUI session alive so the user can resume.
    // Only call end() if the session was explicitly terminated by the user.
    const handleWorkerExit = () => {
      if (session.sessionId) state.claudeSessionId = session.sessionId
      session.flushParser()
      session.flush()
      state.stdinHandle = null

      // If the worker exited while a user turn was in progress (crash, unexpected exit),
      // reset session state so the UI doesn't get stuck "active" with a dead worker.
      if (state.turnPhase !== "idle") {
        log.warn("worker exited mid-turn — resetting session state")
        state.turnPhase = "idle"
        callbacks.onWaiting(false)
        rawUpdateEntry({ modelActivity: "idle" })
        session.pushSystemMessage("Agent process exited unexpectedly. Send a message to reconnect.", Date.now())
        session.flush()
      }

      if (state.ended) callbacks.onEnded()
      // else: worker exited idle — session stays open, next send() will reconnect
    }

    spawnResult.result.then(handleWorkerExit).catch((err) => {
      log.warn("chat process error", { error: errorMessage(err) })
      handleWorkerExit()
    })
  }

  return { spawnWorker }
}

// ── Main Factory ──

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

  // ── Wire EventBus subscribers ──

  const eventUnsubs: Unsubscribe[] = []

  // Budget, transcript, tracing, metrics → store — unified wiring (same path as workflow mode)
  eventUnsubs.push(...wireSessionSubscribers(eventBus, emit, chatId, { budgetTracker, transcriptWriter, traceCollector }, deps.metricsWriter))

  // 1. Setup OutputSession (rendering + flush + budget metrics)
  const session = setupOutputSession({
    budgetTracker, emit, chatId, state,
    updateEntry: rawUpdateEntry,
    onFlush: deps.onFlush,
  })

  // Chat-specific NDJSON event handlers — user echo detection + context-too-long
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

  // 2. Create worker lifecycle (spawn, reconnection, idle-exit)
  const lifecycle = createWorkerLifecycle({
    engine, engineName, model, spawner, projectCwd, emit, chatId,
    session, callbacks, state, rawUpdateEntry,
  })

  // 3. Create controls (send, interrupt, end)
  const controls = createChatControls({
    lifecycle, session, callbacks, eventUnsubs, state, rawUpdateEntry,
  })

  // ── Initial spawn ──
  const hasInitialMessage = initialMessage != null && initialMessage.trim().length > 0
  if (hasInitialMessage) callbacks.onWaiting(true)

  await lifecycle.spawnWorker(state.claudeSessionId ?? undefined, hasInitialMessage ? initialMessage : undefined)

  return { send: controls.send, interrupt: controls.interrupt, end: controls.end, budgetTracker, outputSession: session }
}

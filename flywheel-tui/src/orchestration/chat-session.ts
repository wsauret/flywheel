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

import { randomUUID } from "node:crypto"
import { BunProcessSpawner } from "./engines/subprocess/bun-spawner"
import { formatStdinMessage } from "./engines/subprocess/stdin-format"
import { getEngine } from "./engines/core/registry"
import { createOutputSession, type OutputSession } from "./output-session"
import { createBudgetTracker, type BudgetTracker } from "./session/budget-tracker"
import { prepareWorkflowDeps } from "./engines/workflow-deps"
import { wireSessionSubscribers } from "./session/create-session-infra"
import { contextWindowForModel } from "./engines/providers/claude-context"
import type { TraceCollector } from "./session/trace-collector"
import { createTranscriptWriter, type TranscriptWriter } from "./session/transcript-writer"
import { feedChatEventToTrace } from "./chat-tracing"
import { EventBus, createEmit, type EmitFn, type Unsubscribe } from "../infra/event-bus"
import type { ProcessSpawner, StdinHandle } from "./engines/subprocess/spawner"
import type { SessionEntryBase } from "./session-store"
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

// ── Shared mutable state ──

/** Mutable state shared across pipeline, worker lifecycle, and controls. */
interface ChatSessionState {
  stdinHandle: StdinHandle | null
  workerPid: number | undefined
  ended: boolean
  /** Claude Code session ID — captured after first turn, used for --resume. */
  claudeSessionId: string | null
  agentActive: boolean
  /** Gate: only forward model activity when a user-triggered turn is in progress. */
  userTurnInProgress: boolean
  contextWarningFired: boolean
}

// ── Factory ──

export interface ChatSessionOptions {
  projectCwd?: string
  deps?: ReturnType<typeof prepareWorkflowDeps>
  spawner?: ProcessSpawner
  traceCollector?: TraceCollector
  /** Inject a shared budget tracker (from createSessionInfra). When omitted, a fresh one is created. */
  budgetTracker?: BudgetTracker
  /** Inject a shared transcript writer (from createSessionInfra). When omitted, created if tracing enabled. */
  transcriptWriter?: TranscriptWriter | null
  /** Inject an EventBus (e.g. for testing). When omitted, a fresh one is created. */
  eventBus?: EventBus
  /** Store mutator — OutputSession writes outputBlocks and modelActivity here. */
  updateEntry?: (patch: Partial<SessionEntryBase>) => void
  /** Called on every 16ms tick regardless of block changes. Use for display-refresh work (budget metrics, persistence). */
  onFlush?: () => void
}

// ── Helpers ──
// The three helpers below (setupOutputSession, createWorkerLifecycle,
// createChatControls) are module-private decompositions of createChatSession.
// Each owns a cohesive concern (output rendering, process lifecycle, user
// controls). They share mutable state via ChatSessionState rather than
// being split into separate files, because they form a single logical unit
// with a shared lifecycle — extracting to files would add import noise
// without improving cohesion.

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

  // Gate updateEntry: only forward model activity when a user-triggered turn
  // is in progress. "idle" always passes through.
  const gatedUpdateEntry = (patch: Partial<SessionEntryBase>) => {
    if (patch.modelActivity && patch.modelActivity !== "idle" && !state.userTurnInProgress) return
    if (patch.modelActivity && patch.modelActivity !== "idle") state.agentActive = true
    updateEntry(patch)
  }

  const session = createOutputSession({
    updateEntry: gatedUpdateEntry,
    emit,
    workflowId: chatId,
    onFlush: () => {
      // Budget metrics → store
      updateEntry({
        tokens: budgetTracker.getTokensUsed(),
        cost: budgetTracker.getTotalCost(),
        contextPercent: budgetTracker.getContextUtilization().percent,
      })

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

interface WorkerLifecycle {
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
    if (messageToSend) state.userTurnInProgress = true
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
        // Capture Claude's session ID on every turn so reconnect is always possible
        if (session.sessionId) state.claudeSessionId = session.sessionId
        state.agentActive = false
        state.userTurnInProgress = false
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
      if (state.userTurnInProgress) {
        log.warn("worker exited mid-turn — resetting session state")
        state.agentActive = false
        state.userTurnInProgress = false
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

// ── Helper 3: createChatControls ──

interface ChatControls {
  send(text: string): void
  interrupt(): void
  end(): void
}

interface ChatControlsInput {
  lifecycle: WorkerLifecycle
  session: OutputSession
  callbacks: ChatCallbacks
  eventUnsubs: Unsubscribe[]
  state: ChatSessionState
  /** Raw (ungated) updateEntry — for setting idle which always passes through. */
  rawUpdateEntry: (patch: Partial<SessionEntryBase>) => void
}

function createChatControls(input: ChatControlsInput): ChatControls {
  const { lifecycle, session, callbacks, eventUnsubs, state, rawUpdateEntry } = input

  function interrupt() {
    if (state.ended) return
    log.info("chat interrupted by user", { pid: state.workerPid })

    // Capture session ID before killing the worker
    if (session.sessionId) state.claudeSessionId = session.sessionId

    // Close stdin pipe if still open
    if (state.stdinHandle?.isOpen) {
      state.stdinHandle.close()
    }
    state.stdinHandle = null

    // Kill the worker process — SIGTERM first, escalate to SIGKILL after 2s
    if (state.workerPid) {
      const pid = state.workerPid
      try { process.kill(pid, "SIGTERM") } catch { /* already gone */ }
      setTimeout(() => {
        try { process.kill(pid, "SIGKILL") } catch { /* already gone */ }
      }, 2_000)
    }

    // Always reset session state — this is the escape hatch, it must work
    callbacks.onWaiting(false)
    rawUpdateEntry({ modelActivity: "idle" })
    state.agentActive = false
    state.userTurnInProgress = false
    session.resolvePendingMessages()
    session.pushSystemMessage("Interrupted", Date.now())
    session.flush()

    // Eagerly reconnect so the worker is warm when the user sends the next message
    if (state.claudeSessionId) {
      lifecycle.spawnWorker(state.claudeSessionId).catch((err) => {
        log.warn("eager reconnect after interrupt failed", { error: errorMessage(err) })
      })
    }
  }

  function end() {
    if (state.ended) return
    state.ended = true
    // Unsubscribe EventBus listeners — no more infra event processing.
    eventUnsubs.forEach((u) => u())
    // Flush any remaining data before disposing (mirrors handleWorkerExit)
    session.flushParser()
    session.flush()
    session.dispose()
    // Resource disposal (budget flush, trace finalize, transcript close) is
    // handled by chat-runner's disposeSessionResources() — not duplicated here.
    if (state.stdinHandle?.isOpen) {
      // Worker is alive — close the pipe and let the process exit naturally.
      // onEnded fires from the spawnResult.result handler once the process exits.
      state.stdinHandle.close()
      state.stdinHandle = null
    } else {
      // Worker already idle-exited — fire immediately.
      state.stdinHandle = null
      callbacks.onEnded()
    }
  }

  function send(text: string) {
    if (state.ended) { log.warn("chat send after ended"); return }

    // Message is "pending" only when there's an active agent turn in progress
    // (i.e. we're injecting into a running conversation). After interrupt or
    // idle-exit, the agent isn't working so the message is the start of a new turn.
    const isPending = state.agentActive && state.stdinHandle?.isOpen === true
    state.userTurnInProgress = true
    callbacks.onWaiting(true)
    const now = Date.now()
    session.notifyInjected(text, now, isPending)
    // No explicit flush needed — OutputSession's 16ms interval handles it

    if (state.stdinHandle?.isOpen) {
      // Normal path: worker is alive, write directly to the pipe
      const ok = state.stdinHandle.write(formatStdinMessage(text))
      log.info("chat message sent", { length: text.length, written: ok })
      return
    }

    // Worker exited idle — reconnect via --resume and send the message as initial content
    if (state.claudeSessionId) {
      log.info("chat worker idle-exited, reconnecting via --resume", { sessionId: state.claudeSessionId })
      lifecycle.spawnWorker(state.claudeSessionId, text).catch((err) => {
        log.warn("chat reconnect failed", { error: errorMessage(err) })
        callbacks.onWaiting(false)
        callbacks.onError(`Reconnect failed: ${errorMessage(err)}`)
      })
      return
    }

    // No worker and no session ID to resume — this should only happen before the
    // first turn completes (session ID not yet emitted by Claude Code).
    log.warn("chat send: no active worker and no session ID to resume")
    callbacks.onWaiting(false)
  }

  return { send, interrupt, end }
}

// ── Main Factory ──

export async function createChatSession(
  callbacks: ChatCallbacks,
  initialMessage?: string,
  overrides?: ChatSessionOptions,
): Promise<ChatSession> {
  const projectCwd = overrides?.projectCwd ?? process.cwd()
  const deps = overrides?.deps ?? prepareWorkflowDeps()
  const engineName = deps.config.engine
  const engine = getEngine(engineName)
  const model = deps.config.subprocess?.model ?? deps.config.model ?? engine.metadata.defaultModel

  const spawner = overrides?.spawner ?? new BunProcessSpawner()
  const traceCollector = overrides?.traceCollector ?? null
  const chatId = randomUUID()

  // Budget tracker — use injected instance (from createSessionInfra) or create a fresh one
  const budgetTracker = overrides?.budgetTracker ?? createBudgetTracker({ sessionId: chatId, baseDir: projectCwd })

  // Seed the context window from the configured model name so percentage
  // calculation works from turn 1. The `[1m]` suffix (1M context) is only
  // present in the config string — Claude Code strips it in NDJSON output.
  // The authoritative value from "result" events overwrites this if it arrives.
  const estimatedWindow = contextWindowForModel(model)
  if (estimatedWindow > 0) budgetTracker.updateContextUtilization(0, estimatedWindow)

  // Transcript writer — use injected instance or create if tracing enabled
  const transcriptWriter: TranscriptWriter | null = overrides?.transcriptWriter !== undefined
    ? overrides.transcriptWriter
    : (deps.config.tracing?.enabled
        ? createTranscriptWriter({ sessionId: chatId, baseDir: projectCwd })
        : null)

  // EventBus — infra subscribers (budget, transcript, tracing) are wired below,
  // matching the workflow-mode pattern in executor-factory.ts.
  const eventBus = overrides?.eventBus ?? new EventBus()
  const emit = createEmit(eventBus)

  // Raw updateEntry — passed by caller (chat-runner), defaults to no-op.
  const rawUpdateEntry: (patch: Partial<SessionEntryBase>) => void = overrides?.updateEntry ?? (() => {})

  // Shared mutable state — all helpers read/write through this
  const state: ChatSessionState = {
    stdinHandle: null,
    workerPid: undefined,
    ended: false,
    claudeSessionId: null,
    agentActive: false,
    userTurnInProgress: false,
    contextWarningFired: false,
  }

  // ── Wire EventBus subscribers ──

  const eventUnsubs: Unsubscribe[] = []

  // Budget + transcript: shared wiring (ADR-006: single source of truth)
  eventUnsubs.push(...wireSessionSubscribers(eventBus, { budgetTracker, transcriptWriter }))

  // Tracing: tool-call spans from NDJSON events
  if (traceCollector) {
    const toolSpanMap = new Map<string, string>()
    eventUnsubs.push(
      eventBus.subscribeToType("subprocess:ndjson", (e) => {
        feedChatEventToTrace(e.ndjsonEvent, traceCollector, toolSpanMap)
      }),
    )
  }

  // 1. Setup OutputSession (rendering + flush + budget metrics)
  const session = setupOutputSession({
    budgetTracker, emit, chatId, state,
    updateEntry: rawUpdateEntry,
    onFlush: overrides?.onFlush,
  })

  // Chat-specific NDJSON event handlers — user echo detection + context-too-long
  eventUnsubs.push(
    eventBus.subscribeToType("subprocess:ndjson", (e) => {
      const event = e.ndjsonEvent

      // Claude Code echoes user messages as {"type":"user"} — this confirms
      // the CLI received our stdin injection. Resolve any queued messages.
      if (event.type === "user") {
        session.resolvePendingMessages()
      }

      // Detect unrecoverable "Prompt is too long" from Claude Code. When the
      // accumulated conversation exceeds the context window, every --resume
      // reloads the same oversized session and fails instantly. Clear the
      // session ID so the next send() spawns a fresh worker.
      const data = event.data as Record<string, unknown>
      if (data.type === "result") {
        const isError = data.is_error === true || (typeof data.subtype === "string" && data.subtype !== "success")
        const resultText = typeof data.result === "string" ? data.result : ""
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

  await lifecycle.spawnWorker(undefined, hasInitialMessage ? initialMessage : undefined)

  return { send: controls.send, interrupt: controls.interrupt, end: controls.end, budgetTracker, outputSession: session }
}

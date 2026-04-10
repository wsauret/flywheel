/**
 * Chat Mode — Interactive back-and-forth with an engine process.
 *
 * Spawns an engine process with stdin pipe open. User sends messages, the
 * engine responds, pipe stays open for multi-turn conversation. Engine
 * selection is driven by flywheel.toml config via prepareWorkflowDeps().
 *
 * Uses the structured output pipeline for rendering (same blocks as workflow mode).
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
import { createOutputPipeline, type OutputPipeline } from "./output-pipeline"
import { StructuredOutputBuilder } from "../infra/output/structured-output-builder"
import { createBudgetTracker, type BudgetTracker } from "./session/budget-tracker"
import { prepareWorkflowDeps } from "./engines/workflow-deps"
import { wireSessionSubscribers } from "./session/create-session-infra"
import { contextWindowForModel } from "./engines/providers/claude-context"
import type { TraceCollector } from "./session/trace-collector"
import { createTranscriptWriter, type TranscriptWriter } from "./session/transcript-writer"
import { feedChatEventToTrace } from "./chat-tracing"
import { EventBus, createEmit, type EmitFn, type Unsubscribe } from "../infra/event-bus"
import type { ProcessSpawner, StdinHandle } from "./engines/subprocess/spawner"
import type { AnyBlock } from "../infra/output-blocks"
import type { ModelActivity } from "../infra/events"
import type { NDJSONParser } from "./engines/subprocess/ndjson-parser"
import type { StructuredEventParser } from "../infra/output/structured-event-parser"
import { Log } from "../infra/log.js"
import { errorMessage } from "../infra/error-message.js"

const log = Log.create({ service: "chat" })

// ── Public interface ──

export interface ChatCallbacks {
  onBlocks: (blocks: AnyBlock[]) => void
  onWaiting: (waiting: boolean) => void
  onTokens: (tokens: number) => void
  onCost: (cost: number) => void
  onContextPercent: (percent: number) => void
  onModelActivity: (activity: ModelActivity) => void
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
  /** Get the structured output builder (for reading blocks). */
  readonly builder: StructuredOutputBuilder
  /** Get the budget tracker. */
  readonly budgetTracker: BudgetTracker
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
}

// ── Helpers ──
// The three helpers below (setupChatPipeline, createWorkerLifecycle,
// createChatControls) are module-private decompositions of createChatSession.
// Each owns a cohesive concern (output rendering, process lifecycle, user
// controls). They share mutable state via ChatSessionState rather than
// being split into separate files, because they form a single logical unit
// with a shared lifecycle — extracting to files would add import noise
// without improving cohesion.

// ── Helper 1: setupChatPipeline ──

interface ChatPipelineResult {
  pipeline: OutputPipeline
  parser: NDJSONParser
  builder: StructuredOutputBuilder
  eventParser: StructuredEventParser
  stopFlush: () => void
}

interface SetupChatPipelineInput {
  callbacks: ChatCallbacks
  engineName: string
  /** Still needed for flush-timer polling (getTokensUsed, getTotalCost, getContextUtilization). */
  budgetTracker: BudgetTracker
  emit: EmitFn
  chatId: string
  state: ChatSessionState
}

function setupChatPipeline(input: SetupChatPipelineInput): ChatPipelineResult {
  const { callbacks, engineName, budgetTracker, emit, chatId, state } = input

  const pipeline = createOutputPipeline({
    onModelActivityChange: (activity) => {
      if (!state.userTurnInProgress && activity !== "idle") return
      callbacks.onModelActivity(activity)
      if (activity !== "idle") state.agentActive = true
    },
  })
  const { parser, builder, eventParser } = pipeline

  parser.onEvent = (event) => {
    // Claude Code echoes user messages as {"type":"user"} — this confirms
    // the CLI received our stdin injection. Resolve any queued messages.
    if (event.type === "user") {
      if (builder.resolvePendingMessages()) {
        callbacks.onBlocks(builder.getBlocks())
      }
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
        builder.pushSystemMessage(
          "Conversation too long for context window. Next message will start a fresh conversation.",
          Date.now(),
        )
        callbacks.onBlocks(builder.getBlocks())
        callbacks.onWaiting(false)
      }
    }

    // Emit to EventBus — infra subscribers (budget, transcript, tracing)
    // handle their own processing, matching the workflow-mode pattern.
    emit("subprocess:ndjson", { workflowId: chatId, ndjsonEvent: event })

    // Output rendering stays in the pipeline — it's the display path, not infra.
    eventParser.dispatch(event, engineName)
  }

  // Flush builder → callbacks at 16ms
  const stopFlush = pipeline.startFlush(() => {
    callbacks.onBlocks(builder.getBlocks())
    callbacks.onTokens(budgetTracker.getTokensUsed())
    callbacks.onCost(budgetTracker.getTotalCost())

    const ctx = budgetTracker.getContextUtilization()
    callbacks.onContextPercent(ctx.percent)

    if (!state.contextWarningFired && ctx.percent >= 70) {
      state.contextWarningFired = true
      log.warn("context window 70% full", { percent: ctx.percent, promptTokens: ctx.promptTokens, contextWindow: ctx.contextWindow })
      builder.pushSystemMessage(
        `Context window is ${ctx.percent}% full. Consider starting a new conversation with /new to avoid losing context.`,
        Date.now(),
      )
      callbacks.onBlocks(builder.getBlocks())
    }
  }, 16)

  return { pipeline, parser, builder, eventParser, stopFlush }
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
  parser: NDJSONParser
  builder: StructuredOutputBuilder
  callbacks: ChatCallbacks
  state: ChatSessionState
}

function createWorkerLifecycle(input: WorkerLifecycleInput): WorkerLifecycle {
  const { engine, engineName, model, spawner, projectCwd, emit, chatId, parser, builder, callbacks, state } = input

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
      onStdout: (chunk) => parser.write(chunk),
      onStderr: (chunk) => {
        if (chunk.trim()) builder.pushText(chunk, Date.now())
      },
      onTurnComplete: () => {
        // Capture Claude's session ID on every turn so reconnect is always possible
        if (parser.sessionId) state.claudeSessionId = parser.sessionId
        state.agentActive = false
        state.userTurnInProgress = false
        builder.resolvePendingMessages()
        builder.flushContextRun(Date.now())
        callbacks.onWaiting(false)
        callbacks.onModelActivity("idle")
        if (builder.hasChanged()) callbacks.onBlocks(builder.getBlocks())
      },
    })

    state.stdinHandle = spawnResult.stdinHandle ?? null
    state.workerPid = spawnResult.pid

    // When the worker exits, keep the TUI session alive so the user can resume.
    // Only call end() if the session was explicitly terminated by the user.
    const handleWorkerExit = () => {
      if (parser.sessionId) state.claudeSessionId = parser.sessionId
      parser.flush()
      if (builder.hasChanged()) callbacks.onBlocks(builder.getBlocks())
      state.stdinHandle = null

      // If the worker exited while a user turn was in progress (crash, unexpected exit),
      // reset session state so the UI doesn't get stuck "active" with a dead worker.
      if (state.userTurnInProgress) {
        log.warn("worker exited mid-turn — resetting session state")
        state.agentActive = false
        state.userTurnInProgress = false
        callbacks.onWaiting(false)
        callbacks.onModelActivity("idle")
        builder.pushSystemMessage("Agent process exited unexpectedly. Send a message to reconnect.", Date.now())
        if (builder.hasChanged()) callbacks.onBlocks(builder.getBlocks())
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
  engineName: string
  parser: NDJSONParser
  builder: StructuredOutputBuilder
  pipeline: OutputPipeline
  stopFlush: () => void
  callbacks: ChatCallbacks
  eventUnsubs: Unsubscribe[]
  state: ChatSessionState
}

function createChatControls(input: ChatControlsInput): ChatControls {
  const { lifecycle, engineName, parser, builder, pipeline, stopFlush,
    callbacks, eventUnsubs, state } = input

  function interrupt() {
    if (state.ended) return
    log.info("chat interrupted by user", { pid: state.workerPid })

    // Capture session ID before killing the worker
    if (parser.sessionId) state.claudeSessionId = parser.sessionId

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
    callbacks.onModelActivity("idle")
    state.agentActive = false
    state.userTurnInProgress = false
    builder.resolvePendingMessages()
    builder.pushSystemMessage("Interrupted", Date.now())
    if (builder.hasChanged()) callbacks.onBlocks(builder.getBlocks())

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
    stopFlush()
    pipeline.dispose()
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
    builder.pushUserMessage(text, now, isPending)
    builder.notifyThinkingStarted(now)
    callbacks.onBlocks(builder.getBlocks())

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

  // 1. Setup output pipeline (rendering only — infra handled by EventBus above)
  const { pipeline, parser, builder, stopFlush } = setupChatPipeline({
    callbacks, engineName, budgetTracker, emit, chatId, state,
  })

  // 2. Create worker lifecycle (spawn, reconnection, idle-exit)
  const lifecycle = createWorkerLifecycle({
    engine, engineName, model, spawner, projectCwd, emit, chatId, parser, builder, callbacks, state,
  })

  // 3. Create controls (send, interrupt, end)
  const controls = createChatControls({
    lifecycle, engineName, parser, builder, pipeline, stopFlush,
    callbacks, eventUnsubs, state,
  })

  // ── Initial spawn ──
  const hasInitialMessage = initialMessage != null && initialMessage.trim().length > 0
  if (hasInitialMessage) callbacks.onWaiting(true)

  await lifecycle.spawnWorker(undefined, hasInitialMessage ? initialMessage : undefined)

  return { send: controls.send, interrupt: controls.interrupt, end: controls.end, builder, budgetTracker }
}

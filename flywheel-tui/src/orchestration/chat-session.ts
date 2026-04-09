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
import { extractContextUpdate } from "./engines/providers/claude-context"
import { prepareWorkflowDeps } from "./engines/workflow-deps"
import type { TraceCollector } from "./session/trace-collector"
import { createTranscriptWriter, type TranscriptWriter } from "./session/transcript-writer"
import { feedChatEventToTrace } from "./chat-tracing"
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
}

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
  budgetTracker: BudgetTracker
  transcriptWriter: TranscriptWriter | null
  traceCollector: TraceCollector | null
  toolSpanMap: Map<string, string>
  state: ChatSessionState
}

function setupChatPipeline(input: SetupChatPipelineInput): ChatPipelineResult {
  const { callbacks, engineName, budgetTracker, transcriptWriter, traceCollector, toolSpanMap, state } = input

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

    // Engine-specific context utilization extraction
    const ctxUpdate = extractContextUpdate(event)
    if (ctxUpdate) {
      budgetTracker.updateContextUtilization(ctxUpdate.promptTokens, ctxUpdate.contextWindow)
    }

    eventParser.dispatch(event, engineName)
    budgetTracker.handleEvent(event)
    transcriptWriter?.handleEvent(event)
    if (traceCollector) feedChatEventToTrace(event, traceCollector, toolSpanMap)
  }

  // Flush builder → callbacks at 16ms
  const stopFlush = pipeline.startFlush(() => {
    callbacks.onBlocks(builder.getBlocks())
    callbacks.onTokens(budgetTracker.getTokensUsed())
    callbacks.onCost(budgetTracker.getTotalCost())

    const ctx = budgetTracker.getContextUtilization()
    callbacks.onContextPercent(ctx.percent)

    if (!state.contextWarningFired && ctx.percent >= 85) {
      state.contextWarningFired = true
      log.warn("context window 85% full", { percent: ctx.percent, promptTokens: ctx.promptTokens, contextWindow: ctx.contextWindow })
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
  budgetTracker: BudgetTracker
  parser: NDJSONParser
  builder: StructuredOutputBuilder
  callbacks: ChatCallbacks
  state: ChatSessionState
}

function createWorkerLifecycle(input: WorkerLifecycleInput): WorkerLifecycle {
  const { engine, engineName, model, spawner, projectCwd, budgetTracker, parser, builder, callbacks, state } = input

  async function spawnWorker(resumeSessionId?: string, messageToSend?: string): Promise<void> {
    budgetTracker.onNewSubprocess()
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
        callbacks.onWaiting(false)
        callbacks.onModelActivity("idle")
        if (builder.hasChanged()) callbacks.onBlocks(builder.getBlocks())
      },
    })

    state.stdinHandle = spawnResult.stdinHandle ?? null
    state.workerPid = spawnResult.pid

    // When the worker exits, keep the TUI session alive so the user can resume.
    // Only call end() if the session was explicitly terminated by the user.
    spawnResult.result.then(() => {
      if (parser.sessionId) state.claudeSessionId = parser.sessionId
      parser.flush()
      if (builder.hasChanged()) callbacks.onBlocks(builder.getBlocks())
      state.stdinHandle = null
      if (state.ended) callbacks.onEnded()
      // else: worker exited idle — session stays open, next send() will reconnect
    }).catch((err) => {
      log.warn("chat process error", { error: errorMessage(err) })
      state.stdinHandle = null
      if (state.ended) callbacks.onEnded()
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
  budgetTracker: BudgetTracker
  traceCollector: TraceCollector | null
  transcriptWriter: TranscriptWriter | null
  state: ChatSessionState
}

function createChatControls(input: ChatControlsInput): ChatControls {
  const { lifecycle, engineName, parser, builder, pipeline, stopFlush,
    callbacks, budgetTracker, traceCollector, transcriptWriter, state } = input

  function interrupt() {
    if (state.ended || !state.stdinHandle?.isOpen) return
    log.info("chat interrupted by user", { pid: state.workerPid })
    // Kill the worker process and immediately respawn via --resume so
    // the next send() doesn't have to wait for the cold-start.
    if (parser.sessionId) state.claudeSessionId = parser.sessionId
    state.stdinHandle.close()
    state.stdinHandle = null
    if (state.workerPid) {
      try { process.kill(state.workerPid, "SIGTERM") } catch { /* already gone */ }
    }
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
    stopFlush()
    pipeline.dispose()
    if (traceCollector) {
      traceCollector.finalize("ok")
      traceCollector.dispose()
    }
    transcriptWriter?.dispose()
    budgetTracker.flush()
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
    builder.pushUserMessage(text, Date.now(), isPending)
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
  const toolSpanMap = new Map<string, string>()
  const sessionId = randomUUID()

  // Budget tracker — use injected instance (from createSessionInfra) or create a fresh one
  const budgetTracker = overrides?.budgetTracker ?? createBudgetTracker({ sessionId, baseDir: projectCwd })

  // Transcript writer — use injected instance or create if tracing enabled
  const transcriptWriter: TranscriptWriter | null = overrides?.transcriptWriter !== undefined
    ? overrides.transcriptWriter
    : (deps.config.tracing?.enabled
        ? createTranscriptWriter({ sessionId, baseDir: projectCwd })
        : null)

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

  // 1. Setup output pipeline
  const { pipeline, parser, builder, stopFlush } = setupChatPipeline({
    callbacks, engineName, budgetTracker, transcriptWriter, traceCollector, toolSpanMap, state,
  })

  // 2. Create worker lifecycle (spawn, reconnection, idle-exit)
  const lifecycle = createWorkerLifecycle({
    engine, engineName, model, spawner, projectCwd, budgetTracker, parser, builder, callbacks, state,
  })

  // 3. Create controls (send, interrupt, end)
  const controls = createChatControls({
    lifecycle, engineName, parser, builder, pipeline, stopFlush,
    callbacks, budgetTracker, traceCollector, transcriptWriter, state,
  })

  // ── Initial spawn ──
  const hasInitialMessage = initialMessage != null && initialMessage.trim().length > 0
  if (hasInitialMessage) callbacks.onWaiting(true)

  await lifecycle.spawnWorker(undefined, hasInitialMessage ? initialMessage : undefined)

  return { send: controls.send, interrupt: controls.interrupt, end: controls.end, builder, budgetTracker }
}

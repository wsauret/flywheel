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
import { NDJSONParser } from "./engines/subprocess/ndjson-parser"
import { StructuredOutputBuilder } from "../infra/output/structured-output-builder"
import { StructuredEventParser } from "../infra/output/structured-event-parser"
import { createBudgetTracker, type BudgetTracker } from "./session/budget-tracker"
import { extractContextUpdate } from "./engines/providers/claude-context"
import { prepareWorkflowDeps } from "./engines/workflow-deps"
import type { TraceCollector } from "./session/trace-collector"
import { createTranscriptWriter, type TranscriptWriter } from "./session/transcript-writer"
import { feedChatEventToTrace } from "./chat-tracing"
import type { ProcessSpawner, StdinHandle } from "./engines/subprocess/spawner"
import type { AnyBlock } from "../infra/output-blocks"
import type { ModelActivity } from "../infra/events"
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

// ── Factory ──

export interface ChatSessionOptions {
  projectCwd?: string
  deps?: ReturnType<typeof prepareWorkflowDeps>
  spawner?: ProcessSpawner
  traceCollector?: TraceCollector
}

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

  // Budget tracker
  const budgetTracker = createBudgetTracker({ sessionId, baseDir: projectCwd })

  // Transcript writer (session-scoped, survives worker reconnects)
  const transcriptWriter: TranscriptWriter | null = deps.config.tracing?.enabled
    ? createTranscriptWriter({ sessionId, baseDir: projectCwd })
    : null

  // Structured output pipeline — shared across worker respawns
  const builder = new StructuredOutputBuilder()
  let agentActive = false
  // Gate: only forward model activity when a user-triggered turn is in progress.
  // Prevents subprocess startup noise (stderr, init events) from starting the timer.
  let userTurnInProgress = false
  builder.onModelActivityChange = (activity) => {
    if (!userTurnInProgress && activity !== "idle") return
    callbacks.onModelActivity(activity)
    if (activity !== "idle") agentActive = true
  }
  const eventParser = new StructuredEventParser({ builder })
  const ndjsonParser = new NDJSONParser()

  ndjsonParser.onEvent = (event) => {
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
        log.warn("prompt too long — resetting session", { claudeSessionId })
        claudeSessionId = null
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
  ndjsonParser.onRawText = (text) => {
    if (text.trim().length > 0) builder.pushText(text + "\n", Date.now())
  }

  // Context warning state — only fire the 85% system message once per session
  let contextWarningFired = false

  // Flush builder → callbacks at 16ms
  const flushInterval = setInterval(() => {
    if (builder.hasChanged()) callbacks.onBlocks(builder.getBlocks())
    callbacks.onTokens(budgetTracker.getTokensUsed())
    callbacks.onCost(budgetTracker.getTotalCost())

    const ctx = budgetTracker.getContextUtilization()
    callbacks.onContextPercent(ctx.percent)

    if (!contextWarningFired && ctx.percent >= 85) {
      contextWarningFired = true
      log.warn("context window 85% full", { percent: ctx.percent, promptTokens: ctx.promptTokens, contextWindow: ctx.contextWindow })
      builder.pushSystemMessage(
        `Context window is ${ctx.percent}% full. Consider starting a new conversation with /new to avoid losing context.`,
        Date.now(),
      )
      callbacks.onBlocks(builder.getBlocks())
    }
  }, 16)

  // Stale agent detection is handled by the builder (auto-completes after 5s of inactivity)

  let stdinHandle: StdinHandle | null = null
  let workerPid: number | undefined
  let ended = false
  // The Claude Code session ID emitted in its NDJSON output. Captured after
  // the first turn and used to reconnect via --resume when the worker exits idle.
  let claudeSessionId: string | null = null

  // ── Worker spawn ──

  // Spawn (or respawn) a Claude Code worker process.
  // resumeSessionId: pass the captured Claude session ID to reconnect an idle session.
  // messageToSend: written to stdin immediately after spawn (used for reconnect path
  //                where the user message triggered the respawn).
  async function spawnWorker(resumeSessionId?: string, messageToSend?: string): Promise<void> {
    budgetTracker.onNewSubprocess()
    if (messageToSend) userTurnInProgress = true
    const engineCmd = engine.buildCommand({ model, resumeSessionId })

    // Only send content if there's a message — an empty pipe lets Claude idle and
    // wait rather than responding to a no-op greeting and potentially exiting.
    const initialContent = messageToSend ? formatStdinMessage(engineName, messageToSend) : undefined

    const spawnResult = await spawner.spawn(engineCmd.command, engineCmd.args, {
      cwd: projectCwd,
      stdin: initialContent,
      stdinPipe: true,
      onStdout: (chunk) => ndjsonParser.write(chunk),
      onStderr: (chunk) => {
        if (chunk.trim()) builder.pushText(chunk, Date.now())
      },
      onTurnComplete: () => {
        // Capture Claude's session ID on every turn so reconnect is always possible
        if (ndjsonParser.sessionId) claudeSessionId = ndjsonParser.sessionId
        agentActive = false
        userTurnInProgress = false
        builder.resolvePendingMessages()
        callbacks.onWaiting(false)
        callbacks.onModelActivity("idle")
        if (builder.hasChanged()) callbacks.onBlocks(builder.getBlocks())
      },
    })

    stdinHandle = spawnResult.stdinHandle ?? null
    workerPid = spawnResult.pid

    // When the worker exits, keep the TUI session alive so the user can resume.
    // Only call end() if the session was explicitly terminated by the user.
    spawnResult.result.then(() => {
      if (ndjsonParser.sessionId) claudeSessionId = ndjsonParser.sessionId
      ndjsonParser.flush()
      if (builder.hasChanged()) callbacks.onBlocks(builder.getBlocks())
      stdinHandle = null
      if (ended) callbacks.onEnded()
      // else: worker exited idle — session stays open, next send() will reconnect
    }).catch((err) => {
      log.warn("chat process error", { error: errorMessage(err) })
      stdinHandle = null
      if (ended) callbacks.onEnded()
    })
  }

  // ── Lifecycle ──

  function interrupt() {
    if (ended || !stdinHandle?.isOpen) return
    log.info("chat interrupted by user", { pid: workerPid })
    // Kill the worker process and immediately respawn via --resume so
    // the next send() doesn't have to wait for the cold-start.
    if (ndjsonParser.sessionId) claudeSessionId = ndjsonParser.sessionId
    stdinHandle.close()
    stdinHandle = null
    if (workerPid) {
      try { process.kill(workerPid, "SIGTERM") } catch { /* already gone */ }
    }
    callbacks.onWaiting(false)
    callbacks.onModelActivity("idle")
    agentActive = false
    userTurnInProgress = false
    builder.resolvePendingMessages()
    builder.pushSystemMessage("Interrupted", Date.now())
    if (builder.hasChanged()) callbacks.onBlocks(builder.getBlocks())

    // Eagerly reconnect so the worker is warm when the user sends the next message
    if (claudeSessionId) {
      spawnWorker(claudeSessionId).catch((err) => {
        log.warn("eager reconnect after interrupt failed", { error: errorMessage(err) })
      })
    }
  }

  function end() {
    if (ended) return
    ended = true
    clearInterval(flushInterval)
    if (traceCollector) {
      traceCollector.finalize("ok")
      traceCollector.dispose()
    }
    transcriptWriter?.dispose()
    builder.dispose()
    budgetTracker.flush()
    if (stdinHandle?.isOpen) {
      // Worker is alive — close the pipe and let the process exit naturally.
      // onEnded fires from the spawnResult.result handler once the process exits.
      stdinHandle.close()
      stdinHandle = null
    } else {
      // Worker already idle-exited — fire immediately.
      stdinHandle = null
      callbacks.onEnded()
    }
  }

  function send(text: string) {
    if (ended) { log.warn("chat send after ended"); return }

    // Message is "pending" only when there's an active agent turn in progress
    // (i.e. we're injecting into a running conversation). After interrupt or
    // idle-exit, the agent isn't working so the message is the start of a new turn.
    const isPending = agentActive && stdinHandle?.isOpen === true
    userTurnInProgress = true
    callbacks.onWaiting(true)
    builder.pushUserMessage(text, Date.now(), isPending)
    callbacks.onBlocks(builder.getBlocks())

    if (stdinHandle?.isOpen) {
      // Normal path: worker is alive, write directly to the pipe
      const ok = stdinHandle.write(formatStdinMessage(engineName, text))
      log.info("chat message sent", { length: text.length, written: ok })
      return
    }

    // Worker exited idle — reconnect via --resume and send the message as initial content
    if (claudeSessionId) {
      log.info("chat worker idle-exited, reconnecting via --resume", { sessionId: claudeSessionId })
      spawnWorker(claudeSessionId, text).catch((err) => {
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

  // ── Initial spawn ──

  const hasInitialMessage = initialMessage != null && initialMessage.trim().length > 0
  if (hasInitialMessage) callbacks.onWaiting(true)

  await spawnWorker(undefined, hasInitialMessage ? initialMessage : undefined)

  return { send, interrupt, end, builder, budgetTracker }
}

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
import { BunProcessSpawner } from "../orchestration/worker/bun-spawner"
import { formatStdinMessage } from "../orchestration/worker/stdin-format"
import { getEngine } from "../orchestration/engines/core/registry"
import { NDJSONParser } from "../orchestration/worker/ndjson-parser"
import { StructuredOutputBuilder } from "./adapters/structured-output-builder"
import { StructuredEventParser } from "./adapters/structured-event-parser"
import { SubagentTraceParser } from "./adapters/subagent-tracing/parser"
import { createBudgetTracker, type BudgetTracker } from "../orchestration/session/budget-tracker"
import { prepareWorkflowDeps } from "../orchestration/engines/workflow-deps"
import type { ProcessSpawner, StdinHandle } from "../orchestration/worker/spawner"
import type { AnyBlock } from "./types"
import { Log } from "../infra/log.js"
import { errorMessage } from "../infra/error-message.js"

const log = Log.create({ service: "chat" })

// ── Public interface ──

export interface ChatCallbacks {
  onBlocksChanged: (blocks: AnyBlock[]) => void
  onWaitingChanged: (waiting: boolean) => void
  onTokensChanged: (tokens: number) => void
  onCostChanged: (cost: number) => void
  onModelActivity: (activity: import("./adapters/structured-output-builder").ModelActivity) => void
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
}

export async function startChatSession(
  callbacks: ChatCallbacks,
  initialMessage?: string,
  overrides?: ChatSessionOptions,
): Promise<ChatSession> {
  const projectCwd = overrides?.projectCwd ?? process.cwd()
  const deps = overrides?.deps ?? prepareWorkflowDeps()
  const engineName = deps.config.engine
  const engine = getEngine(engineName)
  const model = deps.config.worker?.model ?? deps.config.model ?? engine.metadata.defaultModel

  const spawner = overrides?.spawner ?? new BunProcessSpawner()
  const sessionId = randomUUID()

  // Budget tracker
  const budgetTracker = createBudgetTracker({ sessionId, baseDir: projectCwd })

  // Structured output pipeline — shared across worker respawns
  const builder = new StructuredOutputBuilder()
  let agentActive = false
  builder.onModelActivityChange = (activity) => {
    callbacks.onModelActivity(activity)
    if (activity === "idle" && agentActive) {
      agentActive = false
      if (builder.resolvePendingMessages()) {
        callbacks.onBlocksChanged(builder.getBlocks())
      }
    } else if (activity !== "idle") {
      agentActive = true
    }
  }
  const traceParser = new SubagentTraceParser()
  const eventParser = new StructuredEventParser({ traceParser, builder })
  const ndjsonParser = new NDJSONParser()

  ndjsonParser.onEvent = (event) => {
    // Claude Code echoes user messages as {"type":"user"} — this confirms
    // the CLI received our stdin injection. Resolve any queued messages.
    if (event.type === "user") {
      if (builder.resolvePendingMessages()) {
        callbacks.onBlocksChanged(builder.getBlocks())
      }
    }
    eventParser.dispatch(event, engineName)
    budgetTracker.handleEvent(event)
  }
  ndjsonParser.onRawText = (text) => {
    if (text.trim().length > 0) builder.pushText(text + "\n", Date.now())
  }

  // Flush builder → callbacks at 16ms
  const flushInterval = setInterval(() => {
    if (builder.hasChanged()) callbacks.onBlocksChanged(builder.getBlocks())
    callbacks.onTokensChanged(budgetTracker.getTokensUsed())
    callbacks.onCostChanged(budgetTracker.getTotalCost())
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
    budgetTracker.onNewWorker()
    const engineCmd = engine.buildCommand({ prompt: "", model, resumeSessionId })

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
        callbacks.onWaitingChanged(false)
        callbacks.onModelActivity("idle")
        if (builder.hasChanged()) callbacks.onBlocksChanged(builder.getBlocks())
      },
    })

    stdinHandle = spawnResult.stdinHandle ?? null
    workerPid = spawnResult.pid

    // When the worker exits, keep the TUI session alive so the user can resume.
    // Only call end() if the session was explicitly terminated by the user.
    spawnResult.result.then(() => {
      if (ndjsonParser.sessionId) claudeSessionId = ndjsonParser.sessionId
      ndjsonParser.flush()
      if (builder.hasChanged()) callbacks.onBlocksChanged(builder.getBlocks())
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
    // Kill the worker process. The session stays alive (ended === false),
    // so next send() will reconnect via --resume using claudeSessionId.
    if (ndjsonParser.sessionId) claudeSessionId = ndjsonParser.sessionId
    stdinHandle.close()
    stdinHandle = null
    if (workerPid) {
      try { process.kill(workerPid, "SIGTERM") } catch { /* already gone */ }
    }
    callbacks.onWaitingChanged(false)
    callbacks.onModelActivity("idle")
    agentActive = false
    builder.resolvePendingMessages()
    builder.pushSystemMessage("Interrupted", Date.now())
    if (builder.hasChanged()) callbacks.onBlocksChanged(builder.getBlocks())
  }

  function end() {
    if (ended) return
    ended = true
    clearInterval(flushInterval)
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

    const isPending = agentActive
    callbacks.onWaitingChanged(true)
    builder.pushUserMessage(text, Date.now(), isPending)
    callbacks.onBlocksChanged(builder.getBlocks())

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
        callbacks.onWaitingChanged(false)
        callbacks.onError(`Reconnect failed: ${errorMessage(err)}`)
      })
      return
    }

    // No worker and no session ID to resume — this should only happen before the
    // first turn completes (session ID not yet emitted by Claude Code).
    log.warn("chat send: no active worker and no session ID to resume")
    callbacks.onWaitingChanged(false)
  }

  // ── Initial spawn ──

  const hasInitialMessage = initialMessage != null && initialMessage.trim().length > 0
  if (hasInitialMessage) callbacks.onWaitingChanged(true)

  await spawnWorker(undefined, hasInitialMessage ? initialMessage : undefined)

  return { send, interrupt, end, builder, budgetTracker }
}

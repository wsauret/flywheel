/**
 * Chat Mode — Interactive back-and-forth with an engine process.
 *
 * Spawns an engine process with stdin pipe
 * open. User sends messages, the engine responds, pipe stays open for
 * multi-turn conversation. Engine selection is driven by flywheel.toml config
 * via prepareWorkflowDeps() → getEngine(config.engine).
 *
 * Uses the structured output pipeline for rendering (same blocks as workflow mode).
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
import { Log } from "../workflows/shared/log"
import { errorMessage } from "../workflows/shared/error-message"

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

  const engineCmd = engine.buildCommand({ prompt: "", model, agentsJson: deps.agentsJson })
  const spawner = overrides?.spawner ?? new BunProcessSpawner()
  const sessionId = randomUUID()

  // Budget tracker
  const budgetTracker = createBudgetTracker({ sessionId, baseDir: projectCwd })

  // Structured output pipeline
  const builder = new StructuredOutputBuilder()
  builder.onModelActivityChange = (activity) => callbacks.onModelActivity(activity)
  const traceParser = new SubagentTraceParser()
  const eventParser = new StructuredEventParser({ traceParser, builder })
  const ndjsonParser = new NDJSONParser()

  ndjsonParser.onEvent = (event) => {
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
  let ended = false

  function end() {
    if (ended) return
    ended = true
    clearInterval(flushInterval)
    builder.dispose() // stops stale agent check interval
    if (stdinHandle?.isOpen) stdinHandle.close()
    stdinHandle = null
    budgetTracker.flush()
    callbacks.onEnded()
  }

  function send(text: string) {
    if (ended) { log.warn("chat send after ended"); return }
    if (!stdinHandle) { log.warn("chat send: no stdin handle"); return }
    if (!stdinHandle.isOpen) { log.warn("chat send: stdin pipe closed"); return }
    callbacks.onWaitingChanged(true)
    builder.pushUserMessage(text, Date.now())
    callbacks.onBlocksChanged(builder.getBlocks())
    const msg = formatStdinMessage(engineName, text)
    const ok = stdinHandle.write(msg)
    log.info("chat message sent", { length: text.length, written: ok })
  }

  // Spawn the process — always provide stdin content for pipe mode.
  // If no initial message, send a no-op system greeting so the process starts
  // and waits for the first real user message on the open pipe.
  const hasInitialMessage = initialMessage != null && initialMessage.trim().length > 0
  const initialContent = hasInitialMessage
    ? formatStdinMessage(engineName, initialMessage)
    : formatStdinMessage(engineName, "You are now in interactive chat mode. Wait for the user's first message.")

  if (hasInitialMessage) callbacks.onWaitingChanged(true)

  const spawnResult = await spawner.spawn(engineCmd.command, engineCmd.args, {
    cwd: projectCwd,
    stdin: initialContent,
    stdinPipe: true,
    onStdout: (chunk) => ndjsonParser.write(chunk),
    onStderr: (chunk) => {
      if (chunk.trim()) builder.pushText(chunk, Date.now())
    },
    onTurnComplete: () => {
      callbacks.onWaitingChanged(false)
      callbacks.onModelActivity("idle")
      if (builder.hasChanged()) callbacks.onBlocksChanged(builder.getBlocks())
    },
  })

  stdinHandle = spawnResult.stdinHandle ?? null

  // Background: wait for process exit, then clean up
  spawnResult.result.then(() => {
    ndjsonParser.flush()
    if (builder.hasChanged()) callbacks.onBlocksChanged(builder.getBlocks())
    end()
  }).catch((err) => {
    log.warn("chat process error", { error: errorMessage(err) })
    end()
  })

  return { send, end, builder, budgetTracker }
}

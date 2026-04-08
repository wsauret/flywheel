/**
 * Chat Runner — wraps ChatSession with SessionRunner interface compliance,
 * output persistence, and state machine transitions.
 *
 * Delegates all chat subprocess logic to createChatSession(). Adds:
 * 1. SessionRunner interface (sessionId, abort, dispose, injectMessage)
 * 2. Output persistence via OutputFlusher
 * 3. State transitions (active / paused via updateState)
 * 4. Shared session infra lifecycle (budget, traces, transcripts)
 */

import { createChatSession, type ChatSession, type ChatCallbacks } from "./chat-session"
import { createSessionInfra } from "./session/create-session-infra"
import { createOutputPersistence, type OutputFlusher } from "./session/output-persistence"
import { generateSessionTitle } from "./session-title"
import { prepareWorkflowDeps } from "./engines/workflow-deps"
import type { SessionRunner } from "./session-runner"
import type { SessionState } from "./session/state-machine"
import type { FlywheelConfig } from "./config/loader"
import type { ProcessSpawner } from "./engines/subprocess/spawner"
import type { AnyBlock } from "../infra/output-blocks"
import type { ModelActivity } from "../infra/events"

// ── Types ──

export interface ChatRunnerCallbacks {
  onBlocks: (blocks: AnyBlock[]) => void
  onTokens: (tokens: number) => void
  onCost: (cost: number) => void
  onContextPercent?: (percent: number) => void
  onModelActivity?: (activity: ModelActivity) => void
  onSessionName?: (name: string) => void
  onError: (message: string) => void
  onEnded: () => void
}

export interface ChatRunnerDeps {
  sessionId: string
  projectCwd: string
  updateState: (id: string, state: SessionState) => void
  callbacks: ChatRunnerCallbacks
  initialMessage?: string
  /** Output blocks from a previous session (for resume — prepended to new output). */
  priorBlocks?: AnyBlock[]
  /** When true, emit a welcome system block before the first chat output. */
  showWelcome?: boolean
  /** Optional overrides for testing. */
  spawner?: ProcessSpawner
  config?: FlywheelConfig
}

export interface ChatRunner extends SessionRunner {
  /** The underlying ChatSession (for direct access when needed). */
  readonly chatSession: ChatSession
}

// ── Factory ──

export async function createChatRunner(deps: ChatRunnerDeps): Promise<ChatRunner> {
  const { sessionId, projectCwd, updateState, callbacks, initialMessage, priorBlocks } = deps

  // Prepare workflow deps (config, engine, spawner)
  const workflowDeps = prepareWorkflowDeps()
  const config = deps.config ?? workflowDeps.config

  // Shared session infrastructure (budget, traces, transcripts)
  const infra = createSessionInfra({
    sessionId,
    projectCwd,
    config,
    description: "chat",
  })

  // Output persistence
  const outputPersistence = createOutputPersistence({ sessionId, baseDir: projectCwd })
  let currentBlocks: AnyBlock[] = []
  const outputFlusher: OutputFlusher = outputPersistence.createFlusher(() => currentBlocks)

  let disposed = false
  let firstMessageSent = false
  let lastWaiting: boolean | null = null

  // If resuming, emit prior blocks immediately so the UI shows them
  if (priorBlocks && priorBlocks.length > 0) {
    currentBlocks = [...priorBlocks]
    callbacks.onBlocks(currentBlocks)
  }

  // Emit a welcome block on first boot (no prior sessions)
  if (deps.showWelcome && !priorBlocks) {
    const welcomeBlock: AnyBlock = {
      kind: "system",
      message: "Welcome to Flywheel. Type a message to chat, or use /work, /plan, /debug to start a workflow. Ctrl+B opens sessions.",
      timestamp: Date.now(),
    }
    currentBlocks = [welcomeBlock]
    callbacks.onBlocks(currentBlocks)
  }

  // Wire ChatCallbacks to ChatRunner's callbacks + infra
  const chatCallbacks: ChatCallbacks = {
    onBlocks: (newBlocks) => {
      currentBlocks = priorBlocks ? [...priorBlocks, ...newBlocks] : newBlocks
      callbacks.onBlocks(currentBlocks)
      outputFlusher.schedule()
    },
    onWaiting: (waiting) => {
      // Only transition when state actually changes to avoid noisy self-transition warnings
      if (waiting && lastWaiting !== true) {
        updateState(sessionId, "active")
      } else if (!waiting && lastWaiting !== false) {
        updateState(sessionId, "paused")
      }
      lastWaiting = waiting
    },
    onTokens: (tokens) => callbacks.onTokens(tokens),
    onCost: (cost) => callbacks.onCost(cost),
    onContextPercent: (percent) => callbacks.onContextPercent?.(percent),
    onModelActivity: (activity) => callbacks.onModelActivity?.(activity),
    onError: (message) => callbacks.onError(message),
    onEnded: () => callbacks.onEnded(),
  }

  // Create the underlying ChatSession
  const chatSession = await createChatSession(chatCallbacks, initialMessage, {
    projectCwd,
    deps: workflowDeps,
    spawner: deps.spawner,
    traceCollector: infra.traceCollector ?? undefined,
  })

  // ── SessionRunner implementation ──

  function abort(): void {
    chatSession.interrupt()
  }

  function injectMessage(text: string): boolean {
    updateState(sessionId, "active")
    chatSession.send(text)

    // Auto-name the session from the first user message
    if (!firstMessageSent) {
      firstMessageSent = true
      generateSessionTitle(text, (title) => callbacks.onSessionName?.(title))
    }

    return true
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true

    // Flush BEFORE dispose to prevent DebouncedWriter data loss
    await outputFlusher.flush()
    outputFlusher.dispose()

    // End the chat session (closes subprocess)
    chatSession.end()

    // Clean up infra
    infra.traceCollector?.finalize("ok")
    infra.traceCollector?.dispose()
    infra.traceWriter?.dispose()
    infra.transcriptWriter?.dispose()
    infra.budgetTracker.flush()
    infra.budgetTracker.dispose()
  }

  return {
    sessionId,
    abort,
    dispose,
    injectMessage,
    chatSession,
  }
}

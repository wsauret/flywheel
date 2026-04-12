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
import { createOutputPersistence } from "./session/output-persistence"
import { updateSession } from "./session/persistence"
import { disposeSessionResources, type SessionResources } from "./session/resources"
import { generateSessionTitle } from "./session-title"
import { prepareWorkflowDeps } from "./engines/workflow-deps"
import { EventBus, createEmit } from "../infra/event-bus"
import { randomUUID } from "node:crypto"
import type { SessionRunner } from "./session-runner"
import type { SessionState } from "./session/state-machine"
import type { FlywheelConfig } from "./config/schema"
import type { ProcessSpawner } from "./engines/subprocess/spawner"
import type { SessionEntryBase } from "./session-store-types"
import type { AnyBlock } from "../infra/output-blocks"
import { buildChatWelcomeBlocks } from "./chat-welcome.js"

// ── Types ──

/** Function to update fields on the session entry in the reactive store. */
export type ChatUpdateEntryFn = (patch: Partial<import("./session-store-types").ChatSessionEntry>) => void

export interface ChatRunnerDeps {
  sessionId: string
  projectCwd: string
  updateState: (id: string, state: SessionState) => void
  /** Write data directly to the reactive session store. */
  updateEntry: ChatUpdateEntryFn
  /** Called on session name change (for manager label persistence). */
  onSessionName?: (name: string) => void
  /** Signal a fatal error — propagated to registry's onError. */
  onError: (message: string) => void
  /** Signal normal completion — propagated to registry's onEnded. */
  onEnded: () => void
  initialMessage?: string
  /** Output blocks from a previous session (for resume — prepended to new output). */
  priorBlocks?: AnyBlock[]
  /** When true, emit a welcome system block before the first chat output. */
  showWelcome?: boolean
  /** Optional overrides for testing. */
  spawner?: ProcessSpawner
  config?: FlywheelConfig
  /** Pre-known Claude Code session ID — for --resume on auto-resume path. */
  claudeSessionId?: string
}

export interface ChatRunner extends SessionRunner {
  /** The underlying ChatSession (for direct access when needed). */
  readonly chatSession: ChatSession
  /** Blocks created during init (e.g., welcome message) — before the registry entry exists. */
  readonly initialBlocks: readonly AnyBlock[]
}

// ── Factory ──

export async function createChatRunner(deps: ChatRunnerDeps): Promise<ChatRunner> {
  const { sessionId, projectCwd, updateState, updateEntry, initialMessage, priorBlocks } = deps

  // Prepare workflow deps (config, engine, spawner)
  const workflowDeps = prepareWorkflowDeps()
  const config = deps.config ?? workflowDeps.config

  // Runner owns the EventBus — same pattern as workflow-runner.
  const eventBus = new EventBus()
  const emit = createEmit(eventBus)
  const chatId = randomUUID()

  // Shared session infrastructure (budget, traces, transcripts).
  // Passing emitter + workflowId enables budget:metrics-changed emission,
  // which wireSessionSubscribers routes to the store via metricsWriter.
  const infra = createSessionInfra({
    sessionId,
    projectCwd,
    config,
    description: "chat",
    emitter: emit,
    workflowId: chatId,
  })

  // Output persistence — OutputSession writes blocks to the store, but we still
  // need to persist them to disk. The flusher reads blocks from the OutputSession.
  const outputPersistence = createOutputPersistence({ sessionId, baseDir: projectCwd })
  // We'll set up the flusher's getBlocks after creating the chat session (need the OutputSession).
  // For now, track a reference we can update.
  let getBlocksFn: () => readonly AnyBlock[] = () => []
  const outputFlusher = outputPersistence.createFlusher(() => getBlocksFn())

  let disposed = false
  let firstMessageSent = priorBlocks != null && priorBlocks.length > 0
  let lastWaiting: boolean | null = null
  /** Track last persisted value to avoid redundant disk writes. */
  let persistedClaudeSessionId: string | null = deps.claudeSessionId ?? null

  // If resuming, emit prior blocks immediately so the UI shows them
  if (priorBlocks && priorBlocks.length > 0) {
    updateEntry({ outputBlocks: [...priorBlocks] })
  }

  // Emit welcome blocks on first boot (no prior sessions)
  let initialBlocks: AnyBlock[] = []
  if (deps.showWelcome && !priorBlocks) {
    initialBlocks = buildChatWelcomeBlocks(projectCwd)
  }

  // Wrapped updateEntry that prepends priorBlocks when present
  const wrappedUpdateEntry = (patch: Partial<SessionEntryBase>) => {
    if (patch.outputBlocks && priorBlocks && priorBlocks.length > 0) {
      updateEntry({ ...patch, outputBlocks: [...priorBlocks, ...(patch.outputBlocks as AnyBlock[])] } as Partial<import("./session-store-types").ChatSessionEntry>)
    } else {
      updateEntry(patch as Partial<import("./session-store-types").ChatSessionEntry>)
    }
  }

  // Wire ChatCallbacks — only lifecycle callbacks remain
  const chatCallbacks: ChatCallbacks = {
    onWaiting: (waiting) => {
      // Only transition when state actually changes to avoid noisy self-transition warnings
      if (waiting && lastWaiting !== true) {
        updateState(sessionId, "active")
      } else if (!waiting && lastWaiting !== false) {
        updateState(sessionId, "paused")
      }
      lastWaiting = waiting
    },
    onError: (message) => void deps.onError(message),
    onEnded: () => void deps.onEnded(),
  }

  // Create the underlying ChatSession — pass shared infra and EventBus to avoid duplicate creation
  const chatSession = await createChatSession(chatCallbacks, initialMessage, {
    projectCwd,
    deps: workflowDeps,
    spawner: deps.spawner,
    traceCollector: infra.traceCollector ?? undefined,
    budgetTracker: infra.budgetTracker,
    transcriptWriter: infra.transcriptWriter,
    eventBus,
    chatId,
    metricsWriter: (patch) => updateEntry(patch as Partial<import("./session-store-types").ChatSessionEntry>),
    updateEntry: wrappedUpdateEntry,
    claudeSessionId: deps.claudeSessionId,
    onFlush: () => {
      // Propagate captured Claude session ID to the store entry for resume persistence
      const csId = chatSession.outputSession.sessionId
      if (csId) {
        updateEntry({ claudeSessionId: csId })
        // Write-through to disk on first capture — survives terminal close / crash
        // without waiting for the runner's onRunnerDone callback.
        if (csId !== persistedClaudeSessionId) {
          persistedClaudeSessionId = csId
          try { updateSession(sessionId, { claudeSessionId: csId }, projectCwd) } catch { /* best-effort */ }
        }
      }
      outputFlusher.schedule()
    },
  })

  // Wire the flusher's getBlocks to the OutputSession's blocks (+ priorBlocks prefix)
  getBlocksFn = () => {
    const sessionBlocks = chatSession.outputSession.getBlocks()
    return priorBlocks && priorBlocks.length > 0
      ? [...priorBlocks, ...sessionBlocks]
      : sessionBlocks
  }

  // ── SessionRunner implementation ──

  function abort(): void {
    chatSession.interrupt()
  }

  function injectMessage(text: string): boolean {
    chatSession.send(text)

    // Auto-name the session from the first user message
    if (!firstMessageSent) {
      firstMessageSent = true
      generateSessionTitle(text, (title) => {
        updateEntry({ description: title })
        deps.onSessionName?.(title)
      })
    }

    return true
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true

    // 1. End the chat session FIRST (signal subprocess to stop).
    //    Must happen before resource disposal — the subprocess may still write
    //    to budgetTracker/transcriptWriter while it's shutting down.
    chatSession.end()

    // 2. Unified resource disposal (finalize → flush → dispose)
    const resources = {
      budgetTracker: infra.budgetTracker,
      traceWriter: infra.traceWriter,
      transcriptWriter: infra.transcriptWriter,
      traceCollector: infra.traceCollector,
      outputFlusher,
    }
    await disposeSessionResources(resources, "ok")
  }

  return {
    sessionId,
    abort,
    dispose,
    injectMessage,
    chatSession,
    initialBlocks,
  }
}

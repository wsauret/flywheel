/**
 * Session Registry
 *
 * Manages multiple concurrent session runners (workflow and chat). Each
 * registered session runs independently in the background. The shell picks
 * one as "foreground" for display, while others continue executing.
 *
 * Uses a discriminated union on `kind` ("workflow" | "chat") so consumers
 * can type-narrow to access session-specific fields (e.g. `steps` on
 * workflow entries, but not on chat entries).
 *
 * No UI imports — pure orchestration with callback-based notifications.
 */

import { createWorkflowRunner, type WorkflowRunner, type WorkflowResult, type StepState } from "./workflow-runner"
import { errorMessage } from "../infra/error-message"
import type { AnyBlock } from "../infra/output-blocks"
import type { Queue } from "../workflows/queue/types"
import type { ModelActivity } from "../infra/events"
import type { ChatRunner } from "./chat-runner"
import type { SessionKind } from "./session/types"

// ---------------------------------------------------------------------------
// Types — discriminated union on `kind`
// ---------------------------------------------------------------------------

interface SessionEntryBase {
  readonly kind: SessionKind
  readonly description: string
  readonly outputBlocks: readonly AnyBlock[]
  readonly tokens: number
  readonly cost: number
  readonly startedAt: number
  readonly modelActivity: ModelActivity
  readonly errorMessage?: string
}

export interface WorkflowSessionEntry extends SessionEntryBase {
  readonly kind: "workflow"
  readonly runner: WorkflowRunner
  readonly steps: readonly StepState[]
  readonly status: "running" | "paused" | "completed" | "error"
  readonly result?: WorkflowResult
}

export interface ChatSessionEntry extends SessionEntryBase {
  readonly kind: "chat"
  readonly runner: ChatRunner
  readonly status: "running" | "completed" | "error"
}

export type SessionEntry = WorkflowSessionEntry | ChatSessionEntry

/** Callbacks passed into createRunner so the runner can update the registry entry. */
export interface ChatRegistryCallbacks {
  onBlocks: (blocks: AnyBlock[]) => void
  onTokens: (n: number) => void
  onCost: (n: number) => void
  onModelActivity: (activity: ModelActivity) => void
  onSessionName: (name: string) => void
  onError: (message: string) => void
  onEnded: () => void
}

export interface SessionRegistry {
  /** Start a new workflow and register it. Returns sessionId. */
  start(opts: {
    sessionId: string
    queue: Queue
    description: string
    priorBlocks?: AnyBlock[]
    /** Override the subprocess cwd. Defaults to projectCwd.
     * Used by /test (temp dir isolation) and git worktrees (branch-specific working dir).
     * Session metadata/persistence stays in projectCwd; only the spawned process runs here. */
    subprocessCwd?: string
    /** Called when the run completes or errors (e.g., temp dir cleanup). */
    onComplete?: () => void
  }): string

  /** Start a new chat session and register it. Returns sessionId.
   *  Async because ChatRunner creation is async.
   *  The createRunner factory receives callbacks wired to the registry's updateEntry. */
  startChat(opts: {
    sessionId: string
    description?: string
    priorBlocks?: AnyBlock[]
    createRunner: (callbacks: ChatRegistryCallbacks) => Promise<ChatRunner>
    onComplete?: () => void
  }): Promise<string>

  /** Get a session entry by ID. */
  get(sessionId: string): SessionEntry | undefined

  /** Get all active (running/paused) session IDs. */
  activeIds(): string[]

  /** Pause a specific session. Returns false if the entry doesn't support pausing (e.g. chat). */
  pause(sessionId: string): boolean

  /** Abort a specific session. */
  abort(sessionId: string): void

  /** Remove a completed/errored session from the registry (cleanup). */
  remove(sessionId: string): void

  /** Subscribe to registry changes. Returns unsubscribe function. */
  subscribe(cb: () => void): () => void

  /** Inject a user message into a running session's worker. */
  injectMessage(sessionId: string, text: string): boolean

  /** Cancel shutdown for a session so it continues after current step. Returns false for non-workflow entries. */
  cancelShutdown(sessionId: string): boolean

  /** Number of running sessions. */
  runningCount(): number

  /** All session IDs currently in the registry (any status). */
  allIds(): string[]

  /** Abort and dispose all sessions, flushing output. For clean shutdown. */
  disposeAll(): Promise<void>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionRegistry(): SessionRegistry {
  const entries = new Map<string, SessionEntry>()
  const subscribers = new Set<() => void>()

  function notify(): void {
    for (const cb of subscribers) {
      try { cb() } catch { /* subscriber errors must not propagate */ }
    }
  }

  function updateEntry(sessionId: string, patch: Partial<WorkflowSessionEntry> | Partial<ChatSessionEntry>): void {
    const existing = entries.get(sessionId)
    if (!existing) return
    entries.set(sessionId, { ...existing, ...patch } as SessionEntry)
    notify()
  }

  function start(opts: {
    sessionId: string
    queue: Queue
    description: string
    priorBlocks?: AnyBlock[]
    subprocessCwd?: string
    onComplete?: () => void
  }): string {
    const { sessionId, queue, description, priorBlocks } = opts

    const runner = createWorkflowRunner({
      sessionId,
      queue,
      description,
      callbacks: {
        onBlocks: (blocks) => updateEntry(sessionId, { outputBlocks: blocks }),
        onSteps: (steps) => updateEntry(sessionId, { steps }),
        onTokens: (n) => updateEntry(sessionId, { tokens: n }),
        onCost: (n) => updateEntry(sessionId, { cost: n }),
        onSessionName: (name) => updateEntry(sessionId, { description: name }),
        onModelActivity: (activity) => updateEntry(sessionId, { modelActivity: activity }),
      },
      priorBlocks,
      overrides: opts.subprocessCwd ? { subprocessCwd: opts.subprocessCwd } : undefined,
    })

    const entry: WorkflowSessionEntry = {
      kind: "workflow",
      runner,
      description,
      outputBlocks: priorBlocks ? [...priorBlocks] : [],
      steps: [],
      tokens: 0,
      cost: 0,
      startedAt: Date.now(),
      status: "running",
      modelActivity: "idle",
    }

    entries.set(sessionId, entry)
    notify()

    // Run in background — do NOT await
    runner.run().then(
      (result) => {
        updateEntry(sessionId, {
          status: result.completed ? "completed" : "paused",
          result,
        })
        opts.onComplete?.()
      },
      (err) => {
        updateEntry(sessionId, {
          status: "error",
          errorMessage: errorMessage(err),
        })
        opts.onComplete?.()
      },
    )

    return sessionId
  }

  async function startChat(opts: {
    sessionId: string
    description?: string
    priorBlocks?: AnyBlock[]
    createRunner: (callbacks: ChatRegistryCallbacks) => Promise<ChatRunner>
    onComplete?: () => void
  }): Promise<string> {
    const { sessionId, description = "Chat", priorBlocks } = opts

    // Wire callbacks to the registry's updateEntry so subscriber notifications fire
    const registryCallbacks: ChatRegistryCallbacks = {
      onBlocks: (blocks) => updateEntry(sessionId, { outputBlocks: blocks }),
      onTokens: (n) => updateEntry(sessionId, { tokens: n }),
      onCost: (n) => updateEntry(sessionId, { cost: n }),
      onModelActivity: (activity) => updateEntry(sessionId, { modelActivity: activity }),
      onSessionName: (name) => updateEntry(sessionId, { description: name }),
      onError: (message) => updateEntry(sessionId, { status: "error", errorMessage: message }),
      onEnded: () => {
        updateEntry(sessionId, { status: "completed" })
        opts.onComplete?.()
      },
    }

    const runner = await opts.createRunner(registryCallbacks)

    const entry: ChatSessionEntry = {
      kind: "chat",
      runner,
      description,
      outputBlocks: priorBlocks ? [...priorBlocks] : [],
      tokens: 0,
      cost: 0,
      startedAt: Date.now(),
      status: "running",
      modelActivity: "idle",
    }

    entries.set(sessionId, entry)
    notify()

    return sessionId
  }

  function get(sessionId: string): SessionEntry | undefined {
    return entries.get(sessionId)
  }

  function activeIds(): string[] {
    const ids: string[] = []
    for (const [id, entry] of entries) {
      if (entry.status === "running" || (entry.kind === "workflow" && entry.status === "paused")) {
        ids.push(id)
      }
    }
    return ids
  }

  function pause(sessionId: string): boolean {
    const entry = entries.get(sessionId)
    if (!entry || entry.status !== "running") return false
    if (entry.kind !== "workflow") return false
    entry.runner.pause()
    updateEntry(sessionId, { status: "paused" })
    return true
  }

  function abort(sessionId: string): void {
    const entry = entries.get(sessionId)
    if (!entry) return
    entry.runner.abort()
    // Status transitions happen when run() resolves (workflow) or via callbacks (chat)
  }

  function remove(sessionId: string): void {
    const entry = entries.get(sessionId)
    if (!entry) return
    entry.runner.dispose()
    entries.delete(sessionId)
    notify()
  }

  function injectMessage(sessionId: string, text: string): boolean {
    const entry = entries.get(sessionId)
    if (!entry) return false
    return entry.runner.injectMessage(text)
  }

  function cancelShutdown(sessionId: string): boolean {
    const entry = entries.get(sessionId)
    if (!entry) return false
    if (entry.kind !== "workflow") return false
    entry.runner.cancelShutdown()
    if (entry.status === "paused") {
      updateEntry(sessionId, { status: "running" })
    }
    return true
  }

  function subscribe(cb: () => void): () => void {
    subscribers.add(cb)
    return () => { subscribers.delete(cb) }
  }

  function runningCount(): number {
    let count = 0
    for (const entry of entries.values()) {
      if (entry.status === "running") count++
    }
    return count
  }

  function allIds(): string[] {
    return [...entries.keys()]
  }

  async function disposeAll(): Promise<void> {
    const ids = [...entries.keys()]
    // Abort all first (signal subprocesses to stop)
    for (const id of ids) {
      const entry = entries.get(id)
      if (entry) entry.runner.abort()
    }
    // Then dispose all (flushes output, cleans up resources)
    await Promise.all(ids.map(async (id) => {
      const entry = entries.get(id)
      if (!entry) return
      try { await entry.runner.dispose() } catch { /* best-effort */ }
      entries.delete(id)
    }))
    notify()
  }

  return { start, startChat, get, activeIds, allIds, pause, abort, remove, injectMessage, cancelShutdown, subscribe, runningCount, disposeAll }
}

/**
 * Session Registry
 *
 * Manages multiple concurrent workflow runners. Each registered session
 * runs independently in the background. The shell picks one as "foreground"
 * for display, while others continue executing.
 *
 * No UI imports — pure orchestration with callback-based notifications.
 */

import { createWorkflowRunner, type WorkflowRunner, type WorkflowResult, type StepState } from "./workflow-runner"
import { errorMessage } from "../infra/error-message"
import type { AnyBlock } from "../infra/output-blocks"
import type { Queue } from "../workflows/queue/types"
import type { ModelActivity } from "../infra/events"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionEntry {
  readonly runner: WorkflowRunner
  readonly description: string
  readonly outputBlocks: readonly AnyBlock[]
  readonly steps: readonly StepState[]
  readonly tokens: number
  readonly cost: number
  readonly startedAt: number
  readonly status: "running" | "paused" | "completed" | "error"
  readonly modelActivity: ModelActivity
  readonly result?: WorkflowResult
  readonly errorMessage?: string
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

  /** Get a session entry by ID. */
  get(sessionId: string): SessionEntry | undefined

  /** Get all active (running/paused) session IDs. */
  activeIds(): string[]

  /** Pause a specific session. */
  pause(sessionId: string): void

  /** Abort a specific session. */
  abort(sessionId: string): void

  /** Remove a completed/errored session from the registry (cleanup). */
  remove(sessionId: string): void

  /** Subscribe to registry changes. Returns unsubscribe function. */
  subscribe(cb: () => void): () => void

  /** Inject a user message into a running session's worker. */
  injectMessage(sessionId: string, text: string): boolean

  /** Cancel shutdown for a session so it continues after current step. */
  cancelShutdown(sessionId: string): void

  /** Number of running sessions. */
  runningCount(): number
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

  function updateEntry(sessionId: string, patch: Partial<SessionEntry>): void {
    const existing = entries.get(sessionId)
    if (!existing) return
    entries.set(sessionId, { ...existing, ...patch })
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

    const entry: SessionEntry = {
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

  function get(sessionId: string): SessionEntry | undefined {
    return entries.get(sessionId)
  }

  function activeIds(): string[] {
    const ids: string[] = []
    for (const [id, entry] of entries) {
      if (entry.status === "running" || entry.status === "paused") {
        ids.push(id)
      }
    }
    return ids
  }

  function pause(sessionId: string): void {
    const entry = entries.get(sessionId)
    if (!entry || entry.status !== "running") return
    entry.runner.pause()
    updateEntry(sessionId, { status: "paused" })
  }

  function abort(sessionId: string): void {
    const entry = entries.get(sessionId)
    if (!entry) return
    entry.runner.abort()
    // Status transitions happen when run() resolves
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

  function cancelShutdown(sessionId: string): void {
    const entry = entries.get(sessionId)
    if (!entry) return
    entry.runner.cancelShutdown()
    if (entry.status === "paused") {
      updateEntry(sessionId, { status: "running" })
    }
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

  return { start, get, activeIds, pause, abort, remove, injectMessage, cancelShutdown, subscribe, runningCount }
}

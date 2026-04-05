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
import type { AnyBlock } from "../tui/types"
import type { Queue } from "../queue/types"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionEntry {
  runner: WorkflowRunner
  description: string
  outputBlocks: AnyBlock[]
  steps: StepState[]
  tokens: number
  cost: number
  startedAt: number
  status: "running" | "paused" | "completed" | "error"
  result?: WorkflowResult
  errorMessage?: string
}

export interface SessionRegistry {
  /** Start a new workflow and register it. Returns sessionId. */
  start(opts: {
    sessionId: string
    queue: Queue
    description: string
    priorBlocks?: AnyBlock[]
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

  function start(opts: {
    sessionId: string
    queue: Queue
    description: string
    priorBlocks?: AnyBlock[]
  }): string {
    const { sessionId, queue, description, priorBlocks } = opts

    const entry: SessionEntry = {
      runner: null as unknown as WorkflowRunner, // set below
      description,
      outputBlocks: priorBlocks ? [...priorBlocks] : [],
      steps: [],
      tokens: 0,
      cost: 0,
      startedAt: Date.now(),
      status: "running",
    }

    const runner = createWorkflowRunner({
      sessionId,
      queue,
      description,
      callbacks: {
        onBlocks: (blocks) => { entry.outputBlocks = blocks; notify() },
        onSteps: (steps) => { entry.steps = steps; notify() },
        onTokens: (n) => { entry.tokens = n; notify() },
        onCost: (n) => { entry.cost = n; notify() },
        onSessionName: (name) => { entry.description = name; notify() },
      },
      priorBlocks,
    })

    entry.runner = runner
    entries.set(sessionId, entry)
    notify()

    // Run in background — do NOT await
    runner.run().then(
      (result) => {
        entry.status = result.completed ? "completed" : "paused"
        entry.result = result
        notify()
      },
      (err) => {
        entry.status = "error"
        entry.errorMessage = err instanceof Error ? err.message : String(err)
        notify()
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
    entry.status = "paused"
    notify()
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

  return { start, get, activeIds, pause, abort, remove, subscribe, runningCount }
}

/**
 * SessionRuntime — discriminated union for per-session workflow state.
 *
 * Replaces the 14 single-instance `let` refs in flywheel-shell.tsx with a
 * typed Map. Each session is either PendingRuntime (session created, pipeline
 * not yet started) or RunningRuntime (pipeline active, all fields populated).
 *
 * Factory: `createSessionRuntimeManager(deps)` follows the project's
 * `createX(deps)` convention with dependency injection for testability.
 */

import { Log } from "../../utils/log"
import type { WorkflowSession } from "./workflow-session"
import type { StepExecutor } from "../../queue/executor"
import type { Queue } from "../../queue/types"
import type { OutputFlusher } from "../../session/output-persistence"
import type { BudgetTracker } from "../../session/budget-tracker"
import type { ContextIndexer } from "../../memory/indexer"

const log = Log.create({ service: "session-runtime" })

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Pre-pipeline: session exists but pipeline hasn't started. */
export interface PendingRuntime {
  kind: "pending"
  sessionId: string
  session: WorkflowSession
}

/** Active pipeline: all resources allocated and running. */
export interface RunningRuntime {
  kind: "running"
  sessionId: string
  session: WorkflowSession
  flusher: OutputFlusher
  budgetTracker: BudgetTracker
  storeUnsub: () => void
  questionCleanup: () => void
  queueCleanup: () => void
  contextIndexer: ContextIndexer | null
  workerPid: number | null
  /** Queue-based execution: step executor replaces pipeline for queue mode. */
  stepExecutor?: StepExecutor | null
  /** The queue being executed (when using queue-based execution). */
  queue?: Queue | null
}

/** Discriminated union — check `kind` to narrow. */
export type SessionRuntime = PendingRuntime | RunningRuntime

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isPendingRuntime(rt: SessionRuntime): rt is PendingRuntime {
  return rt.kind === "pending"
}

export function isRunningRuntime(rt: SessionRuntime): rt is RunningRuntime {
  return rt.kind === "running"
}

// ---------------------------------------------------------------------------
// Fields needed to promote PendingRuntime → RunningRuntime
// ---------------------------------------------------------------------------

export type PromoteFields = Omit<RunningRuntime, "kind" | "sessionId" | "session">

// ---------------------------------------------------------------------------
// Manager interface
// ---------------------------------------------------------------------------

export interface SessionRuntimeManager {
  /** Register a runtime (pending or running). */
  register(id: string, runtime: SessionRuntime): void
  /** Promote a pending runtime to running by supplying the remaining fields. */
  promote(id: string, fields: PromoteFields): void
  /** Get a runtime by session ID. */
  get(id: string): SessionRuntime | undefined
  /** Check if a runtime exists. */
  has(id: string): boolean
  /** Number of registered runtimes. */
  readonly size: number
  /** Tear down a single runtime: dispose resources, destroy session, remove from map. */
  teardown(id: string): void
  /** Tear down all runtimes. */
  teardownAll(): void
  /** Pause adapter flush for a backgrounded running session. */
  background(id: string): void
  /** Resume adapter flush for a foregrounded running session. */
  foreground(id: string): void
  /** Get IDs of all running (not pending) runtimes. */
  getRunningIds(): string[]
  /** Remove a runtime from the map WITHOUT disposing resources (for already-completed pipelines). */
  remove(id: string): void
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface SessionRuntimeManagerDeps {
  destroyWorkflowSession: (session: WorkflowSession) => void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionRuntimeManager(
  deps: SessionRuntimeManagerDeps,
): SessionRuntimeManager {
  const { destroyWorkflowSession } = deps
  const runtimes = new Map<string, SessionRuntime>()

  function register(id: string, runtime: SessionRuntime): void {
    runtimes.set(id, runtime)
  }

  function promote(id: string, fields: PromoteFields): void {
    const existing = runtimes.get(id)
    if (!existing) {
      throw new Error(`Cannot promote unknown runtime: ${id}`)
    }
    const running: RunningRuntime = {
      kind: "running",
      sessionId: existing.sessionId,
      session: existing.session,
      ...fields,
    }
    runtimes.set(id, running)
  }

  function get(id: string): SessionRuntime | undefined {
    return runtimes.get(id)
  }

  function has(id: string): boolean {
    return runtimes.has(id)
  }

  function getRunningIds(): string[] {
    const ids: string[] = []
    for (const [id, rt] of runtimes) {
      if (rt.kind === "running") ids.push(id)
    }
    return ids
  }

  function teardown(id: string): void {
    const runtime = runtimes.get(id)
    if (!runtime) return

    // Remove from map first (prevents re-entrant teardown)
    runtimes.delete(id)

    if (runtime.kind === "running") {
      // Per-resource try/finally: one failure must not block others
      try { runtime.flusher.dispose() } catch (e) {
        log.warn("flusher disposal failed", { session: id, error: e instanceof Error ? e : String(e) })
      }

      try { runtime.budgetTracker.dispose() } catch (e) {
        log.warn("budgetTracker disposal failed", { session: id, error: e instanceof Error ? e : String(e) })
      }

      try {
        if (runtime.contextIndexer) runtime.contextIndexer.dispose()
      } catch (e) {
        log.warn("contextIndexer disposal failed", { session: id, error: e instanceof Error ? e : String(e) })
      }

      try { runtime.storeUnsub() } catch (e) {
        log.warn("storeUnsub failed", { session: id, error: e instanceof Error ? e : String(e) })
      }

      try { runtime.questionCleanup() } catch (e) {
        log.warn("questionCleanup failed", { session: id, error: e instanceof Error ? e : String(e) })
      }

      try { runtime.queueCleanup() } catch (e) {
        log.warn("queueCleanup failed", { session: id, error: e instanceof Error ? e : String(e) })
      }

      // Shut down step executor if present
      try {
        if (runtime.stepExecutor) runtime.stepExecutor.requestShutdown()
      } catch (e) {
        log.warn("stepExecutor shutdown failed", { session: id, error: e instanceof Error ? e : String(e) })
      }
    }

    // Always destroy the session (both pending and running)
    try { destroyWorkflowSession(runtime.session) } catch (e) {
      log.warn("session destroy failed", { session: id, error: e instanceof Error ? e : String(e) })
    }
  }

  function teardownAll(): void {
    const ids = [...runtimes.keys()]
    for (const id of ids) {
      teardown(id)
    }
  }

  function background(id: string): void {
    const runtime = runtimes.get(id)
    if (!runtime || runtime.kind !== "running") return
    try { runtime.session.adapter.pauseFlush() } catch (e) {
      log.warn("pauseFlush failed", { session: id, error: e instanceof Error ? e : String(e) })
    }
  }

  function foreground(id: string): void {
    const runtime = runtimes.get(id)
    if (!runtime || runtime.kind !== "running") return
    try { runtime.session.adapter.resumeFlush() } catch (e) {
      log.warn("resumeFlush failed", { session: id, error: e instanceof Error ? e : String(e) })
    }
  }

  function remove(id: string): void {
    runtimes.delete(id)
  }

  return {
    register,
    promote,
    get,
    has,
    get size() { return runtimes.size },
    teardown,
    teardownAll,
    background,
    foreground,
    getRunningIds,
    remove,
  }
}

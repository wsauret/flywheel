/**
 * Shell lifecycle helpers — extracted from flywheel-shell.tsx
 *
 * Contains lifecycle-related utilities that can be cleanly separated
 * from the component's signal/ref graph:
 *
 *   - `createDepsCache(toast)` — lazy-cached WorkflowDeps with error toast
 *   - `createContextIndexerCache(getProjectCwd)` — lazy-cached ContextIndexer
 *   - `getProjectCwd(getDepsOrWarn)` — convenience one-liner
 *   - `clearQueueRuntime(refs)` — shuts down queue runtime without touching session/store
 *   - `cleanupQuestionSubscriptions(refs)` — disposes question wiring + clears signal
 *   - `cleanupQueueSubscriptions(refs)` — disposes queue event subscriptions + clears signals
 *
 * All dependencies are injected — no SolidJS signals or component-level
 * state captured in closures.
 */

import { ContextIndexer } from "../../memory/indexer"
import { prepareWorkflowDeps } from "../../engines/workflow-deps"
import { killAllActiveProcesses } from "../../worker/process-lifecycle"
import { resetInterruptState } from "./interrupt-controller"

import type { WorkflowDeps } from "../../engines/workflow-deps"
import type { StepExecutor } from "../../queue/executor"
import type { Queue } from "../../queue/types"
import type { StdinHandle } from "../../worker/spawner"
import type { QuestionWiring } from "../utils/question-wiring"
import type { Unsubscribe } from "../../events/event-bus"
import type { QuestionRequest } from "../../queue/question-service"
import type { QueueProgressInfo } from "./shell-queue"
import type { QueueStepState } from "../routes/work/state/types"

// ---------------------------------------------------------------------------
// Toast duck type (avoids importing the context provider)
// ---------------------------------------------------------------------------

export interface ToastLike {
  show(options: { message: string; variant: string; duration?: number }): void
}

// ---------------------------------------------------------------------------
// createDepsCache — lazy-cached WorkflowDeps
// ---------------------------------------------------------------------------

export interface DepsCache {
  /** Get workflow deps (lazy-init, cached). Returns null on config error. */
  getDepsOrWarn(): WorkflowDeps | null
  /** Reset the cache (e.g. after config change). */
  reset(): void
}

/**
 * Create a lazy-cached WorkflowDeps accessor.
 * On first successful call the result is cached; on failure a toast is shown
 * and subsequent calls short-circuit to null.
 */
export function createDepsCache(toast: ToastLike): DepsCache {
  let _cachedDeps: WorkflowDeps | null = null
  let _depsAttempted = false

  return {
    getDepsOrWarn(): WorkflowDeps | null {
      if (_cachedDeps) return _cachedDeps
      if (_depsAttempted) return null // Already failed once
      _depsAttempted = true
      try {
        _cachedDeps = prepareWorkflowDeps()
        return _cachedDeps
      } catch (err) {
        toast.show({
          message: `Config error: ${err instanceof Error ? err.message : String(err)}`,
          variant: "error",
        })
        return null
      }
    },
    reset() {
      _cachedDeps = null
      _depsAttempted = false
    },
  }
}

// ---------------------------------------------------------------------------
// createContextIndexerCache — lazy-cached ContextIndexer
// ---------------------------------------------------------------------------

export interface ContextIndexerCache {
  /** Get or create the shared ContextIndexer instance. */
  getOrCreateContextIndexer(): ContextIndexer
  /** Dispose and clear the cached indexer (call on unmount). */
  dispose(): void
}

/**
 * Create a lazy-cached ContextIndexer accessor.
 * The indexer is created on first call using the given `getProjectCwd` accessor.
 */
export function createContextIndexerCache(
  getProjectCwd: () => string,
): ContextIndexerCache {
  let _sharedContextIndexer: ContextIndexer | null = null

  return {
    getOrCreateContextIndexer(): ContextIndexer {
      if (!_sharedContextIndexer) {
        _sharedContextIndexer = new ContextIndexer(getProjectCwd())
      }
      return _sharedContextIndexer
    },
    dispose() {
      if (_sharedContextIndexer) {
        _sharedContextIndexer.dispose()
        _sharedContextIndexer = null
      }
    },
  }
}

// ---------------------------------------------------------------------------
// getProjectCwd — convenience one-liner
// ---------------------------------------------------------------------------

/**
 * Get project_cwd from WorkflowDeps, falling back to "." on failure.
 */
export function getProjectCwd(getDepsOrWarn: () => WorkflowDeps | null): string {
  return getDepsOrWarn()?.config.project_cwd ?? "."
}

// ---------------------------------------------------------------------------
// cleanupQuestionSubscriptions
// ---------------------------------------------------------------------------

export interface QuestionCleanupRefs {
  activeQuestionWiring: { current: QuestionWiring | null }
  setPendingQuestion: (q: QuestionRequest | null) => void
}

/**
 * Dispose question wiring and clear the pending question signal.
 */
export function cleanupQuestionSubscriptions(refs: QuestionCleanupRefs): void {
  if (refs.activeQuestionWiring.current) {
    refs.activeQuestionWiring.current.cleanup()
    refs.activeQuestionWiring.current = null
  }
  refs.setPendingQuestion(null)
}

// ---------------------------------------------------------------------------
// cleanupQueueSubscriptions
// ---------------------------------------------------------------------------

export interface QueueCleanupRefs {
  queueUnsubs: { current: Unsubscribe[] }
  setActiveQueueInfo: (info: QueueProgressInfo | null) => void
  setShellQueueSteps: (steps: QueueStepState[]) => void
  isQueueRunning: { current: boolean }
}

/**
 * Dispose queue event subscriptions and reset queue-related signals.
 */
export function cleanupQueueSubscriptions(refs: QueueCleanupRefs): void {
  for (const unsub of refs.queueUnsubs.current) unsub()
  refs.queueUnsubs.current = []
  refs.setActiveQueueInfo(null)
  refs.setShellQueueSteps([])
  refs.isQueueRunning.current = false
}

// ---------------------------------------------------------------------------
// clearQueueRuntime
// ---------------------------------------------------------------------------

export interface ClearQueueRuntimeRefs {
  activeStepExecutor: { current: StepExecutor | null }
  activeQueue: { current: Queue | null }
  activeStdinHandleRef: { current: StdinHandle | null }
  setIsInterrupted: (v: boolean) => void
  pendingInjection: { current: string | null }
  capturedWorkerSessionId: { current: string | undefined }
}

/**
 * Shut down queue runtime without touching session, store, adapter, or
 * subscriptions.
 *
 * Used by both teardownActiveWorkflow() (full cleanup) and
 * pauseQueue() (partial cleanup — keeps store/adapter alive).
 *
 * Returns the promise from killAllActiveProcesses (fire-and-forget).
 */
export function clearQueueRuntime(refs: ClearQueueRuntimeRefs): Promise<void> | undefined {
  if (refs.activeStepExecutor.current) {
    refs.activeStepExecutor.current.requestShutdown()
    refs.activeStepExecutor.current = null
  }
  refs.activeQueue.current = null
  refs.activeStdinHandleRef.current = null
  // Reset interrupt state
  resetInterruptState({
    setIsInterrupted: refs.setIsInterrupted,
    pendingInjection: refs.pendingInjection,
    capturedWorkerSessionId: refs.capturedWorkerSessionId,
  })
  // Kill all active worker processes (fire-and-forget)
  const shutdownPromise = killAllActiveProcesses().catch(() => {})
  return shutdownPromise
}

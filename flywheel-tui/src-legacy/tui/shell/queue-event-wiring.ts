/**
 * Queue event wiring — maps queue event bus events to TUI signal updates.
 *
 * Handles: step status transitions, queue progress tracking, sprint iteration
 * counting, dynamic step insertion/removal, and output flush scheduling.
 *
 * Split from queue-execution-runner.ts for single-responsibility clarity.
 * This module is pure event→signal mapping; no queue execution logic.
 */

import type { Queue } from "../../queue/types"
import type { EventBus, Unsubscribe } from "../../events/event-bus"
import type { OutputFlusher } from "../../session/output-persistence"
import type { QueueStepState } from "../types"
import type { QueueProgressInfo } from "../../orchestration/queue-builder"
import type { SprintIterationInfo } from "../utils/format"
import type { FlywheelConfig } from "../../config/loader"

// ---------------------------------------------------------------------------
// setupQueueEventSubscriptions
// ---------------------------------------------------------------------------

export interface SetupQueueEventSubsOpts {
  eventBus: EventBus
  queue: Queue
  config: FlywheelConfig
  setActiveQueueInfo: (info: QueueProgressInfo | null) => void
  setActiveSprintInfo: (info: SprintIterationInfo | null) => void
  setActiveWorkflowName: (name: string) => void
  setShellQueueSteps: (updater: QueueStepState[] | ((prev: QueueStepState[]) => QueueStepState[])) => void
  activeFlusher: { current: OutputFlusher | null }
  /** Initial step counter (0 for start, N for resume where N = already-completed). */
  initialStepCount?: number
}

/**
 * Wire queue event bus subscriptions that update UI signals.
 * Replaces the ~100 lines of duplicated event bus subscriptions that
 * were previously inline in both startQueueExecution and resumeSession.
 *
 * Returns an array of unsubscribe functions the caller must clean up.
 */
export function setupQueueEventSubscriptions(opts: SetupQueueEventSubsOpts): Unsubscribe[] {
  const {
    eventBus, queue, config,
    setActiveQueueInfo, setActiveSprintInfo, setActiveWorkflowName, setShellQueueSteps,
    activeFlusher,
    initialStepCount = 0,
  } = opts

  let stepCounter = initialStepCount
  // Sprint detection: a queue with verify-type steps is a sprint queue
  let isSprintQueue = queue.steps.some(s => s.type === "verify")
  let sprintWorkStepCount = 0

  return [
    eventBus.subscribeToType("queue:initialized", (e) => {
      stepCounter = initialStepCount
      sprintWorkStepCount = 0
      // Re-check sprint status in case queue was rebuilt
      isSprintQueue = queue.steps.some(s => s.type === "verify")
      if (isSprintQueue) {
        const maxIter = config.sprint?.max_iterations ?? 5
        setActiveSprintInfo({ iteration: 0, maxIterations: maxIter })
      }
      setActiveQueueInfo({
        currentStep: initialStepCount > 0 ? initialStepCount + 1 : 1,
        totalSteps: e.stepIds.length,
        stepName: initialStepCount > 0
          ? (queue.steps[queue.cursor]?.type ?? "step")
          : (queue.steps[0]?.type ?? "step"),
      })
      setActiveWorkflowName(
        initialStepCount > 0
          ? (queue.steps[queue.cursor]?.type ?? "work")
          : (queue.steps[0]?.type ?? "work"),
      )
    }),
    eventBus.subscribeToType("queue:step-started", (e) => {
      stepCounter++
      setActiveQueueInfo({
        currentStep: stepCounter,
        totalSteps: queue.steps.length,
        stepName: e.stepType,
      })
      setActiveWorkflowName(e.stepType)
    }),
    eventBus.subscribeToType("queue:completed", () => {
      setActiveQueueInfo(null)
      setActiveSprintInfo(null)
      // Final flush on queue completion
      if (activeFlusher.current) {
        activeFlusher.current.schedule()
        activeFlusher.current.flush().catch(() => {})
      }
    }),
    eventBus.subscribeToType("queue:failed", () => {
      setActiveQueueInfo(null)
      setActiveSprintInfo(null)
    }),
    // Event-driven flush: persist output after each step completes
    eventBus.subscribeToType("queue:step-completed", () => {
      if (activeFlusher.current) {
        activeFlusher.current.schedule()
      }
    }),
    // Sprint iteration tracking for telemetry bar
    eventBus.subscribeToType("queue:step-started", (e) => {
      if (!isSprintQueue) return
      if (e.stepType === "work") {
        sprintWorkStepCount++
        const maxIter = config.sprint?.max_iterations ?? 5
        setActiveSprintInfo({ iteration: sprintWorkStepCount, maxIterations: maxIter })
      } else if (e.stepType !== "verify") {
        // Non-sprint step (escalation: plan/review) — clear sprint info
        setActiveSprintInfo(null)
      }
    }),
    // Direct reactive queue steps signal updates
    eventBus.subscribeToType("queue:step-started", (e) => {
      setShellQueueSteps((prev: QueueStepState[]) =>
        prev.map((s) =>
          s.id === e.stepId
            ? { ...s, status: "running" as const, startTime: Date.now() }
            : s,
        ),
      )
    }),
    eventBus.subscribeToType("queue:step-completed", (e) => {
      setShellQueueSteps((prev: QueueStepState[]) =>
        prev.map((s) => {
          if (s.id !== e.stepId) return s
          const now = Date.now()
          const duration = s.startTime ? (now - s.startTime) / 1000 : 0
          return { ...s, status: "completed" as const, endTime: now, duration }
        }),
      )
    }),
    eventBus.subscribeToType("queue:step-failed", (e) => {
      setShellQueueSteps((prev: QueueStepState[]) =>
        prev.map((s) => {
          if (s.id !== e.stepId) return s
          const now = Date.now()
          return { ...s, status: "failed" as const, endTime: now, error: e.reason }
        }),
      )
    }),
    eventBus.subscribeToType("queue:step-inserted", (e) => {
      setShellQueueSteps((prev: QueueStepState[]) => {
        const idx = prev.findIndex((s) => s.id === e.afterStepId)
        const insertIdx = idx >= 0 ? idx + 1 : prev.length
        const newStep: QueueStepState = {
          id: e.stepId,
          type: e.stepType,
          title: e.stepTitle,
          status: "pending",
        }
        return [...prev.slice(0, insertIdx), newStep, ...prev.slice(insertIdx)]
      })
    }),
    eventBus.subscribeToType("queue:step-removed", (e) => {
      setShellQueueSteps((prev: QueueStepState[]) => prev.filter((s) => s.id !== e.stepId))
    }),
  ]
}

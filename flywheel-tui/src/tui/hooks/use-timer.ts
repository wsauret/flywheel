/**
 * SolidJS hook for subscribing to a TimerService instance.
 */

import { createSignal, onCleanup } from "solid-js"
import { TimerService, timerService, type TimerStatus, type PauseReason } from "../shared/services/timer.js"

/** Idle-state defaults returned when the timer ref is null. */
const IDLE_TIMER_VALUES = {
  workflowRuntime: () => "00:00" as string,
  agentDuration: (_id: string) => "" as string,
  status: () => "idle" as TimerStatus,
  isPaused: () => false,
  isRunning: () => false,
  isStopped: () => false,
  pauseReason: () => undefined as PauseReason | undefined,
  service: null as TimerService | null,
} as const

/**
 * Hook to use a timer service in SolidJS components.
 *
 * @param timerRef - The `TimerService` instance to subscribe to.
 *   - `undefined` (default) → subscribes to the legacy global `timerService` singleton.
 *   - A `TimerService` instance → subscribes to that specific instance.
 *   - `null` → returns idle-state defaults (no subscription, no ticking).
 */
export function useTimer(timerRef?: TimerService | null) {
  // null → idle defaults, no subscription
  if (timerRef === null) {
    return IDLE_TIMER_VALUES
  }

  const timer = timerRef ?? timerService
  const [tick, setTick] = createSignal(0)

  // Subscribe immediately (not in onMount) to catch early updates
  const unsubscribe = timer.subscribe(() => {
    setTick((t) => t + 1)
  })

  // Clean up on component unmount
  onCleanup(unsubscribe)

  return {
    // Formatted strings - include tick() to create reactive dependency
    workflowRuntime: () => {
      tick() // Create reactive dependency
      return timer.getWorkflowRuntime()
    },
    agentDuration: (id: string) => {
      tick() // Create reactive dependency
      return timer.getAgentDuration(id)
    },

    // Status
    status: () => {
      tick()
      return timer.getStatus()
    },
    isPaused: () => {
      tick()
      return timer.isPaused()
    },
    isRunning: () => {
      tick()
      return timer.isRunning()
    },
    isStopped: () => {
      tick()
      return timer.isStopped()
    },
    pauseReason: () => {
      tick()
      return timer.getPauseReason()
    },

    // Direct service access for imperative calls
    service: timer,
  }
}

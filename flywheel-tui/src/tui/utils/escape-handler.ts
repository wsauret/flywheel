/**
 * Escape Handler — Double-Esc Timing Logic
 *
 * Pure state machine for handling escape key during workflow execution:
 * - First Esc → returns "show-hint" (display "press again to stop")
 * - Second Esc within timeout → returns "stop" (trigger stopWorkflow)
 * - After timeout expires → resets, next Esc returns "show-hint" again
 *
 * This is a pure function factory with no TUI dependencies,
 * making it fully testable without OpenTUI runtime.
 */

export type EscapeResult = "show-hint" | "stop"

export interface EscapeHandler {
  /** Call when Esc is pressed. Returns the action to take. */
  handleEscape(): EscapeResult
  /** Reset the handler (e.g., when workflow ends). */
  reset(): void
  /** Clean up any pending timers. */
  dispose(): void
}

export interface EscapeHandlerOptions {
  /** Timeout in ms before the hint resets (default: 5000) */
  timeoutMs?: number
}

export function createEscapeHandler(
  options: EscapeHandlerOptions = {},
): EscapeHandler {
  const timeoutMs = options.timeoutMs ?? 5000
  let hintShown = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function reset() {
    clearTimer()
    hintShown = false
  }

  function handleEscape(): EscapeResult {
    if (hintShown) {
      // Second Esc within timeout → stop
      reset()
      return "stop"
    }

    // First Esc → show hint, start timeout
    hintShown = true
    clearTimer()
    timer = setTimeout(() => {
      hintShown = false
      timer = null
    }, timeoutMs)

    return "show-hint"
  }

  return {
    handleEscape,
    reset,
    dispose: reset,
  }
}

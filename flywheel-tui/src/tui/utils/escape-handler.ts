/**
 * Escape Handler — 3-State Interrupt Logic
 *
 * Pure state machine for handling escape key during workflow execution:
 * - First Esc → returns "interrupt" (send SIGINT, show "press again to kill")
 * - Second Esc within timeout → returns "kill" (full process kill + pause queue)
 * - After timeout expires → resets, next Esc returns "interrupt" again
 *
 * Legacy aliases: "show-hint" maps to "interrupt", "stop" maps to "kill".
 * The old names are kept as type union members for backward compatibility
 * with existing shell-modes.ts references.
 *
 * This is a pure function factory with no TUI dependencies,
 * making it fully testable without OpenTUI runtime.
 */

export type EscapeResult = "interrupt" | "kill"

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
      // Second Esc within timeout → kill
      reset()
      return "kill"
    }

    // First Esc → interrupt, start timeout
    hintShown = true
    clearTimer()
    timer = setTimeout(() => {
      hintShown = false
      timer = null
    }, timeoutMs)

    return "interrupt"
  }

  return {
    handleEscape,
    reset,
    dispose: reset,
  }
}

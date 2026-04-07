/**
 * Headless Workflow Timer
 *
 * TUI's TimerService drives display refresh ticks. Headless has no display,
 * so this is intentionally a no-op.
 */

import type { WorkflowTimer } from "../workflow-session"

export function createHeadlessTimer(): WorkflowTimer {
  return {
    stop(): void {
      // No-op — headless mode has no display ticks to stop.
    },
  }
}

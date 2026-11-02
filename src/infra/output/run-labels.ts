import type { PausedBy } from "../output-blocks.js"

/** The words every surface uses for how a turn or a child's run ended or
 *  continued. They live with the output blocks whose states they name, so the
 *  projections that write a row's text and the clients that label a card read
 *  the same words (PI-AGENT-020, PI-INTERACTION-043, PI-INTERACTION-044). */

/** An interrupted turn or run: who interrupted it is the one fact a person needs. */
export function interruptedLabel(by: PausedBy): string {
  switch (by) {
    case "person": return "Interrupted"
    case "agent": return "Interrupted by the parent"
    case "runtime": return "Interrupted by the runtime"
  }
}

/** An interrupted run ended without a result because its runner stopped. */
export const SUBAGENT_INTERRUPTED_LABEL = "Interrupted"

/** A turn the process running it never finished: no one interrupted it. */
export const UNEXPECTED_EXIT_LABEL = "Interrupted by an unexpected exit"

/** An interrupted or unexpectedly exited turn continued from where it stopped. */
export const RESUMED_LABEL = "Resumed"

/** A child a person ended with Stop: terminal, never resumed. */
export const STOPPED_LABEL = "Stopped"

/** A child the requesting agent canceled: terminal, never resumed. */
export const CANCELED_LABEL = "Canceled"

/** A subagent that reached its turn budget: what it had, not a completion. */
export const PARTIAL_LABEL = "Partial"

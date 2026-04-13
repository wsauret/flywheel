/**
 * Session Types
 *
 * Session-level discriminants and shared type definitions.
 */

/** Discriminant for what kind of session this is (workflow vs. interactive chat). */
export type SessionKind = "workflow" | "chat"

// ---------------------------------------------------------------------------
// Shared runner lifecycle result types
// ---------------------------------------------------------------------------

/** Base result when a runner completes normally. */
export interface RunnerDoneResult {
  terminalTitle: string
}

/** Base result when a runner encounters an error. */
export interface RunnerErrorResult {
  errorMessage: string
  terminalTitle: string
}

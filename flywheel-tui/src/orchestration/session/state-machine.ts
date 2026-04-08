/**
 * Session State Machine (3-state model)
 *
 * Defines the 3 lifecycle states a session can be in and the valid
 * transitions between them. The state is persisted to disk, so the
 * schema uses `z.enum` (boundary type).
 *
 * Terminal state: `completed` — no outbound transitions.
 * `paused` can only transition back to `active`.
 *
 * Error details live on the `errorMessage` field, not as a state annotation.
 * Budget exhaustion is signaled by the queue executor's reason string, not session state.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema & type
// ---------------------------------------------------------------------------

export const SessionStateSchema = z.enum([
  "active",
  "paused",
  "completed",
]);

export type SessionState = z.infer<typeof SessionStateSchema>;

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

/**
 * Exhaustive record of valid outbound transitions for each state.
 * Terminal state (`completed`) has an empty array.
 */
export const VALID_TRANSITIONS: Readonly<
  Record<SessionState, readonly SessionState[]>
> = Object.freeze({
  active: ["paused", "completed"],
  paused: ["active"],
  completed: [],
});

// ---------------------------------------------------------------------------
// Transition guard
// ---------------------------------------------------------------------------

/**
 * Pure function — returns `true` if transitioning from `from` to `to` is
 * allowed by the state machine.
 */
export function isValidTransition(
  from: SessionState,
  to: SessionState,
): boolean {
  const targets = VALID_TRANSITIONS[from];
  return targets.includes(to);
}

// ---------------------------------------------------------------------------
// State predicates
// ---------------------------------------------------------------------------

/**
 * Returns `true` if a session in the given state can be resumed.
 * All paused sessions are resumable (user-paused, error-paused, budget-paused).
 */
export function isResumable(state: SessionState): boolean {
  return state === "paused";
}

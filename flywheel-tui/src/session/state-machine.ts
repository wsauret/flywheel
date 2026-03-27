/**
 * Session Lifecycle State Machine
 *
 * Defines the 12 lifecycle states a session can be in and the valid
 * transitions between them. The state is persisted to disk, so the
 * schema uses `z.enum` (boundary type).
 *
 * Terminal states: `archived`, `trashed` — no outbound transitions.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema & type
// ---------------------------------------------------------------------------

export const SessionLifecycleStateSchema = z.enum([
  "new",
  "plan:draft",
  "plan:imported",
  "plan:approved",
  "plan:needs-fix",
  "work:active",
  "work:paused",
  "work:review",
  "budget_exhausted",
  "completed",
  "archived",
  "trashed",
]);

export type SessionLifecycleState = z.infer<typeof SessionLifecycleStateSchema>;

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

/**
 * Exhaustive record of valid outbound transitions for each state.
 * Terminal states (`archived`, `trashed`) have empty arrays.
 */
export const VALID_TRANSITIONS: Readonly<
  Record<SessionLifecycleState, readonly SessionLifecycleState[]>
> = Object.freeze({
  new: ["plan:draft", "plan:imported"],
  "plan:draft": ["plan:imported", "plan:needs-fix", "trashed"],
  "plan:imported": ["plan:approved", "plan:needs-fix", "trashed"],
  "plan:approved": ["work:active", "trashed"],
  "plan:needs-fix": ["plan:imported", "plan:approved", "trashed"],
  "work:active": ["work:paused", "work:review", "completed", "trashed", "budget_exhausted"],
  "work:paused": ["work:active", "trashed", "archived"],
  "budget_exhausted": ["work:active", "trashed"],
  "work:review": ["work:active", "completed", "trashed"],
  completed: ["archived", "trashed", "work:active"],
  archived: [],
  trashed: [],
});

// ---------------------------------------------------------------------------
// Transition guard
// ---------------------------------------------------------------------------

/**
 * Pure function — returns `true` if transitioning from `from` to `to` is
 * allowed by the state machine.
 */
export function isValidTransition(
  from: SessionLifecycleState,
  to: SessionLifecycleState,
): boolean {
  const targets = VALID_TRANSITIONS[from];
  return targets.includes(to);
}

// ---------------------------------------------------------------------------
// Transition path finder
// ---------------------------------------------------------------------------

/**
 * Find the shortest valid transition path from `from` to `to` using BFS.
 *
 * Returns an array of intermediate states (excluding `from`, including `to`),
 * or `null` if no path exists.
 *
 * Used by queue completion handlers to safely transition sessions that
 * may be stuck in an intermediate state (e.g., "new") to a target state
 * (e.g., "work:paused") by chaining through required intermediate states.
 *
 * @example
 *   findTransitionPath("new", "work:paused")
 *   // => ["plan:imported", "plan:approved", "work:active", "work:paused"]
 *
 *   findTransitionPath("work:active", "work:paused")
 *   // => ["work:paused"]  (direct transition)
 *
 *   findTransitionPath("archived", "work:active")
 *   // => null  (no path from terminal state)
 */
export function findTransitionPath(
  from: SessionLifecycleState,
  to: SessionLifecycleState,
): SessionLifecycleState[] | null {
  if (from === to) return [];

  // Direct transition available — fast path
  if (isValidTransition(from, to)) return [to];

  // BFS to find shortest path
  const visited = new Set<SessionLifecycleState>([from]);
  const queue: { state: SessionLifecycleState; path: SessionLifecycleState[] }[] = [];

  for (const next of VALID_TRANSITIONS[from]) {
    visited.add(next);
    queue.push({ state: next, path: [next] });
  }

  while (queue.length > 0) {
    const { state, path } = queue.shift()!;
    if (state === to) return path;

    for (const next of VALID_TRANSITIONS[state]) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push({ state: next, path: [...path, next] });
      }
    }
  }

  return null; // No path exists
}

// ---------------------------------------------------------------------------
// State predicates
// ---------------------------------------------------------------------------

/**
 * Returns `true` if a session in the given state can be resumed.
 * Currently only `work:paused` sessions are resumable.
 */
export function isResumable(state: SessionLifecycleState): boolean {
  return state === "work:paused" || state === "budget_exhausted";
}

/**
 * Session Lifecycle State Machine
 *
 * Defines the 11 lifecycle states a session can be in and the valid
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
  "work:active": ["work:paused", "work:review", "completed", "trashed"],
  "work:paused": ["work:active", "trashed", "archived"],
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

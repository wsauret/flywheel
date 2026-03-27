/**
 * Safe State Transition Helper
 *
 * Provides a resilient state transition function that chains through
 * intermediate states when a direct transition is invalid. Used by
 * queue completion handlers to gracefully handle sessions that
 * failed to transition through the proper lifecycle during startup.
 *
 * Example: If a session is stuck in "new" because the startup transitions
 * failed, and the queue completion tries to set "work:paused", this
 * helper discovers the path new -> plan:imported -> plan:approved ->
 * work:active -> work:paused and executes each step.
 */

import {
  findTransitionPath,
  type SessionLifecycleState,
} from "./state-machine";
import { Log } from "../utils/log";

const log = Log.create({ service: "session.safe-transition" });

/**
 * Attempt a state transition, recovering from invalid transition errors
 * by chaining through intermediate states.
 *
 * When a direct transition fails, uses `findTransitionPath` to discover
 * and execute the shortest valid path to the target state.
 *
 * If all recovery attempts fail, the error is silently swallowed —
 * callers should never crash over a state persistence issue.
 *
 * @param updateState - The state update function (typically manager.updateState)
 * @param sessionId - The session to update
 * @param targetState - The desired target state
 */
export function safeUpdateState(
  updateState: (id: string, state: SessionLifecycleState) => void,
  sessionId: string,
  targetState: SessionLifecycleState,
): void {
  try {
    updateState(sessionId, targetState);
  } catch {
    // Direct transition failed — try to chain through intermediate states.
    // We don't have direct access to the current state, so we try the most
    // common "stuck" states and attempt to chain through the proper path.
    const stuckStates: SessionLifecycleState[] = [
      "new",
      "plan:draft",
      "plan:imported",
      "plan:approved",
      "plan:needs-fix",
    ];

    for (const assumedState of stuckStates) {
      const path = findTransitionPath(assumedState, targetState);
      if (path && path.length > 0) {
        try {
          for (const intermediate of path) {
            updateState(sessionId, intermediate);
          }
          return; // Success — chain completed
        } catch {
          // This assumed state was wrong — try next
          continue;
        }
      }
    }
    // All recovery attempts failed — log a warning so operators can diagnose.
    log.warn("safeUpdateState: all recovery paths failed", {
      sessionId,
      targetState,
    });
  }
}

/**
 * Queue Completion Handler
 *
 * Extracted from flywheel-shell.tsx so it can be unit-tested without
 * rendering a SolidJS component. Handles:
 *
 * - Flushing and disposing the output flusher
 * - Calling orchestrator.handleAutoArchive() when ship step completed
 * - Transitioning non-ship completions to work:paused (resumable)
 * - Showing toast notification on auto-archive
 *
 * Only a queue that completes a ship step (i.e. all possible steps)
 * transitions to "completed". Partial queues (plan-only, plan+work,
 * plan+work+review) leave the session in work:paused so it's resumable.
 */

import type {
  QueueResult,
  CompletedStepResult,
} from "../../queue/queue-types";
import type { SessionLifecycleState } from "../../session/state-machine";
import { safeUpdateState } from "../../session/safe-transition";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected into handleQueueCompletion. */
export interface QueueCompletionDeps {
  orchestrator: {
    handleAutoArchive(
      id: string,
      results: CompletedStepResult[],
    ): Promise<void>;
  };
  sessionId: string | null;
  flusher: { flush(): Promise<void>; dispose(): void } | null;
  toast: { show(opts: { message: string; variant: string }): void };
  updateState: (id: string, state: SessionLifecycleState) => void;
  refreshList: () => void;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle queue completion: flush output, auto-archive if ship completed,
 * or transition to work:paused for partial queues (no ship).
 *
 * Called from the shell's `queueMicrotask` block after `stepExecutor.run()` resolves.
 *
 * Resilient to state transition errors: if the session is stuck in an
 * intermediate state (e.g., "new" because the startup transitions failed),
 * this handler chains through the required intermediate states rather than
 * throwing.
 */
export async function handleQueueCompletion(
  result: QueueResult,
  deps: QueueCompletionDeps,
): Promise<void> {
  // 1. Always flush and dispose the flusher
  if (deps.flusher) {
    try {
      await deps.flusher.flush();
    } catch {
      // Best effort — don't block completion on flush failure
    }
    deps.flusher.dispose();
  }

  // 2. Bail if no session ID
  if (!deps.sessionId) return;

  // 3. Only process completed queues — interrupted/failed ones leave state as-is
  if (!result.completed) return;

  // 4. Check if ship step is present and completed
  const hasShipCompleted = result.stepResults.some(
    (r: CompletedStepResult) => r.workflow === "ship" && r.completed,
  );

  if (hasShipCompleted) {
    // Auto-archive: orchestrator handles completed → archived + worktree cleanup
    await deps.orchestrator.handleAutoArchive(
      deps.sessionId,
      result.stepResults,
    );
    deps.toast.show({
      message: "Session shipped and archived",
      variant: "info",
    });
  } else {
    // Queue completed successfully but no ship step — mark as completed.
    safeUpdateState(deps.updateState, deps.sessionId, "completed");
    deps.refreshList();
  }
}

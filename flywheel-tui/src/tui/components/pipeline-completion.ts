/**
 * Pipeline Completion Handler
 *
 * Extracted from flywheel-shell.tsx so it can be unit-tested without
 * rendering a SolidJS component. Handles:
 *
 * - Flushing and disposing the output flusher
 * - Calling orchestrator.handleAutoArchive() when ship stage completed
 * - Transitioning non-ship completions to work:paused (resumable)
 * - Showing toast notification on auto-archive
 *
 * Only a pipeline that completes the ship stage (i.e. all possible stages)
 * transitions to "completed". Partial pipelines (plan-only, plan+work,
 * plan+work+review) leave the session in work:paused so it's resumable.
 *
 * Phase 7 — Auto-Archive on Ship.
 */

import type {
  PipelineResult,
  PipelineStageResult,
} from "../../controller/workflow-pipeline";
import type { SessionLifecycleState } from "../../session/state-machine";
import { safeUpdateState } from "../../session/safe-transition";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected into handlePipelineCompletion. */
export interface PipelineCompletionDeps {
  orchestrator: {
    handleAutoArchive(
      id: string,
      results: PipelineStageResult[],
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
 * Handle pipeline completion: flush output, auto-archive if ship completed,
 * or transition to work:paused for partial pipelines (no ship).
 *
 * Called from the shell's `queueMicrotask` block after `pipeline.run()` resolves.
 *
 * Resilient to state transition errors: if the session is stuck in an
 * intermediate state (e.g., "new" because the startup transitions failed),
 * this handler chains through the required intermediate states rather than
 * throwing. This prevents the "Invalid state transition: new -> work:paused"
 * error that was observed in E2E testing.
 */
export async function handlePipelineCompletion(
  result: PipelineResult,
  deps: PipelineCompletionDeps,
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

  // 3. Only process completed pipelines — interrupted/failed ones leave state as-is
  if (!result.completed) return;

  // 4. Check if ship stage is present and completed
  const hasShipCompleted = result.stageResults.some(
    (r) => r.workflow === "ship" && r.completed,
  );

  if (hasShipCompleted) {
    // Auto-archive: orchestrator handles completed → archived + worktree cleanup
    await deps.orchestrator.handleAutoArchive(
      deps.sessionId,
      result.stageResults,
    );
    deps.toast.show({
      message: "Session shipped and archived",
      variant: "info",
    });
  } else {
    // Non-ship completion: session still has stages left (e.g. ship).
    // Transition to work:paused so it's resumable — only a pipeline that
    // includes ship (i.e. all possible stages) should mark "completed".
    // Uses safeUpdateState to handle sessions stuck in intermediate states
    // (e.g., "new") by chaining through required transitions.
    safeUpdateState(deps.updateState, deps.sessionId, "work:paused");
    deps.refreshList();
  }
}

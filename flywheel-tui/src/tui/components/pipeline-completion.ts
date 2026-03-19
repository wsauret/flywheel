/**
 * Pipeline Completion Handler
 *
 * Extracted from flywheel-shell.tsx so it can be unit-tested without
 * rendering a SolidJS component. Handles:
 *
 * - Flushing and disposing the output flusher
 * - Calling orchestrator.handleAutoArchive() when ship stage completed
 * - Transitioning non-ship completions to "completed"
 * - Showing toast notification on auto-archive
 *
 * Phase 7 — Auto-Archive on Ship.
 */

import type {
  PipelineResult,
  PipelineStageResult,
} from "../../controller/workflow-pipeline";
import type { SessionLifecycleState } from "../../session/state-machine";

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
 * or transition to "completed" for non-ship pipelines.
 *
 * Called from the shell's `queueMicrotask` block after `pipeline.run()` resolves.
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
    // Non-ship completion: just transition to completed
    deps.updateState(deps.sessionId, "completed");
    deps.refreshList();
  }
}

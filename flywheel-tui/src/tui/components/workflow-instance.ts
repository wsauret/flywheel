import type { WorkflowInstance } from "../../types/workflow-instance"
import { mapLifecycleToStatus } from "../../types/workflow-instance"
import type { SessionRuntime, RunningRuntime } from "./session-runtime"
import type { SessionSummary } from "../../session/manager"

/**
 * Build a WorkflowInstance from runtime + persisted session data.
 */
export function buildWorkflowInstance(
  sessionId: string,
  runtime: SessionRuntime | undefined,
  persisted: SessionSummary | null,
): WorkflowInstance {
  const status = persisted
    ? mapLifecycleToStatus(persisted.lifecycleState)
    : runtime?.kind === "running" ? "running" : "pending"

  const planPath = persisted?.planPath ?? runtime?.session?.planPath ?? null
  const currentStage = runtime?.kind === "running" ? "work" : null
  const workerPid = runtime?.kind === "running" ? (runtime as RunningRuntime).workerPid : null

  return {
    session_id: sessionId,
    status,
    plan_path: planPath,
    current_step: currentStage,
    worker_pid: workerPid,
  }
}

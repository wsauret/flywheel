import type { SessionLifecycleState } from "../../session/state-machine"
import type { SessionRuntime, RunningRuntime } from "./session-runtime"
import type { SessionSummary } from "../../session/manager"

export type WorkflowInstanceStatus =
  | "pending"
  | "running"
  | "paused"
  | "budget_exhausted"
  | "completed"
  | "failed"

export function mapLifecycleToStatus(state: SessionLifecycleState): WorkflowInstanceStatus {
  switch (state) {
    case "new":
    case "plan:draft":
    case "plan:imported":
    case "plan:approved":
    case "plan:needs-fix":
      return "pending"
    case "work:active":
    case "work:review":
      return "running"
    case "work:paused":
      return "paused"
    case "budget_exhausted":
      return "budget_exhausted"
    case "completed":
      return "completed"
    case "archived":
      return "completed"
    case "trashed":
      return "failed"
  }
}

export interface WorkflowInstance {
  session_id: string
  status: WorkflowInstanceStatus
  plan_path: string | null
  current_step: string | null
  worker_pid: number | null
}

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
  const currentStep = runtime?.kind === "running" ? "work" : null
  const workerPid = runtime?.kind === "running" ? (runtime as RunningRuntime).workerPid : null

  return {
    session_id: sessionId,
    status,
    plan_path: planPath,
    current_step: currentStep,
    worker_pid: workerPid,
  }
}

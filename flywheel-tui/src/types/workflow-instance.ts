import type { SessionLifecycleState } from "../session/state-machine"

export type WorkflowInstanceStatus =
  | "pending"
  | "running"
  | "paused"
  | "budget_exhausted"
  | "completed"
  | "failed"

/**
 * Map all 12 SessionLifecycleState values to WorkflowInstanceStatus.
 */
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
  current_stage: string | null
  worker_pid: number | null
}

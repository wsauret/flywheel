import type { WorkflowView } from "../../workflows/view/types.js"
import { isResumable, type SessionLifecycleState } from "./types.js"

interface WorkflowResumeCandidate {
  kind: "workflow" | "chat" | "subagent"
  lifecycleState: SessionLifecycleState
  workflowState?: WorkflowView["status"]
}

export function isWorkflowResumeCandidate(candidate: WorkflowResumeCandidate): boolean {
  return candidate.kind === "workflow"
    && isResumable(candidate.lifecycleState)
    && candidate.workflowState !== undefined
    && candidate.workflowState !== "completed"
}

import type { AsyncEventStateReadSurface } from "../../../infra/event-store-types.js"
import { workflowAgentTitle } from "../../../protocol/client/workflow-agent.js"
import { attemptNodeIdOf } from "../../../workflows/vm/graph-types.js"
import type { WorkflowView } from "../../../workflows/view/types.js"
import { createReplayingWorkflowView } from "../../../workflows/view/view-projection.js"

/** The human title of the session that runs `attemptId`, from its run's
 *  plan: its phase and its item key or agent id. Undefined when the plan is
 *  unreadable or holds no agent for the attempt. */
export function workflowAgentSessionTitle(view: WorkflowView | null, attemptId: string): string | undefined {
  const agentNodeId = attemptNodeIdOf(attemptId)
  return view === null || agentNodeId === null ? undefined : workflowAgentTitle({ attempts: [], tree: view.tree }, agentNodeId)
}

/** {@link workflowAgentSessionTitle} for an attempt that starts now, read
 *  through the run's registered queue projection. */
export async function readWorkflowAgentSessionTitle(reader: AsyncEventStateReadSurface, workflowId: string, attemptId: string): Promise<string | undefined> {
  return workflowAgentSessionTitle(await createReplayingWorkflowView(reader, workflowId).read(), attemptId)
}

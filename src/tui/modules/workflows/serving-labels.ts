import { createEffect, createMemo, untrack, type Accessor } from "solid-js"
import type { WorkflowOutline } from "../../../protocol/client/workflow-outline.js"
import { sessionServingLabel, type RoleAssignmentView } from "../../../protocol/role-protocol-types.js"

/** The role readings that a workflow card reads its agents' models from. */
export interface WorkflowRoleReadings {
  readonly roleView: (sessionId: string) => RoleAssignmentView | undefined
  readonly ensureRoleViews: (sessionIds: readonly string[]) => void
}

/** The model and effort that serve each agent of a workflow, by agent node
 *  id: the serving reading of the agent's current session, which updates
 *  the moment the runtime publishes a change. An agent with no session yet
 *  has none and costs no read. The role cache reads only sessions that it
 *  has not read yet, so a change to the outline costs no durable read. */
export function createWorkflowServingLabels(outline: Accessor<WorkflowOutline | undefined>, roles: WorkflowRoleReadings): (agentNodeId: string) => string | undefined {
  const sessions = createMemo(() => new Map(outline()?.phases.flatMap(({ agents }) => agents.flatMap(({ agentNodeId, sessionId }) => sessionId === undefined ? [] : [[agentNodeId, sessionId] as const]))))
  createEffect(() => {
    const ids = [...sessions().values()]
    untrack(() => roles.ensureRoleViews(ids))
  })
  function modelLabel(agentNodeId: string): string | undefined {
    const sessionId = sessions().get(agentNodeId)
    return sessionId === undefined ? undefined : sessionServingLabel(roles.roleView(sessionId))
  }
  return modelLabel
}

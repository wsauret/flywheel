import { createEffect, onCleanup, untrack, type Accessor } from "solid-js"
import type { WorkflowDetail } from "../../../protocol/modules/workflows.js"
import type { FrontendWorkflowView, WorkflowAgentLive } from "../../../protocol/workflow-view-protocol-types.js"
import type { ModuleDomainIntakes } from "../../hooks/create-module-domain-intakes.js"
import { workflowSurfaceReads } from "../../../protocol/client/workflow-surface.js"

export interface WorkflowInspection {
  readonly detail: Accessor<WorkflowDetail | undefined>
  readonly view: Accessor<FrontendWorkflowView | undefined>
  readonly live: Accessor<readonly WorkflowAgentLive[]>
}

/** Holds only workflow cursors. Agent output and activation use the real session. */
export function createWorkflowInspection(intakes: ModuleDomainIntakes, workflowId: Accessor<string>): WorkflowInspection {
  createEffect(() => {
    const id = workflowId()
    const reads = workflowSurfaceReads({ kind: "page" })
    const holds = untrack(() => [
      ...(reads.detail ? [intakes.workflow_detail.retain(id)] : []),
      ...(reads.view ? [intakes.workflow_view.retain(id)] : []),
      ...(reads.live ? [intakes.workflow_live.retain(id)] : []),
    ])
    onCleanup(() => { for (const hold of holds) hold.release() })
  })
  return {
    detail: () => intakes.workflow_detail.view(workflowId()),
    view: () => intakes.workflow_view.view(workflowId()),
    live: () => intakes.workflow_live.view(workflowId())?.agents ?? [],
  }
}

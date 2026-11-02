import type { WorkflowVmHostLifecycle } from "../../workflows/vm/host-types.js"
import type { SessionResourceLifecycle } from "../session/session-resources-service.js"

export type WorkflowOuterLifecycle = Pick<WorkflowVmHostLifecycle, "flushConversation" | "settleBackground" | "disposeAdapters" | "disposeRemaining">

export function composeWorkflowHostLifecycle(
  resources: SessionResourceLifecycle,
  outer: WorkflowOuterLifecycle,
): WorkflowVmHostLifecycle {
  return {
    flushConversation: outer.flushConversation,
    settleBackground: outer.settleBackground,
    drainEventBus: resources.drainEventBus,
    drainWriter: resources.drainWriter,
    disposeProjections: resources.disposeProjections,
    disposeAdapters: outer.disposeAdapters,
    disposeRemaining: outer.disposeRemaining,
  }
}

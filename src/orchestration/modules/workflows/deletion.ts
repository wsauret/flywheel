import type { ModuleWorkflowRuns } from "../../module-seams.js"
import { recordChildWorkflowStop } from "../../session/child-workflow-result.js"
import { reconcileChildSessionCompletions } from "../../session/child-session-reconciliation.js"

/** The launching call settles before teardown, which can wait on its parent. */
export const settleWorkflowDeletion: ModuleWorkflowRuns["settleDeletion"] = async (input) => {
  const binding = input.run.launchedFrom
  const deliverNotification = input.deliverNotification
  await recordChildWorkflowStop({
    reader: input.reader, projectionReader: input.projectionReader, writer: input.writer,
    parentSessionId: binding.parentSessionId, toolUseId: binding.toolUseId,
    childSessionId: input.workflowId, workflowDefinitionId: input.run.workflowDefinitionId, stoppedBy: "person",
  })
  await reconcileChildSessionCompletions({
    parentSessionId: binding.parentSessionId, reader: input.reader,
    projectionReader: input.projectionReader, writer: input.writer,
    ...(deliverNotification ? { deliverNotification: (notice) => deliverNotification(binding.parentSessionId, notice) } : {}),
  })
  await input.abort?.(input.workflowId)
}

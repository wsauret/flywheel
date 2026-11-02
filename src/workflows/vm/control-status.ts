import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import type { CommittedWorkflowControl } from "./committed-control.js"
import { readWorkflowControls } from "./recovery-fold.js"

/** Strict control status for message admission, without reading queue bodies
 *  or context validity, or undefined when control is missing, does not
 *  replay, a row of the workflow is damaged, or the state read fails.
 *  Admission leaves unreadable control to explicit recovery, and the next
 *  call retries. It reads the recovery owner, so each proposal's control
 *  decodes once, and the workflows it has folded cost one request together. */
export async function readWorkflowControlStatuses(reader: AsyncEventStateReadSurface, workflowIds: readonly string[]): Promise<ReadonlyMap<string, CommittedWorkflowControl["status"] | undefined>> {
  const controls = await readWorkflowControls(reader, workflowIds)
  return new Map(workflowIds.map((id) => [id, controls.get(id)?.control.status] as const))
}

/** Control status and the latest fact's time for automatic deletion admission.
 *  Unreadable or missing control has no activity value and cannot prove
 *  inactivity. Control and activity come from one folded state, so they
 *  describe the same committed history. */
export async function readWorkflowActivity(reader: AsyncEventStateReadSurface, workflowIds: readonly string[]) {
  const controls = await readWorkflowControls(reader, workflowIds)
  return new Map(workflowIds.map((id) => {
    const evidence = controls.get(id)
    const latest = evidence?.activity.latest
    return [id, evidence && latest ? { status: evidence.control.status, lastUpdated: latest.timestamp } : undefined] as const
  }))
}

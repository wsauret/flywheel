import { retainedOperationHostHandle } from "../../infra/retained-operation-hosts.js"
import type { ChildControlAnswer, RetainedOperationCell, RetainedOperationCommitResult } from "../module-seams.js"
import type { ChildCut } from "../session/child-continuation.js"
import type { WorkflowLaunchAgentModels } from "../../infra/workflow-types.js"
import type { WorkflowDeliveryAddress } from "../session/conversation/addressed-workflow-messages.js"
import type { BackgroundWorkTracking } from "../agent-runtime/background-work.js"

/** The in-flight kind of a workflow launch that a parent chat accepted and
 *  has not published yet. */
export const WORKFLOW_LAUNCH_OPERATION_KIND = "workflow.launch"

/** The intent stored by past named launches. Remove after 2027-04-30. */
interface WorkflowLaunchIntent {
  readonly workflowDefinitionId: string
  readonly summary?: string
  readonly description: string
  readonly launchCwd?: string
  readonly agents?: WorkflowLaunchAgentModels
}

/** One runtime-origin workflow launch that a parent chat accepted: the ids
 *  the workflow host reserved and the normalized launch intent. The
 *  workflows module stores it as the parent's cell, and its schema conforms
 *  to this shape, so the host and the codec cannot drift. */
export interface WorkflowLaunchOperation {
  readonly kind: typeof WORKFLOW_LAUNCH_OPERATION_KIND
  readonly version: 1
  readonly operationId: string
  readonly parentSessionId: string
  readonly parentConversationId: string
  readonly childSessionId: string
  readonly toolUseId: string
  /** The settled turn-end entry id (`itb-settled-<operationId>`) that the
   *  acknowledgement of the launch takes in the parent conversation. */
  readonly parentEntryId: string
  readonly acceptedAt: string
  readonly initiator: "person" | "headless"
  /** The person's raw command. Cells that candidates wrote before
   *  2026-10-03 carry it; no build writes it now and no reader uses it, so a
   *  stranded cell still decodes. Remove after 2027-04-03. */
  readonly acceptedInput?: string
  readonly launch: WorkflowLaunchIntent
}

/** The host a composition binds for workflow launches: the workflow
 *  controller, which commits an accepted launch when its parent's writer
 *  releases held work, at the end of a turn or while idle. A commit never
 *  throws for a launch that can never start: it answers `refused` with the
 *  notice the parent records. */
export interface WorkflowLaunchHost {
  /** Observes an existing live run from a replacement parent, without starting work. */
  restoreLaunchTracking(childSessionId: string, tasks: BackgroundWorkTracking): Promise<void>
  commitLaunch(operation: WorkflowLaunchOperation, cell: RetainedOperationCell): Promise<RetainedOperationCommitResult>
  /** The one Stop of a launched workflow, whatever its origin: it records
   *  the Stop as the result of the parent's launching call and answers a
   *  model's waiting call from it. It then starts the parent's
   *  reconciliation and the child's teardown, and it resolves without
   *  waiting for either. It reads the child's durable binding, so it needs
   *  no memory of the launch. A Stop of a call that already holds a result
   *  changes nothing. */
  stopLaunch(childSessionId: string, stoppedBy: "person" | "agent"): Promise<void>
  /** The latest cut that a launched workflow waits on: the interrupt that
   *  its live runner carries or recorded, else its agent's turn end, or
   *  nothing for a workflow that no cut ended. */
  launchCut(childSessionId: string, address?: WorkflowDeliveryAddress): Promise<ChildCut | undefined>
  /** The parent agent's Resume of the workflow its call launched. It is
   *  admitted only when `parentMayContinue` admits the latest cut, and then
   *  continues the workflow as a person's Resume does. */
  resumeLaunch(childSessionId: string, address?: WorkflowDeliveryAddress): Promise<ChildControlAnswer>
}

export const workflowLaunchHost = retainedOperationHostHandle<WorkflowLaunchHost>(WORKFLOW_LAUNCH_OPERATION_KIND)


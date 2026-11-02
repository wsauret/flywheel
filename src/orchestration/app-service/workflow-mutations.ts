import { errorMessage } from "../../infra/error-message.js"
import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import { WHOLE_WORKFLOW } from "../session/conversation/addressed-workflow-messages.js"
import { resolveWorkflowDeliveryAddress } from "../workflow-host/workflow-addressing.js"
import type { WorkflowController } from "../workflow-host/controller.js"
import type { RuntimeSupervisor } from "./runtime-supervisor-types.js"
import type { MutationResult, FrontendMutation, WorkflowOperation, WorkflowOperationResult } from "../../protocol/app-service-types.js"

export interface WorkflowMutationDeps {
  readonly projectionReader: AsyncEventStateReadSurface
  readonly controller: Pick<WorkflowController, "resumeWorkflow" | "restartWorkflow">
}

export interface WorkflowOperationDeps {
  readonly projectionReader: AsyncEventStateReadSurface
  readonly supervisor: Pick<RuntimeSupervisor, "interruptSession">
}

type WorkflowMutation = Extract<FrontendMutation, { type: "workflow.resume" | "workflow.restart" }>

export async function handleWorkflowMutation(mutation: WorkflowMutation, deps: WorkflowMutationDeps): Promise<MutationResult<WorkflowMutation>> {
  try {
    switch (mutation.type) {
      case "workflow.resume": {
        // Resume needs no message: a running workflow whose agent a person
        // interrupted continues that agent in its own conversation, a paused
        // workflow resumes its committed control, and one an unexpected exit
        // left running recovers it. Only durable state this release cannot
        // execute, and that recovery can still prove, needs the person's
        // Restart, which publishes the recovery bootstrap (ARCH-WORKFLOWS-034).
        const resolved = mutation.targets?.length
          ? await resolveWorkflowDeliveryAddress(deps.projectionReader, mutation.workflowId, mutation.targets)
          : { ok: true as const, address: WHOLE_WORKFLOW }
        if (!resolved.ok) return { ok: false, error: resolved.refusal }
        const resumed = await deps.controller.resumeWorkflow(mutation.workflowId, resolved.address)
        switch (resumed.kind) {
          case "resumed":
          case "already_running":
            return { ok: true }
          default:
            return { ok: false, error: resumed.message }
        }
      }
      case "workflow.restart": {
        const restarted = await deps.controller.restartWorkflow(mutation.workflowId)
        return restarted.kind === "restarted" ? { ok: true } : { ok: false, error: restarted.message }
      }
    }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

export async function handleWorkflowOperation(operation: WorkflowOperation, deps: WorkflowOperationDeps): Promise<WorkflowOperationResult> {
  const resolved = operation.targets?.length
    ? await resolveWorkflowDeliveryAddress(deps.projectionReader, operation.workflowId, operation.targets, "interrupt")
    : { ok: true as const, address: WHOLE_WORKFLOW }
  if (!resolved.ok) return { kind: "interrupt", interrupted: false, reason: resolved.refusal }
  return { kind: "interrupt", interrupted: await deps.supervisor.interruptSession(operation.workflowId, "person", resolved.address) }
}

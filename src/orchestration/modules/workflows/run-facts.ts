import type { AsyncEventStateReadSurface, EventStoreAppend, StoredFact } from "../../../infra/event-store-types.js"
import { parseWorkflowRunFact, type WorkflowRunFact } from "../../../workflows/run-facts.js"
import type { SessionManager } from "../../session/manager.js"
import type { WorkflowRunCut, WorkflowRunWriter } from "../../workflow-host/run-record.js"
import { createWorkflowRunReader } from "./run-record.js"
import type { WorkflowPublication, WorkflowLaunchBinding } from "../../session/child-session-publication.js"
import { parseWorkflowSessionFact, type WorkflowSessionFact } from "../../../workflows/vm/session-facts.js"
import { buildQueueDeletedFact } from "../../../workflows/view/view-facts.js"

export const workflowAccounting = {
  factTypes: ["workflow.run.registered", "workflow.run.adopted"],
  ancestry(event: StoredFact): { readonly owner: string; readonly parent: string } | null {
    if (!this.factTypes.includes(event.type)) return null
    const fact = parseWorkflowRunFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload })
    if (fact.type !== "workflow.run.registered" && fact.type !== "workflow.run.adopted") return null
    return { owner: event.aggregateId, parent: fact.payload.launchedFrom.parentSessionId }
  },
}

/** Registration precedes the initial control batch, so the root's position includes it. */
export function workflowRegistration(input: WorkflowPublication, executionCwd: string, now: string): readonly WorkflowSessionFact[] {
  const name = input.summary ?? input.description
  return [parseWorkflowRunFact({
    type: "workflow.run.registered", version: 1, actor: "flywheel",
    payload: {
      settings: {
        workflowDefinitionId: input.workflowDefinitionId, executionCwd,
        label: name, name, createdAt: now, lastUpdated: now,
        ...(input.summary !== undefined ? { shortLabel: input.summary } : {}),
        ...(input.authProfileId !== undefined ? { authProfileId: input.authProfileId } : {}),
        roleAssignments: { defaults: input.initialRoles, overrides: {} },
      },
      request: input.description, launchedFrom: input.launchedFrom,
    },
  }), ...input.facts.map((fact) => fact.type === "workflow.control.initialized"
    ? parseWorkflowSessionFact({ ...fact, payload: { control: { ...fact.payload.control, aggregateSeq: fact.payload.control.aggregateSeq + 1 } } })
    : fact)]
}

/** Only committed attempt-start control authorizes a current member session. */
export function startedWorkflowAttempt(facts: readonly WorkflowSessionFact[]): { readonly attemptId: string; readonly conversationId: string } | null {
  const terminal = facts.at(-1)
  return terminal?.type === "workflow.control.committed" && terminal.payload.event.type === "ATTEMPT_STARTED" ? terminal.payload.event : null
}

/** Outcome commits can finish admitted work after deletion has sealed new admission. */
export function workflowSettlement(facts: readonly WorkflowSessionFact[]): boolean {
  const last = facts.at(-1)
  return last?.type === "workflow.run.cut.updated" && last.payload.cut !== null
    || last?.type === "workflow.control.committed" && ["ABORT", "PAUSE", "ATTEMPT_FAILED", "ATTEMPT_SUCCEEDED"].includes(last.payload.event.type)
}

export function workflowCutAppend(workflowId: string, cut: WorkflowRunCut | null): EventStoreAppend {
  return workflowRunAppend(workflowId, { type: "workflow.run.cut.updated", version: 1, actor: "flywheel", payload: { cut } })
}

export async function workflowIsDeleted(reader: AsyncEventStateReadSurface, workflowId: string): Promise<boolean> {
  return (await reader.readSlice({ aggregateId: `workflow:${workflowId}`, types: ["workflow.run.deleted"], limit: 1 })).facts.length > 0
}

export function workflowAdoption(binding: WorkflowLaunchBinding, now: string): WorkflowSessionFact {
  return parseWorkflowRunFact({ type: "workflow.run.adopted", version: 1, actor: "flywheel", payload: { launchedFrom: binding, lastUpdated: now } })
}

export function workflowDeletion(workflowId: string, now: number): readonly EventStoreAppend[] {
  return [
    { ...workflowRunAppend(workflowId, { type: "workflow.run.deleted", version: 1, actor: "flywheel", payload: { lastUpdated: new Date(now).toISOString() } }, now), inFlight: [{ op: "clear_session" }] },
    { aggregateId: `workflow:${workflowId}`, sessionId: workflowId, timestamp: now, ...buildQueueDeletedFact() },
  ]
}

/** Validates a run companion and addresses it to its non-session workflow owner. */
function workflowRunAppend(workflowId: string, fact: WorkflowRunFact, timestamp = Date.now()): EventStoreAppend {
  const parsed = parseWorkflowRunFact(fact)
  return { aggregateId: `workflow:${workflowId}`, sessionId: workflowId, timestamp, ...parsed }
}

/** Publishes settings through the same structural authority as attempt start and deletion. */
export function createWorkflowRunWriter(reader: AsyncEventStateReadSurface, commit: SessionManager["commitWorkflow"]): WorkflowRunWriter {
  const runs = createWorkflowRunReader(reader)
  return {
    async update(workflowId, edit, labelSource = "configuration") {
      const expectedSeq = await reader.aggregateSeq(`workflow:${workflowId}`) + 1
      const current = await runs.read(workflowId)
      if (!current || (labelSource === "generated" && current.userNamed)) return false
      const next = edit(current)
      if (!next) return false
      const { launchedFrom: _binding, ...settings } = next
      const result = await commit({ workflowId, events: [{
        ...workflowRunAppend(workflowId, {
          type: "workflow.run.settings.updated", version: 1, actor: "flywheel",
          payload: { settings: { ...settings, ...(labelSource === "user" ? { userNamed: true } : {}), lastUpdated: new Date().toISOString() }, labelSource },
        }),
        expectedSeq,
      }] })
      return result.kind === "stored"
    },
  }
}

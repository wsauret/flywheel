import type { StoredFact } from "../../infra/event-store-types.js"
import type { WorkflowView } from "../view/types.js"
import type { CommittedWorkflowControl } from "./committed-control.js"
import { workflowInsertionRefusalReason } from "./fact-fold.js"
import type { Attempt } from "./graph-types.js"
import { lifecycleError } from "./host-failures.js"
import { itemScopeOf } from "./list-transitions.js"
import type { WorkflowRuntimeEvent } from "./host-types.js"
import { parseWorkflowSessionFact } from "./session-facts.js"

/** The facts of a batch that end or pause the run. A batch also carries
 *  view and context companions, whose bodies this publisher never reads. */
const RUN_OUTCOME_TYPES: ReadonlySet<string> = new Set(["workflow.paused", "workflow.aborted", "workflow.completed", "workflow.failed"])

interface RuntimePublisherDeps {
  readonly emit: (event: WorkflowRuntimeEvent) => void | Promise<void>
  readonly queue: () => Promise<WorkflowView>
  readonly setPauseReason: (reason: string) => void
}

export interface WorkflowRuntimePublisher {
  emitInitialized(): Promise<void>
  /** Publishes one committed batch, whose commit left `committed`. */
  publishCommittedBatch(stored: readonly StoredFact[], committed: CommittedWorkflowControl): Promise<void>
}

export function createWorkflowRuntimePublisher(deps: RuntimePublisherDeps): WorkflowRuntimePublisher {
  let initializedEmitted = false

  async function emit(event: WorkflowRuntimeEvent): Promise<void> {
    try {
      await deps.emit(event)
    } catch (error) {
      throw lifecycleError("runtime_event", error instanceof Error ? error.message : String(error))
    }
  }

  async function emitInitialized(): Promise<void> {
    if (initializedEmitted) return
    const projected = await deps.queue()
    await emit({
      type: "workflow.run.initialized",
      data: { attemptIds: projected.attempts.map(({ id }) => id) },
    })
    initializedEmitted = true
  }

  async function publishCommittedBatch(stored: readonly StoredFact[], committed: CommittedWorkflowControl): Promise<void> {
    const projected = await deps.queue()
    const terminal = stored.at(-1)
    const terminalFact = terminal ? sessionFact(terminal) : null
    if (terminalFact?.type === "workflow.control.committed") {
      const event = terminalFact.payload.event
      if (event.type === "ATTEMPT_STARTED") {
        const row = requireAttempt(projected, event.attemptId)
        await emit({
          type: "workflow.attempt.started",
          data: {
            attemptId: row.id,
            agentName: row.name,
          },
        })
      } else if (event.type === "ATTEMPT_SUCCEEDED") {
        const row = requireAttempt(projected, event.outcome.attemptId)
        await emit({ type: "workflow.attempt.completed", data: { attemptId: row.id, agentName: row.name } })
      } else if (event.type === "ATTEMPT_FAILED") {
        const row = requireAttempt(projected, event.failure.attemptId)
        await emit({
          type: "workflow.attempt.failed",
          data: { attemptId: row.id, agentName: row.name, reason: event.failure.reason },
        })
        if (projected.status === "paused") {
          deps.setPauseReason(event.failure.reason)
          await emit({
            type: "workflow.run.paused",
            data: { reason: event.failure.reason, attemptsCompleted: completedAttempts(projected) },
          })
        }
      }
    }

    for (const storedEvent of stored) {
      if (!RUN_OUTCOME_TYPES.has(storedEvent.type)) continue
      const fact = sessionFact(storedEvent)
      if (fact.type === "workflow.paused" || fact.type === "workflow.aborted") {
        deps.setPauseReason(fact.payload.reason)
        await emit({
          type: "workflow.run.paused",
          data: { reason: fact.payload.reason, attemptsCompleted: completedAttempts(projected) },
        })
      } else if (fact.type === "workflow.completed") {
        await emit({ type: "workflow.run.completed", data: { attemptsCompleted: completedAttempts(projected) } })
      } else if (fact.type === "workflow.failed") {
        // The failed fact carries no reason. The batch that records it
        // records a refusal that ended the run, and the committed control
        // holds each agent that failed, even when the commit that ends the
        // run settles other work after it.
        const reason = workflowInsertionRefusalReason(stored)
          ?? failedAgentsReason(committed)
          ?? (terminalFact?.type === "workflow.control.committed" && terminalFact.payload.event.type === "ATTEMPT_FAILED" ? terminalFact.payload.event.failure.reason : "Workflow failed")
        await emit({ type: "workflow.run.failed", data: { reason, attemptsCompleted: completedAttempts(projected) } })
      }
    }
  }

  return {
    emitInitialized,
    publishCommittedBatch,
  }
}

/** Each agent that failed, with its reason, or null when none failed. An
 *  agent of an item also names its item key. */
function failedAgentsReason(control: CommittedWorkflowControl): string | null {
  const names = new Map(control.graph.nodes.map((node) => [node.id, "name" in node ? node.name : node.id]))
  const name = (attempt: Attempt): string => {
    const agent = names.get(attempt.logicalNodeId) ?? attempt.definitionId
    const item = itemScopeOf(control, attempt)
    return item === null ? agent : `${agent}, item ${item.key}`
  }
  const failed = control.attempts.flatMap((attempt) => attempt.state._tag === "failed"
    ? [`Agent "${name(attempt)}" failed: ${attempt.state.reason}`]
    : [])
  return failed.length === 0 ? null : failed.join("; ")
}

function sessionFact(event: StoredFact): ReturnType<typeof parseWorkflowSessionFact> {
  return parseWorkflowSessionFact({
    type: event.type,
    version: event.version,
    actor: event.actor,
    payload: event.payload,
  })
}

function requireAttempt(view: WorkflowView, attemptId: string): WorkflowView["attempts"][number] {
  const row = view.attempts.find(({ id }) => id === attemptId)
  if (row) return row
  throw lifecycleError("projection", `Workflow view has no attempt "${attemptId}"`)
}

function completedAttempts(view: WorkflowView): number {
  return view.attempts.filter(({ status }) => status === "completed").length
}

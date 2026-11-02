import type { AsyncEventStateReadSurface } from "../../src/infra/event-store-types"
import type { WorkflowInjectionQueue } from "../../src/orchestration/workflow-host/injection-queue"
import { createWorkflowAgentInputs, type WorkflowAgentInputs } from "../../src/orchestration/workflow-host/agent-inputs"

/** The workflow's one consumer of accepted messages, as the workflow runner
 *  composes it, and the input queue of each step that opened its input, by
 *  attempt id. */
export function workflowAgentInputs(store: AsyncEventStateReadSurface, sessionId: string): { readonly agentInputs: WorkflowAgentInputs; readonly queues: ReadonlyMap<string, WorkflowInjectionQueue> } {
  const inputs = createWorkflowAgentInputs({ store, sessionId })
  const queues = new Map<string, WorkflowInjectionQueue>()
  const agentInputs: WorkflowAgentInputs = Object.create(inputs, {
    open: {
      value: (attempt: Parameters<WorkflowAgentInputs["open"]>[0]) => {
        const input = inputs.open(attempt)
        queues.set(attempt.attemptId, input.queue)
        return input
      },
    },
  })
  return { agentInputs, queues }
}

import type { AsyncEventStateReadSurface, StoredFact } from "../../infra/event-store-types.js"
import type { AccumulatedContext, AccumulatorState, ContextRecipient } from "./context.js"
import { accumulatorStateFromProjection, contextFromProjection, createWorkflowContextProjection } from "./context-projection.js"

export interface WorkflowContextStore {
  getContext(recipient?: ContextRecipient): Promise<AccumulatedContext>
  loadState(): Promise<AccumulatorState | null>
  applyStoredFact(events: StoredFact | readonly StoredFact[]): Promise<void>
  dispose(): void
}

interface WorkflowContextStoreDeps {
  sessionId: string
  reader: AsyncEventStateReadSurface
}

export function createWorkflowContextStore(deps: WorkflowContextStoreDeps): WorkflowContextStore {
  const projection = createWorkflowContextProjection(deps.reader, deps.sessionId)
  let disposed = false

  async function getContext(recipient?: ContextRecipient): Promise<AccumulatedContext> {
    return contextFromProjection(await projection.replay(), recipient)
  }

  async function loadState(): Promise<AccumulatorState | null> {
    return accumulatorStateFromProjection(await projection.replay())
  }

  async function applyStoredFact(events: StoredFact | readonly StoredFact[]): Promise<void> {
    if (!disposed) await projection.apply(events)
  }

  function dispose(): void {
    disposed = true
  }

  return { getContext, loadState, applyStoredFact, dispose }
}
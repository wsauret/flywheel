import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rmSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createWorkflowContextStore } from "../../../../src/workflows/context-bundle/context-store"
import { buildContextAccumulatedFact, buildContextInputSeededFact, type WorkflowContextFact } from "../../../../src/workflows/context-bundle/context-facts"
import type { AccumulatorState } from "../../../../src/workflows/context-bundle/context"
import { makeQueueStores } from "./_persistence-fixtures.js"
import { initializedWorkflowRoot } from "../../../helpers/workflow-root-fixtures.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workflow-context-store-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function appendWorkflowFacts(
  store: ReturnType<typeof createSqliteEventStore>,
  sessionId: string,
  facts: readonly WorkflowContextFact[],
): void {
  store.append({
    aggregateId: `workflow:${sessionId}`,
    type: "workflow.control.initialized",
    version: initializedWorkflowRoot.version,
    timestamp: 1,
    actor: "flywheel",
    sessionId,
    payload: initializedWorkflowRoot.payload,
  })
  for (const [index, fact] of facts.entries()) {
    store.append({
      aggregateId: `workflow:${sessionId}`,
      ...fact,
      timestamp: index + 2,
      sessionId,
    })
  }
}

describe("createWorkflowContextStore", () => {
  test("loads accumulated handoffs and declared artifacts from the workflow aggregate", async () => {
    const sessionId = "session-context"
    const stores = makeQueueStores(root, sessionId)
    const projectionReader = asAsyncEventReadSurface(stores.store)
    const incremental = createWorkflowContextStore({ sessionId, reader: projectionReader })
    const state: AccumulatorState = {
      entries: [{
        entryId: "step-1",
        agentName: "Plan",
        definitionId: "spec-create",
        workflowDefinitionId: "wf",
        recipientAttemptId: null,
        writes: [{ id: "plan", lifetime: "transient" }],
        handoff: { summary: "do it" },
        timestamp: 123,
      }],
      artifacts: {
        plan: {
          id: "plan",
          origin: "workflow_agent",
          writerEntryId: "step-1",
          writerAgentName: "Plan",
          writerDefinitionId: "spec-create",
          workflowDefinitionId: "wf",
          contract: { id: "plan", lifetime: "transient" },
          value: { summary: "do it" },
          timestamp: 123,
        },
        "user-request": {
          id: "user-request",
          origin: "workflow_input",
          workflowDefinitionId: "wf",
          value: "exact request",
          timestamp: 2,
        },
      },
      addenda: [],
    }

    const accumulated = state.entries[0]
    if (!accumulated) throw new Error("Context fixture requires one entry")
    appendWorkflowFacts(stores.store, sessionId, [
      buildContextInputSeededFact("wf", "exact request"),
      buildContextAccumulatedFact(accumulated),
    ])
    await incremental.applyStoredFact(stores.store.read({ aggregateId: `workflow:${sessionId}` }))
    const cold = createWorkflowContextStore({ sessionId, reader: projectionReader })
    expect(await incremental.loadState()).toEqual(state)
    expect(await cold.loadState()).toEqual(await incremental.loadState())
    expect(await cold.getContext()).toMatchObject({ request: { original: "exact request" } })
    cold.dispose()
    incremental.dispose()
    stores.writer.dispose()
    stores.store.close()

    const eventStore = createSqliteEventStore(resolveEventStoreDbFile(root))
    const types = eventStore.read({ aggregateId: `workflow:${sessionId}` }).map((event) => event.type)
    eventStore.close()
    expect(types).toEqual(["workflow.control.initialized", "context.input.seeded", "context.accumulated"])
  })

})
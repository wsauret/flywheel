import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asAsyncEventReadSurface, type LocalSqliteEventStore, asAsyncEventWriter } from "../../../../src/infra/event-store-types"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work/background-work"
import { buildSubagentCompleted } from "../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers"
import { workflowAdoption } from "../../../../src/orchestration/modules/workflows/run-facts"
import { reconcileChildSessionCompletions } from "../../../../src/orchestration/session/control/children/child-session-reconciliation"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-background-notifications"
import { registerLiveSessionControl } from "../../../../src/orchestration/session/control/live-session-control"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { createSessionFactWriter } from "../../../../src/orchestration/session/persistence/session-fact-writer"
import { loadToolExecutionTimelineFromEvents } from "../../../../src/orchestration/session/runtime-facts/tool-execution-projection"
import { countStateRequests, factsRead } from "../../../helpers/state-requests"
import { addSubagentChild, addWorkflowChild, reconcileChatLaunchedWorkflowCompletions, recordWorkflowCall, replaceWorkflowState, setupWorkflowParent } from "./_child-session-reconciliation-fixtures"

let tmpDir: string
let stores: LocalSqliteEventStore[]

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "child-completion-membership-"))
  stores = []
})

afterEach(() => {
  for (const store of stores) store.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

async function setup(status: "completed" | "paused" = "completed", suffix = "") {
  const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
  stores.push(store)
  return setupWorkflowParent(store, tmpDir, status, suffix, {})
}

function toolsOf(store: LocalSqliteEventStore, sessionId: string) {
  return loadToolExecutionTimelineFromEvents(store.read({ aggregateId: `session:${sessionId}` }))
}

/** A parent's completion sweep reads only its own members, so these guard
 *  that no completion is missed: one that arrives between two sends, a
 *  workflow that joins or moves between them, a hold that an earlier offer
 *  could not place, and a sibling parent's child, which must stay apart. */
describe("child completion membership", () => {
  test("a workflow launched from the parent and completed before the parent's next sweep delivers its result", async () => {
    const { store, writer, parentSessionId } = await setup("completed")
    expect((await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer })).reconciledCount).toBe(1)
    await addWorkflowChild(store, tmpDir, parentSessionId, "child-2", "workflow-tool-2", "Implement the second reviewed change")

    expect(await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer })).toMatchObject({
      reconciledCount: 1,
      durableTerminalChildSessionIds: ["child", "child-2"],
    })
    expect(toolsOf(store, parentSessionId).find((tool) => tool.toolUseId === "workflow-tool-2")?.resultOutcome).toBe("ok")
  })

  test("a workflow adopted by the parent between two sends delivers its result to the new parent only", async () => {
    const { store, writer, parentSessionId: formerParent, toolUseId, description } = await setup("paused", "-former")
    const manager = createSessionManager({ projectRoot: tmpDir, executionCwd: tmpDir, store })
    const adopter = await manager.createChat({ id: "adopter", conversationId: "adopter-conversation", name: "Adopter" })
    await recordWorkflowCall(store, adopter, "adopt-tool", { workflow_definition_id: "workflow", summary: "Reviewed change", description })
    const reconcile = (parentSessionId: string) => reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer })
    expect(await reconcile(formerParent)).toMatchObject({ reconciledCount: 0, linkedNonterminalWorkflowToolUseIds: [toolUseId] })
    expect((await reconcile(adopter)).reconciledCount).toBe(0)

    store.append({
      aggregateId: "workflow:child-former", sessionId: "child-former", timestamp: Date.now(),
      ...workflowAdoption({ parentSessionId: adopter, conversationId: "adopter-conversation", workflowDefinitionId: "workflow", toolUseId: "adopt-tool", description }, new Date().toISOString()),
    })
    await replaceWorkflowState(store, "child-former", description, "completed")

    expect(await reconcile(formerParent)).toEqual({ reconciledCount: 0, workflowAggregateReads: 0, durableTerminalChildSessionIds: [] })
    expect(await reconcile(adopter)).toMatchObject({ reconciledCount: 1, durableTerminalChildSessionIds: ["child-former"] })
    expect(toolsOf(store, formerParent).find((tool) => tool.toolUseId === toolUseId)?.status).toBe("called")
    expect(toolsOf(store, adopter).find((tool) => tool.toolUseId === "adopt-tool")?.resultOutcome).toBe("ok")
  })

  test("a sibling parent's child completion never reaches this parent, and this parent's own completion arrives at its next send", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    stores.push(store)
    const writer = asAsyncEventWriter(store)
    const manager = createSessionManager({ projectRoot: tmpDir, executionCwd: tmpDir, store })
    for (const [index, id] of ["parent", "sibling"].entries()) {
      await manager.createChat({ id, conversationId: `${id}-conversation`, name: id })
      await addSubagentChild(store, writer, tmpDir, id, `${id}-conversation`, index, "created")
    }
    const reconcile = (parentSessionId: string) => reconcileChildSessionCompletions({ parentSessionId, reader: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer })
    const complete = async (index: number) => {
      const childWriter = createSessionFactWriter({ sessionId: `child-${index}`, writer })
      await childWriter.record(buildSubagentCompleted({ childRunId: `run-${index}`, status: "completed", isError: false, content: "Reviewed.", durationMs: 1 }))
      childWriter.dispose()
    }
    expect((await reconcile("parent")).reconciledCount).toBe(0)
    expect((await reconcile("sibling")).reconciledCount).toBe(0)

    await complete(1)
    expect((await reconcile("parent")).reconciledCount).toBe(0)
    expect(toolsOf(store, "parent").map((tool) => tool.status)).toEqual(["called"])
    expect(store.readInFlight("parent", QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([])
    expect((await reconcile("sibling")).reconciledCount).toBe(1)

    await complete(0)
    expect((await reconcile("parent")).reconciledCount).toBe(1)
    expect(toolsOf(store, "parent").map((tool) => tool.resultOutcome)).toEqual(["ok"])
    expect(store.readInFlight("parent", QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toHaveLength(1)
  })

  test("a hold refused while the registry was handing_off is re-offered at the next no-change sweep and then delivered", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    stores.push(store)
    const writer = asAsyncEventWriter(store)
    const manager = createSessionManager({ projectRoot: tmpDir, executionCwd: tmpDir, store })
    const parentSessionId = await manager.createChat({ id: "parent", conversationId: "parent-conversation", name: "Parent" })
    await addSubagentChild(store, writer, tmpDir, parentSessionId, "parent-conversation", 0, "completed")
    const counter = countStateRequests(asAsyncEventReadSurface(store))
    let state: "handing_off" | "running" = "handing_off"
    let delivered = 0
    const registry = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: async () => { delivered += 1; await new Promise<void>(() => {}) } })
    const unregister = registerLiveSessionControl(counter.reader, {
      sessionId: parentSessionId, state: async () => state, deliver: async () => ({ status: "delivered", startsTurn: false }),
      backgroundTasks: registry, notify: async () => false,
    })
    const input = { parentSessionId, reader: counter.reader, projectionReader: counter.reader, writer }
    try {
      // The first sweep holds the completion and offers it, which the hand-off
      // refuses; the second reads the result it wrote and offers it again.
      expect((await reconcileChildSessionCompletions(input)).reconciledCount).toBe(1)
      expect((await reconcileChildSessionCompletions(input)).reconciledCount).toBe(0)
      expect(delivered).toBe(0)
      expect(store.readInFlight(parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toHaveLength(1)

      state = "running"
      counter.take()
      expect((await reconcileChildSessionCompletions(input)).reconciledCount).toBe(0)
      const requests = counter.take()
      expect(delivered).toBe(1)
      // Nothing changed, so the sweep read no fact. It read the held
      // notifications once before its passes and once after its offer.
      expect(factsRead(requests)).toBe(0)
      expect(requests.filter(({ method }) => method === "readInFlight")).toHaveLength(2)
    } finally { unregister() }
  })
})

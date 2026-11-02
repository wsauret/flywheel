import { afterEach, expect, test } from "bun:test"
import { asAsyncEventReadSurface, type AsyncEventStateReadSurface, type LocalSqliteEventStore } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { routeChildResultNotices } from "../../../../src/orchestration/session/child-reconciliation-fault"
import { reconcileChildSessionCompletions } from "../../../../src/orchestration/session/child-session-reconciliation"
import { temporaryDirectories } from "../../../helpers/directories"
import { reconcileChatLaunchedWorkflowCompletions, setupWorkflowParent } from "./_child-session-reconciliation-fixtures"
import { createConversationTreeProjection } from "../../../../src/orchestration/session/conversation/conversation-projection"

const temporaryDirectory = temporaryDirectories()
const stores: LocalSqliteEventStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

test("a parent that a settling reader cannot read before the sweep shows the fault on the parent", async () => {
  const projectRoot = temporaryDirectory("child-reconciliation-fault-")
  const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
  stores.push(store)
  const { writer, parentSessionId } = await setupWorkflowParent(store, projectRoot, "completed", "", {})
  const local = asAsyncEventReadSurface(store)
  const settled: string[][] = []
  // The state Worker's reader settles before a sweep takes its lane; this one
  // cannot read the parent whose children the settle step names.
  const reader: AsyncEventStateReadSurface = {
    ...local,
    settleBefore: async (sessionIds) => { settled.push([...sessionIds]) },
    readPage: async (query, ...rest) => {
      if (query.aggregateId === `session:${parentSessionId}`) throw new Error("injected parent read failure")
      return local.readPage(query, ...rest)
    },
  }
  const notices: unknown[] = []
  const unroute = routeChildResultNotices(reader, (sessionId, operation) => { notices.push({ sessionId, ...operation }) })
  try {
    await expect(reconcileChildSessionCompletions({ parentSessionId, reader, writer })).rejects.toThrow("injected parent read failure")
    expect(settled).toEqual([])
    expect(notices).toEqual([{ sessionId: parentSessionId, type: "upsert", notice: expect.objectContaining({ message: expect.stringContaining("Cause: injected parent read failure.") }) }])
  } finally { unroute() }
})

test("a contended completion retries without another input and commits its original keyed result once", async () => {
  const projectRoot = temporaryDirectory("child-reconciliation-retry-")
  const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
  stores.push(store)
  const { writer, parentSessionId, conversationId } = await setupWorkflowParent(store, projectRoot, "completed", "", {})
  const reader = asAsyncEventReadSurface(store)
  const recovered = Promise.withResolvers<void>()
  const notices: string[] = []
  const unroute = routeChildResultNotices(reader, (_sessionId, operation) => {
    notices.push(operation.type)
    if (operation.type === "resolve") recovered.resolve()
  }, 1)
  let attempts = 0
  try {
    await expect(reconcileChatLaunchedWorkflowCompletions({
      parentSessionId, reader: store,
      writer: { ...writer, appendBatchGuarded: async (events) => {
        attempts++
        if (attempts <= 4) return { kind: "conflict", conflict: { aggregateId: `session:${parentSessionId}`, expectedSeq: 1, actualSeq: 2 } }
        return writer.appendBatchGuarded(events)
      } },
    })).rejects.toThrow("stayed contended")
    await recovered.promise
    expect(attempts).toBe(5)
    expect(notices).toEqual(["upsert", "resolve"])
    expect((await createConversationTreeProjection(reader, conversationId).replay()).entriesById["workflow-completion:child"]).toBeDefined()
    expect(store.read({ aggregateId: `session:${parentSessionId}`, types: ["tool.result.recorded"] })).toHaveLength(1)
  } finally { unroute() }
})

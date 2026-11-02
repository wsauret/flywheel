import { afterEach, describe, expect, test } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter, type LocalSqliteEventStore } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { readChildCompletionConversation } from "../../../../src/orchestration/session/child-completion-conversation"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { temporaryDirectories } from "../../../helpers/directories"

const temporaryDirectory = temporaryDirectories()
const stores: LocalSqliteEventStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

async function parentConversation() {
  const projectRoot = temporaryDirectory("child-completion-conversation-")
  const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
  stores.push(store)
  const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
  const sessionId = await manager.createChat({ id: "parent", conversationId: "parent-conversation", name: "Parent", initialState: "inactive" })
  const input = { reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) }
  return { store, sessionId, conversationId: "parent-conversation", input }
}

describe("child completion conversation", () => {
  test("opens a readable parent conversation for publication", async () => {
    const { sessionId, conversationId, input } = await parentConversation()
    const tree = await readChildCompletionConversation({ input }, sessionId, conversationId)
    expect(tree).not.toBeNull()
    tree?.getStorage().dispose()
  })

  test("refuses a parent conversation that holds a fact this build cannot decode", async () => {
    const { store, sessionId, conversationId, input } = await parentConversation()
    // An entry batch in a shape no registered schema or salvage rule reads.
    store.append({ aggregateId: `conversation:${conversationId}`, sessionId, timestamp: Date.now(), type: "chat.entries.appended", version: 1, actor: "flywheel", payload: { conversationId, entries: [{ unexpected: true }] } })

    await expect(readChildCompletionConversation({ input }, sessionId, conversationId)).rejects.toThrow("cannot decode")
  })
})

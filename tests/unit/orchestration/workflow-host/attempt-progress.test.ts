import { afterEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { createSqliteEventInserter } from "../../../../src/infra/sqlite-event-store-core.js"
import { createSqliteEventReadSurface } from "../../../../src/infra/sqlite-event-read-surface.js"
import { asAsyncEventReadSurface, type EventStoreAppend } from "../../../../src/infra/event-store-types.js"
import { buildSessionCreatedFact } from "../../../../src/orchestration/session/session-metadata-facts.js"
import { buildSessionMetadataAppend } from "../../../../src/orchestration/session/session-metadata-store.js"
import { emptyConversationCheckpoint } from "../../../../src/orchestration/session/conversation-checkpoint.js"
import { conversationsWithServedResponse, memberConversationCheckpoint } from "../../../../src/orchestration/workflow-host/attempt-progress.js"

const databases: Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

const timestamp = "2026-01-01T00:00:00.000Z"

function store() {
  const db = new Database(":memory:")
  databases.push(db)
  const inserter = createSqliteEventInserter(db)
  const surface = createSqliteEventReadSurface(db)
  const append = (fact: Omit<EventStoreAppend, "timestamp" | "payloadJson">): number =>
    inserter.insertEventRows([{ ...fact, id: crypto.randomUUID(), timestamp: 1 }])[0]!.position
  /** One recorded assistant message of `conversationId`, complete or cut off. */
  const assistant = (conversationId: string, incomplete: boolean): number => append({
    aggregateId: `conversation:${conversationId}`, sessionId: "member", type: "chat.entries.appended", version: 3, actor: "flywheel",
    payload: {
      conversationId,
      entries: [{
        kind: "message", id: crypto.randomUUID(), parentId: null, timestamp,
        message: { kind: "assistant", content: [{ type: "text", text: "partial" }], ...(incomplete ? { incomplete: true } : {}) },
      }],
    },
  })
  const queries: unknown[] = []
  const reader = asAsyncEventReadSurface(surface)
  const counted = { ...reader, readSlice: async (...args: Parameters<typeof reader.readSlice>) => { queries.push(args[0]); return reader.readSlice(...args) } }
  return { append, assistant, reader: counted, queries }
}

describe("attempt progress", () => {
  it("finds the conversations that recorded a complete response after their position, in one read", async () => {
    const { assistant, reader, queries } = store()
    const before = assistant("served", false)
    const cut = assistant("cut-off", false)
    assistant("cut-off", true)
    assistant("served", false)
    assistant("stale", false)

    const served = await conversationsWithServedResponse(reader, new Map([["served", before], ["cut-off", cut], ["stale", Number.MAX_SAFE_INTEGER]]))

    expect([...served]).toEqual(["served"])
    expect(queries).toHaveLength(1)
    expect(await conversationsWithServedResponse(reader, new Map())).toEqual(new Set())
  })

  it("renders the latest checkpoint of a workflow agent conversation from the member session that ran it", async () => {
    const { append, reader } = store()
    append({ ...buildSessionMetadataAppend("member-1", buildSessionCreatedFact({
      kind: "workflow-agent", command: "workflow-agent", conversationId: "earlier", label: "Work",
      lifecycleState: "inactive", lastUpdated: timestamp,
      launchedFrom: { parentSessionId: "chat", toolUseId: "launch" },
      workflowMembership: { kind: "attempt", workflowId: "workflow", attemptId: "node:attempt:1" },
    }), 1) })
    expect(await memberConversationCheckpoint(reader, "workflow", "earlier")).toBeNull()

    const checkpoint = { ...emptyConversationCheckpoint(), nextStep: "Finish the migration." }
    append({ aggregateId: "session:member-1", sessionId: "member-1", type: "conversation.checkpoint.updated", version: 1, actor: "flywheel", payload: { conversationId: "earlier", checkpoint } })

    expect(await memberConversationCheckpoint(reader, "workflow", "earlier")).toContain("# Next step\n\nFinish the migration.")
    expect(await memberConversationCheckpoint(reader, "workflow", "unknown")).toBeNull()
  })
})

import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionRelation } from "../../../../src/infra/chat-input-schema"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStore } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import type { ConversationMessage } from "../../../../src/orchestration/agent-runtime/llm/types"
import { createConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { readParentMessages } from "../../../../src/orchestration/workflow-host/request-addenda"
import { conversationHoldsEntries, readConversationToolUseIds } from "../../../../src/orchestration/session/conversation/session-message-entries"
import { countStateRequests, factsRead } from "../../../helpers/state-requests"

const sessionId = "workflow-session"
const conversationId = "step-conversation"
let baseDir: string
let store: EventStore

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "flywheel-request-addenda-"))
  store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
})
afterEach(() => {
  store.close()
  rmSync(baseDir, { recursive: true, force: true })
})

function sessionMessage(content: ConversationMessage["content"], relation: SessionRelation, options: { readonly personWords?: string; readonly origin?: "system" } = {}): ConversationMessage {
  return {
    kind: "user",
    content: typeof content === "string" ? content : [...content],
    ...(options.origin ? { origin: options.origin } : {}),
    producer: {
      kind: "session", sessionId: `${relation}-session`, conversationId: `${relation}-conversation`, toolUseId: "call", hop: 0,
      envelope: { name: `The ${relation}`, relation, waits: false, ...(options.personWords ? { personWords: options.personWords } : {}) },
    },
  }
}

test("keeps only the messages that the step read from its parent session", async () => {
  const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
  try {
    await tree.appendMessage({ kind: "user", content: "Start the step.", origin: "human", producer: { kind: "human" } }, "person-1")
    await tree.appendMessage(sessionMessage("Also cover Windows.", "parent"), "msg:parent-session:call-1")
    await tree.appendMessage({ kind: "assistant", content: "Working." }, "assistant-1")
    await tree.appendMessage(sessionMessage("I changed the shared file.", "sibling"), "msg:sibling-session:call")
    await tree.appendMessage(sessionMessage("Unrelated news.", "other"), "msg:other-session:call")
    await tree.appendMessage(sessionMessage("Runtime notice.", "parent", { origin: "system" }), "notice-1")
    await tree.appendMessage(sessionMessage([
      { type: "text", text: "Use the attached plan." },
      { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" },
    ], "parent", { personWords: "follow the plan" }), "msg:parent-session:call-2")
  } finally {
    tree.getStorage().dispose()
  }
  // A build before session messages wrote a parent's message with a
  // `parent-agent` producer. It decodes with no envelope, so it never
  // qualifies.
  await asAsyncEventWriter(store).append({
    aggregateId: `conversation:${conversationId}`, sessionId, timestamp: 1000, actor: "flywheel",
    type: "chat.entries.appended", version: 3,
    payload: {
      conversationId,
      entries: [{
        kind: "message", id: "historical-parent", parentId: "msg:parent-session:call-2", timestamp: new Date(1000).toISOString(),
        message: { kind: "user", content: "Old steer.", producer: { kind: "parent-agent", parentSessionId: "parent-session", parentConversationId: "parent-conversation", authorizingToolCallId: "old-call" } },
      }],
    },
  })

  // A batch that no reviewed decode can read is skipped, and the batches
  // around it still yield their parent messages.
  await asAsyncEventWriter(store).append({
    aggregateId: `conversation:${conversationId}`, sessionId, timestamp: 1001, actor: "flywheel",
    type: "chat.entries.appended", version: 5,
    payload: { conversationId, entries: [{ kind: "message", id: "damaged" }] },
  })

  expect(await readParentMessages(asAsyncEventReadSurface(store), conversationId)).toEqual([
    { key: "msg:parent-session:call-1", source: { kind: "parent", name: "The parent" }, text: "Also cover Windows." },
    { key: "msg:parent-session:call-2", source: { kind: "parent", name: "The parent" }, text: "Use the attached plan.", personWords: "follow the plan", attachmentCount: 1 },
  ])
})

test("message, entry, and tool-call lookups share an advancing conversation index", async () => {
  const reader = asAsyncEventReadSurface(store)
  const counter = countStateRequests(reader)
  const tree = await createConversationTree({ conversationId, sessionId, store: reader, writer: asAsyncEventWriter(store) })
  try {
    for (const history of [3, 30]) {
      for (let index = 0; index < history; index += 1) {
        await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: `call-${history}-${index}`, name: "read", input: {} }] }, `assistant-${history}-${index}`)
      }
      await readParentMessages(counter.reader, conversationId)
      counter.take()
      const key = `msg:parent-session:${history}`
      await tree.appendMessage(sessionMessage(`Direction ${history}`, "parent"), key)
      expect((await readParentMessages(counter.reader, conversationId)).at(-1)?.key).toBe(key)
      expect(await conversationHoldsEntries(counter.reader, conversationId, [key, "absent"])).toEqual(new Set([key]))
      expect((await readConversationToolUseIds(counter.reader, conversationId)).toolUseIds.has(`call-${history}-0`)).toBe(true)
      expect(factsRead(counter.take())).toBe(1)
    }
  } finally {
    tree.getStorage().dispose()
  }
})

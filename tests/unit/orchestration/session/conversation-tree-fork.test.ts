import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStore } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import type { ConversationEntry, MessageEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types"
import { forkConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-fork"
import { ConversationTreeStorage } from "../../../../src/orchestration/session/conversation/conversation-tree-storage"

const SOURCE_ID = "source-conversation"
const DESTINATION_ID = "destination-conversation"
const SOURCE_SESSION_ID = "source-session"
const DESTINATION_SESSION_ID = "destination-session"
const LARGE_TOOL_CONTENT = "owned fork content quixotic\n".repeat(300)

let baseDir: string
let store: EventStore
let timestamp = 0

function now(): string {
  timestamp += 1
  return new Date(Date.UTC(2026, 8, 11, 0, 0, timestamp)).toISOString()
}

function message(id: string, parentId: string | null, value: MessageEntry["message"]): ConversationEntry {
  return { kind: "message", id, parentId, timestamp: now(), message: value }
}

async function createSource(): Promise<ConversationTreeStorage> {
  return ConversationTreeStorage.create({ conversationId: SOURCE_ID, sessionId: SOURCE_SESSION_ID, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), now })
}

function destination(): Promise<ConversationTreeStorage | null> {
  return ConversationTreeStorage.tryOpen({ conversationId: DESTINATION_ID, sessionId: DESTINATION_SESSION_ID, store: asAsyncEventReadSurface(store), now })
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-conversation-fork-"))
  store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
  timestamp = 0
})

afterEach(() => {
  store.close()
  fs.rmSync(baseDir, { recursive: true, force: true })
})

describe("forkConversationTree", () => {
  test("captures one committed active-branch snapshot and excludes abandoned and pending entries", async () => {
    const source = await createSource()
    await source.appendEntries([
      message("root", null, { kind: "user", content: "question" }),
      message("abandoned", "root", { kind: "assistant", content: "old answer" }),
    ])
    await source.setLeafId("root")
    const branchPoint = await source.getLeafId()
    if (branchPoint === null) throw new Error("expected branch point")
    await source.appendEntry(message("active", branchPoint, { kind: "assistant", content: "new answer" }))
    source.appendPending(message("pending", "active", { kind: "user", content: "not committed" }))

    let clock = 0
    let yielded = false
    const capture = await source.captureCommittedActiveBranch({
      now: () => {
        clock += 8
        return clock
      },
      yieldToNextTask: async () => {
        if (yielded) return
        yielded = true
        store.append({
          aggregateId: `conversation:${SOURCE_ID}`, sessionId: SOURCE_SESSION_ID,
          type: "chat.entries.appended", version: 999, actor: "flywheel", timestamp: Date.now(),
          payload: { unreadable: true },
        })
        await source.getState()
        await source.appendEntry(message("later", "active", { kind: "user", content: "after capture" }))
      },
    })

    expect(yielded).toBe(true)
    expect(capture.entries.map((entry) => entry.id)).toEqual(["root", "active"])
    expect(capture.entries.some((entry) => entry.id === "abandoned" || entry.id === "pending" || entry.id === "later")).toBe(false)
    expect(capture.rootEntryId).toBe("root")
    expect(capture.leafEntryId).toBe("active")
    expect(capture.foldedPosition).toBeGreaterThan(0)
    expect(capture.degraded).toBe(false)

    const result = await forkConversationTree({ source: capture, destinationConversationId: DESTINATION_ID, destinationSessionId: DESTINATION_SESSION_ID, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), now })
    expect(result).toEqual({ sourcePrefixPosition: capture.foldedPosition, entryCount: 2, rootEntryId: "root", leafEntryId: "active" })
    const copied = await destination()
    if (!copied) throw new Error("expected destination")
    expect((await copied.getPathToRoot(await copied.getLeafId())).map((entry) => entry.id)).toEqual(["root", "active"])
    copied?.dispose()
    source.dispose()
  })

  test("copies compaction and hydrated large tool content through destination storage", async () => {
    const source = await createSource()
    await source.appendEntries([
      message("root", null, { kind: "user", content: "question" }),
      message("tool-call", "root", { kind: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "read", input: {} }] }),
      message("tool-result", "tool-call", { kind: "toolResult", toolUseId: "tool-1", content: [{ type: "text", text: LARGE_TOOL_CONTENT }] }),
      message("answer", "tool-result", { kind: "assistant", content: "answer" }),
      { kind: "compaction", id: "compact", parentId: "answer", timestamp: now(), sourceLeafId: "answer", summary: "summary", retainedMessages: [{ kind: "user", content: "question" }], tokensBefore: 100, tokensAfter: 10 },
      message("after", "compact", { kind: "user", content: "continue" }),
    ])

    const capture = await source.captureCommittedActiveBranch()
    const toolResult = capture.entries.find((entry) => entry.id === "tool-result")
    if (toolResult?.kind !== "message" || toolResult.message.kind !== "toolResult") throw new Error("expected hydrated tool result")
    expect(toolResult.message.content[0]).toEqual({ type: "text", text: LARGE_TOOL_CONTENT })

    await forkConversationTree({ source: capture, destinationConversationId: DESTINATION_ID, destinationSessionId: DESTINATION_SESSION_ID, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), now })
    const copied = await destination()
    if (!copied) throw new Error("expected destination")
    const copiedResult = await copied.getEntry("tool-result")
    if (copiedResult?.kind !== "message" || copiedResult.message.kind !== "toolResult") throw new Error("expected copied tool result")
    expect(copiedResult.message.content[0]).toEqual({ type: "text", text: LARGE_TOOL_CONTENT })
    expect((await copied.getPathToRoot(await copied.getLeafId())).some((entry) => entry.kind === "compaction")).toBe(true)
    copied?.dispose()
    source.dispose()
  })

  test("rejects unresolved tool calls before creating the destination", async () => {
    const source = await createSource()
    await source.appendEntries([
      message("root", null, { kind: "user", content: "question" }),
      message("tool-call", "root", { kind: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "read", input: {} }] }),
    ])

    await expect(forkConversationTree({ source: await source.captureCommittedActiveBranch(), destinationConversationId: DESTINATION_ID, destinationSessionId: DESTINATION_SESSION_ID, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), now })).rejects.toThrow(/unresolved tool_use/)
    expect(await destination()).toBeNull()
    source.dispose()
  })

  test("rejects a branch-visible degraded record before creating the destination", async () => {
    const source = await createSource()
    await source.appendEntry(message("root", null, { kind: "user", content: "question" }))
    store.append({
      aggregateId: `conversation:${SOURCE_ID}`,
      sessionId: SOURCE_SESSION_ID,
      type: "chat.entries.appended",
      version: 1,
      actor: "flywheel",
      timestamp: Date.now(),
      payload: {
        conversationId: SOURCE_ID,
        entries: [
          { kind: "message", id: "broken", parentId: "root", timestamp: "invalid", message: { kind: "assistant", content: "broken" } },
          message("tail", "root", { kind: "assistant", content: "answer" }),
        ],
      },
    })

    const capture = await source.captureCommittedActiveBranch()
    expect(capture.degraded).toBe(true)
    await expect(forkConversationTree({ source: capture, destinationConversationId: DESTINATION_ID, destinationSessionId: DESTINATION_SESSION_ID, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), now })).rejects.toThrow(/degraded/)
    expect(await destination()).toBeNull()
    source.dispose()
  })
})

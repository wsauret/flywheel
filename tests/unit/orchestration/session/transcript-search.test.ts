import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { asAsyncEventReadSurface, type LocalSqliteEventStore } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { createTranscriptSearch, TRANSCRIPT_SEARCH_PAGE_SIZE, type TranscriptSearchService } from "../../../../src/orchestration/session/transcript-search.js"
import { acquireConversationSearchIndex, type ConversationSearchIndex } from "../../../../src/infra/conversation-fts.js"

let tmpDir: string
let store: LocalSqliteEventStore
let search: TranscriptSearchService
let index: ConversationSearchIndex

const row = (id: string, conversationId: string, name?: string) => ({
  id, conversationId,
  ...(name === undefined ? {} : { name }),
})
const sessions = [row("s-alpha", "conv-alpha", "Alpha work"), row("s-beta", "conv-beta")]

function append(conversationId: string, entries: ReadonlyArray<{ [key: string]: unknown }>): void {
  store.append({
    aggregateId: `conversation:${conversationId}`,
    type: "chat.entries.appended",
    version: 1,
    timestamp: Date.now(),
    actor: "flywheel",
    sessionId: conversationId,
    payload: { conversationId, entries },
  })
}
const user = (id: string, parentId: string | null, text: string) => ({ kind: "message", id, parentId, timestamp: new Date().toISOString(), message: { kind: "user", content: text } })
const assistant = (id: string, parentId: string, text: string) => ({ kind: "message", id, parentId, timestamp: new Date().toISOString(), message: { kind: "assistant", content: text } })
const toolResult = (id: string, parentId: string, toolUseId: string, text: string) => ({ kind: "message", id, parentId, timestamp: new Date().toISOString(), message: { kind: "toolResult", toolUseId, content: [{ type: "text", text }] } })

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-transcript-search-"))
  const dbFile = path.join(tmpDir, "flywheel.sqlite")
  store = createSqliteEventStore(dbFile)
  index = acquireConversationSearchIndex(path.join(tmpDir, "search.sqlite"), asAsyncEventReadSurface(store))
  search = createTranscriptSearch({ index, source: asAsyncEventReadSurface(store), sessions: async () => sessions })
})

afterEach(async () => {
  await index.dispose()
  store.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("transcript search for people", () => {
  test("later commits are excluded from the captured page and count", async () => {
    await index.dispose()
    append("conv-alpha", [user("a", null, "kafka captured")])
    const source = asAsyncEventReadSurface(store)
    index = acquireConversationSearchIndex(path.join(tmpDir, "search.sqlite"), source)
    search = createTranscriptSearch({
      index,
      source: {
        readPage: source.readPage,
        async capturePosition() {
          const upper = await source.capturePosition()
          append("conv-alpha", [user("b", "a", "kafka later")])
          return upper
        },
      },
      sessions: async () => sessions,
    })
    const result = await search.search({ query: "kafka", page: 1 })
    expect(result.total).toBe(1)
    expect(result.hits.map((hit) => hit.entryId)).toEqual(["a"])
  })

  test("finds words across every session, naming the session and who said it", async () => {
    append("conv-alpha", [user("a1", null, "deploy the kafka pipeline"), assistant("a2", "a1", "The kafka pipeline is deployed.")])
    append("conv-beta", [user("b1", null, "review the migration")])

    const result = await search.search({ query: "kafka", page: 1 })
    expect(result.total).toBe(2)
    expect(result.pageSize).toBe(TRANSCRIPT_SEARCH_PAGE_SIZE)
    expect(result.hits.map((hit) => [hit.sessionId, hit.role, hit.entryId])).toEqual(expect.arrayContaining([["s-alpha", "user", "a1"], ["s-alpha", "assistant", "a2"]]))
    expect(result.hits[0]?.sessionTitle).toBe("Alpha work")
    expect(result.hits.every((hit) => hit.snippet.includes("[kafka]"))).toBe(true)
  })

  test("scopes to one session, and answers nothing for a session it cannot map", async () => {
    append("conv-alpha", [user("a1", null, "kafka here")])
    append("conv-beta", [user("b1", null, "kafka there")])
    expect((await search.search({ query: "kafka", sessionId: "s-beta", page: 1 })).hits.map((hit) => hit.sessionId)).toEqual(["s-beta"])
    expect(await search.search({ query: "kafka", sessionId: "s-unknown", page: 1 })).toEqual({ hits: [], total: 0, page: 1, pageSize: TRANSCRIPT_SEARCH_PAGE_SIZE })
  })

  test("a tool result hit names the tool use its block is keyed by", async () => {
    append("conv-alpha", [user("a1", null, "run it"), toolResult("a3", "a1", "toolu_9", "kafka consumer lag is zero")])
    const [hit] = (await search.search({ query: "lag", page: 1 })).hits
    expect(hit).toMatchObject({ role: "tool", entryId: "toolu_9" })
  })

  test("a query word with a dot finds the words it names", async () => {
    append("conv-alpha", [user("a1", null, "boot Windows 3.11 from win311.img"), assistant("a2", "a1", "unrelated reply")])
    for (const query of ["3.11 QEMU", "win311.img"]) {
      expect((await search.search({ query, page: 1 })).hits.map((hit) => hit.entryId)).toEqual(["a1"])
    }
  })

  test("blank queries and conversations no session lists yield nothing", async () => {
    append("conv-orphan", [user("o1", null, "kafka orphan")])
    expect((await search.search({ query: "   ", page: 1 })).total).toBe(0)
    expect((await search.search({ query: "kafka", page: 1 })).hits).toEqual([])
  })

  test("pages through many hits with a true total", async () => {
    const entries = Array.from({ length: 25 }, (_, i) => user(`u${i}`, i === 0 ? null : `u${i - 1}`, `kafka note ${i}`))
    append("conv-alpha", entries)
    const first = await search.search({ query: "kafka", page: 1 })
    const second = await search.search({ query: "kafka", page: 2 })
    expect(first.total).toBe(25)
    expect(first.hits.length).toBe(TRANSCRIPT_SEARCH_PAGE_SIZE)
    expect(second.hits.length).toBe(5)
    expect(new Set([...first.hits, ...second.hits].map((hit) => hit.entryId)).size).toBe(25)
  })
})

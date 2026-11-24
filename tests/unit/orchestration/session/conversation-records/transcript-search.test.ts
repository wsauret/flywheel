import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { asAsyncEventReadSurface, type LocalSqliteEventStore } from "../../../../../src/infra/store/event-store-types.js"
import { createSqliteEventStore } from "../../../../../src/infra/store/sqlite-event-store.js"
import { createTranscriptSearch, type TranscriptSearchService } from "../../../../../src/orchestration/session/conversation-records/transcript-search.js"
import { acquireConversationSearchIndex, type ConversationSearchIndex } from "../../../../../src/infra/store/conversation-fts.js"

let tmpDir: string
let store: LocalSqliteEventStore
let search: TranscriptSearchService
let index: ConversationSearchIndex

const row = (id: string, conversationId: string, name?: string, kind: "chat" | "subagent" | "workflow-agent" = "chat") => ({
  id, conversationId, kind,
  ...(name === undefined ? {} : { name }),
})
let sessions = [row("s-alpha", "conv-alpha", "Alpha work"), row("s-beta", "conv-beta")]

function append(conversationId: string, entries: ReadonlyArray<{ [key: string]: unknown }>, timestamp = Date.now()): void {
  store.append({
    aggregateId: `conversation:${conversationId}`,
    type: "chat.entries.appended",
    version: 1,
    timestamp,
    actor: "flywheel",
    sessionId: conversationId,
    payload: { conversationId, entries },
  })
}

function checkpoint(sessionId: string, conversationId: string, currentState: string): void {
  store.append({
    aggregateId: `session:${sessionId}`,
    type: "conversation.checkpoint.updated",
    version: 1,
    timestamp: Date.now(),
    actor: "flywheel",
    sessionId,
    payload: { conversationId, checkpoint: { designIntent: { text: "", approved: false }, decisions: [], currentState, openQuestions: "", nextStep: "", relevantSkills: [], references: [], workingNotes: "" } },
  })
}
const user = (id: string, parentId: string | null, text: string) => ({ kind: "message", id, parentId, timestamp: new Date().toISOString(), message: { kind: "user", content: text } })
const assistant = (id: string, parentId: string, text: string) => ({ kind: "message", id, parentId, timestamp: new Date().toISOString(), message: { kind: "assistant", content: text } })
const toolCall = (id: string, parentId: string, text: string) => ({ kind: "message", id, parentId, timestamp: new Date().toISOString(), message: { kind: "assistant", content: [{ type: "text", text }, { type: "tool_use", id: `call-${id}`, name: "read", input: {} }] } })
const toolResult = (id: string, parentId: string, toolUseId: string, text: string) => ({ kind: "message", id, parentId, timestamp: new Date().toISOString(), message: { kind: "toolResult", toolUseId, content: [{ type: "text", text }] } })

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-transcript-search-"))
  const dbFile = path.join(tmpDir, "flywheel.sqlite")
  store = createSqliteEventStore(dbFile)
  index = acquireConversationSearchIndex(path.join(tmpDir, "search.sqlite"), asAsyncEventReadSurface(store), [])
  sessions = [row("s-alpha", "conv-alpha", "Alpha work"), row("s-beta", "conv-beta")]
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
    index = acquireConversationSearchIndex(path.join(tmpDir, "search.sqlite"), source, [])
    search = createTranscriptSearch({
      index,
      source: {
        ...source,
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
    expect(result.pageSize).toBe(20)
    expect(result.hits.map((hit) => [hit.sessionId, hit.role, hit.entryId])).toEqual(expect.arrayContaining([["s-alpha", "user", "a1"], ["s-alpha", "assistant", "a2"]]))
    expect(result.hits[0]?.sessionTitle).toBe("Alpha work")
    expect(result.hits.every((hit) => hit.snippet.includes("[kafka]"))).toBe(true)
  })

  test("scopes to one session, and answers nothing for a session it cannot map", async () => {
    append("conv-alpha", [user("a1", null, "kafka here")])
    append("conv-beta", [user("b1", null, "kafka there")])
    expect((await search.search({ query: "kafka", sessionId: "s-beta", page: 1 })).hits.map((hit) => hit.sessionId)).toEqual(["s-beta"])
    expect(await search.search({ query: "kafka", sessionId: "s-unknown", page: 1 })).toEqual({ hits: [], total: 0, page: 1, pageSize: 20 })
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
    expect(first.hits.length).toBe(20)
    expect(second.hits.length).toBe(5)
    expect(new Set([...first.hits, ...second.hits].map((hit) => hit.entryId)).size).toBe(25)
  })
})

describe("chat search", () => {
  test("ranks root chats by their best message, never by tool results, and leaves out other sessions and the excluded chat", async () => {
    sessions = [
      row("s-alpha", "conv-alpha", "Alpha work"), row("s-beta", "conv-beta"), row("s-gamma", "conv-gamma"), row("s-lead", "conv-lead"),
      row("s-sub", "conv-sub", undefined, "subagent"), row("s-agent", "conv-agent", undefined, "workflow-agent"),
    ]
    // Many weak hits do not outrank one strong hit.
    append("conv-alpha", Array.from({ length: 6 }, (_, i) => user(`a${i}`, i === 0 ? null : `a${i - 1}`, `dim_land came up once among many other words about unrelated topics number ${i}`)))
    append("conv-beta", [user("b1", null, "build dim_land"), assistant("b2", "b1", "dim_land dim_land is built")])
    append("conv-gamma", [user("g1", null, "run it"), toolResult("g2", "g1", "toolu_1", "dim_land dim_land dim_land")])
    for (const conversationId of ["conv-lead", "conv-sub", "conv-agent"]) append(conversationId, [user(`${conversationId}-1`, null, "dim_land dim_land")])

    const { chats } = await search.findChats({ query: "dim_land", exclude: ["s-lead"] })
    expect(chats.map((chat) => chat.sessionId)).toEqual(["s-beta", "s-alpha"])
    expect(chats[0]?.snippet).toContain("[dim_land]")
    // The best message is the entry a client lands the transcript on.
    expect(chats[0]?.entryId).toBe("b2")
  })

  test("a chat ranks behind any number of stronger hits that cannot answer: tool results, other sessions, or one chat's many messages", async () => {
    sessions = [row("s-alpha", "conv-alpha"), row("s-beta", "conv-beta"), row("s-gamma", "conv-gamma"), row("s-sub", "conv-sub", undefined, "subagent")]
    const many = (prefix: string, make: (id: string, parent: string | null) => { [key: string]: unknown }) =>
      Array.from({ length: 2_100 }, (_, i) => make(`${prefix}${i}`, i === 0 ? null : `${prefix}${i - 1}`))
    append("conv-gamma", many("g", (id, parent) => toolResult(id, parent ?? "root", `toolu_${id}`, "dim_land dim_land")))
    append("conv-sub", many("s", (id, parent) => user(id, parent, "dim_land dim_land")))
    append("conv-alpha", many("a", (id, parent) => user(id, parent, "dim_land dim_land")))
    append("conv-beta", [user("b1", null, "the dim_land table came up once among many other words about unrelated topics")])

    expect((await search.findChats({ query: "dim_land", exclude: [] })).chats.map((chat) => chat.sessionId)).toEqual(["s-alpha", "s-beta"])
  })

  test("a message matches only when it holds every word of the query, and a blank query or no match finds nothing", async () => {
    append("conv-alpha", [user("a1", null, "open PR 5132 for the graph")])
    append("conv-beta", [user("b1", null, "kafka lag")])
    expect((await search.findChats({ query: "5132 graph", exclude: [] })).chats.map((chat) => chat.sessionId)).toEqual(["s-alpha"])
    expect(await search.findChats({ query: "5132 kafka", exclude: [] })).toEqual({ chats: [] })
    expect(await search.findChats({ query: "  ", exclude: [] })).toEqual({ chats: [] })
    expect(await search.findChats({ query: "zanzibar", exclude: [] })).toEqual({ chats: [] })
  })

  test("a word being typed searches only from its third letter, and a shorter query still brings the index current", async () => {
    let catchUps = 0
    const counted = createTranscriptSearch({ index: { through: (position) => { catchUps++; return index.through(position) } }, source: asAsyncEventReadSurface(store), sessions: async () => sessions })
    append("conv-alpha", [user("a1", null, "plan the zanzibar release")])
    for (const query of ["", "z", "za", "release za", "dim_l"]) expect(await counted.findChats({ query, exclude: [] })).toEqual({ chats: [] })
    expect(catchUps).toBe(5)
    expect((await counted.findChats({ query: "the", exclude: [] })).chats.map((chat) => chat.sessionId)).toEqual(["s-alpha"])
  })

  test("a withdrawn search stops before its next stage", async () => {
    append("conv-alpha", [user("a1", null, "plan the zanzibar release")])
    const withdrawal = new AbortController()
    const source = asAsyncEventReadSurface(store)
    let catchUps = 0
    let reads = 0
    const withdrawn = createTranscriptSearch({
      index: { through: (position) => { catchUps++; return index.through(position) } },
      source: { ...source, readSlice: (...args: Parameters<typeof source.readSlice>) => { reads++; return source.readSlice(...args) } },
      // A later query replaces this one while the catalog is read.
      sessions: async () => { withdrawal.abort(); return sessions },
    })
    await expect(withdrawn.findChats({ query: "zanzibar", exclude: [] }, withdrawal.signal)).rejects.toMatchObject({ name: "AbortError" })
    expect([catchUps, reads]).toEqual([0, 0])
    expect((await withdrawn.findChats({ query: "zanzibar", exclude: [] })).chats.map((chat) => chat.sessionId)).toEqual(["s-alpha"])
  })

  test("the last word matches as a prefix from its fourth letter while the person types it, and the transcript search stays exact", async () => {
    append("conv-alpha", [user("a1", null, "plan the zanzibar release")])
    for (const query of ["zanz", "zanzi", "release zanzi", "zanzibar", "release - zanzi", "zanzibar -"]) {
      expect((await search.findChats({ query, exclude: [] })).chats.map((chat) => [chat.sessionId, chat.entryId])).toEqual([["s-alpha", "a1"]])
    }
    // A 3-letter word matches only as itself: as a prefix, it named so many index terms that a search took a second.
    expect(await search.findChats({ query: "zan", exclude: [] })).toEqual({ chats: [] })
    // Only the word being typed is a prefix: an earlier unfinished word matches nothing.
    expect(await search.findChats({ query: "zanzi release", exclude: [] })).toEqual({ chats: [] })
    expect((await search.search({ query: "zanzi", page: 1 })).total).toBe(0)
  })

  // A session list shows the snippet on one line, so a match late in a long message must start near its front.
  test("the snippet is a short window that holds a late match near its start, while the transcript search keeps its long one", async () => {
    const words = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(" ")
    append("conv-alpha", [user("a1", null, `${words("early", 60)} the zanzibar release ships ${words("late", 40)}`)])
    const [chat] = (await search.findChats({ query: "zanzibar", exclude: [] })).chats
    expect(chat?.snippet).toBe("...early57 early58 early59 the [zanzibar] release ships late0 late1 late2...")
    expect((await search.search({ query: "zanzibar", page: 1 })).hits[0]?.snippet.split(" ").length).toBeGreaterThan(20)
  })

  test("the snippet marks the words that the index matched: stemmed forms, and a prefix only for the word being typed", async () => {
    append("conv-alpha", [user("a1", null, "open PR 5132 for the provider graph")])
    append("conv-beta", [user("b1", null, "both searches were running slowly")])
    const snippet = async (query: string) => (await search.findChats({ query, exclude: [] })).chats[0]?.snippet
    expect(await snippet("pr 5132")).toBe("open [PR] [5132] for the provider graph")
    expect(await snippet("search run")).toBe("both [searches] were [running] slowly")
  })

  test("answers each chat's newest activity, and the current state of its newest checkpoint, or else its newest final message", async () => {
    append("conv-alpha", [user("a1", null, "fix the graph matcher"), assistant("a2", "a1", "The graph matcher is fixed.")], 1_000)
    checkpoint("s-alpha", "conv-alpha", "older state")
    checkpoint("s-alpha", "conv-alpha", `PR 5132 is green and waits on review. ${"x".repeat(400)}`)
    append("conv-beta", [user("b1", null, "graph review"), assistant("b2", "b1", "The graph review found two issues.")], 2_000)
    // Later batches whose model messages call tools hold no final message, more of them than one read takes.
    for (let i = 0; i < 10; i++) {
      append("conv-beta", [toolCall(`b${i}c`, i === 0 ? "b2" : `b${i - 1}r`, "Reading the graph now.")], 3_000 + 2 * i)
      append("conv-beta", [toolResult(`b${i}r`, `b${i}c`, `call-b${i}c`, "contents")], 3_001 + 2 * i)
    }

    const { chats } = await search.findChats({ query: "graph", exclude: [] })
    const alpha = chats.find((chat) => chat.sessionId === "s-alpha")
    const beta = chats.find((chat) => chat.sessionId === "s-beta")
    expect(alpha).toMatchObject({ lastActivityAt: 1_000, excerpt: { source: "checkpoint" } })
    expect(alpha?.excerpt?.text.startsWith("PR 5132 is green and waits on review.")).toBe(true)
    expect(alpha?.excerpt?.text.length).toBeLessThanOrEqual(303)
    expect(beta).toMatchObject({ lastActivityAt: 3_019, excerpt: { source: "final", text: "The graph review found two issues." } })
  })
})

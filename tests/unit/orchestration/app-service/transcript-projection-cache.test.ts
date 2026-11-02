import { describe, expect, it } from "bun:test"
import { createTranscriptProjectionCache } from "../../../../src/orchestration/app-service/transcript-projection-cache.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { indexOutputBlocks } from "../../../../src/orchestration/session/conversation/branch-history-builder.js"
import { entryRuntimeDefaults } from "../../../../src/orchestration/session-store/entry-defaults.js"
import type { ChatSessionEntry } from "../../../../src/orchestration/session-store/types.js"
import { createConversationTreeProjection } from "../../../../src/orchestration/session/conversation/conversation-projection.js"

function reader() {
  return asAsyncEventReadSurface(inMemoryEventReader([]))
}


function cacheHarness(options: { readonly maxEntries?: number; readonly idleTtlMs?: number; readonly nullProjections?: number; readonly now?: () => number } = {}) {
  let time = 0
  const active = new Set<string>()
  /** Sessions whose projection reads wait until the test opens them. */
  const held = new Map<string, Promise<void>>()
  const created: { sessionId: string; conversationId: string; executionCwd: string; disposeCalls: number }[] = []
  const { nullProjections = 0, ...cacheOptions } = options
  let remainingNullProjections = nullProjections
  const store = reader()
  const cache = createTranscriptProjectionCache({
    sessionStore: { get: (sessionId) => active.has(sessionId) ? liveEntry : undefined },
    reader: store,
    projectionReader: store,
    projectRoot: "/workspace",
    now: () => time,
    ...cacheOptions,
    createProjection: ({ sessionId, conversationId, executionCwd }) => {
      const record = { sessionId, conversationId, executionCwd, disposeCalls: 0 }
      created.push(record)
      const missing = remainingNullProjections > 0
      if (missing) remainingNullProjections -= 1
      return {
        read: async () => {
          await held.get(sessionId)
          return missing ? null : {
          ...indexOutputBlocks([]), consistencyToken: `chat-tree:v1:${conversationId}`, tipEntryId: null,
          visibleUserFilteredIndices: [], openCallIds: new Set<string>(), groupChildren: async () => { throw new Error("No group") },
          }
        },
        dispose: async () => { record.disposeCalls += 1 },
      }
    },
  })
  return { active, cache, created, store, held, setTime: (next: number) => { time = next } }
}

const liveEntry: ChatSessionEntry = { ...entryRuntimeDefaults(() => [], 0), kind: "chat", runner: null, conversationId: "live", description: "Live" }


describe("transcript projection cache", () => {
  it("touches on access and evicts the least-recently-used unpinned resident", async () => {
    const harness = cacheHarness({ maxEntries: 2 })
    await harness.cache.read("a", "conv-a", "/workspace/packages/nested")
    await harness.cache.read("b", "conv-b", "/workspace/packages/nested")
    await harness.cache.read("a", "conv-a", "/workspace/packages/nested")
    await harness.cache.read("c", "conv-c", "/workspace/packages/nested")

    expect(harness.created).toHaveLength(3)
    expect(harness.created.map(({ sessionId, disposeCalls }) => [sessionId, disposeCalls])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 0],
    ])
  })

  it("projects paths against the session's recorded execution directory, not the project root", async () => {
    const harness = cacheHarness()

    await harness.cache.read("a", "conv-a", "/workspace/packages/nested")

    expect(harness.created.map(({ executionCwd }) => executionCwd)).toEqual(["/workspace/packages/nested"])
  })

  it("retains every conversation in a session and evicts the oldest session as one unit", async () => {
    const harness = cacheHarness({ maxEntries: 2 })
    const readSession = harness.cache.createSessionReader("workflow", "/workspace/packages/nested")
    for (let index = 0; index < 9; index += 1) await readSession.readConversation(`conversation-${index}`)

    expect(harness.created).toHaveLength(9)
    expect(harness.created.map(({ disposeCalls }) => disposeCalls)).toEqual(Array.from({ length: 9 }, () => 0))

    await harness.cache.read("newer", "conversation-newer", "/workspace/packages/nested")
    await harness.cache.read("newest", "conversation-newest", "/workspace/packages/nested")

    expect(harness.created.map(({ sessionId, disposeCalls }) => [sessionId, disposeCalls])).toEqual([
      ...Array.from({ length: 9 }, () => ["workflow", 1]),
      ["newer", 0],
      ["newest", 0],
    ])
  })

  it("keeps a resident while a read builds it, so a retry after the caller's deadline finds what the read built", async () => {
    const harness = cacheHarness({ maxEntries: 2 })
    const slow = Promise.withResolvers<void>()
    harness.held.set("slow", slow.promise)
    const first = harness.cache.read("slow", "conv-slow", "/workspace")
    await Bun.sleep(0)
    await harness.cache.read("b", "conv-b", "/workspace")
    await harness.cache.read("c", "conv-c", "/workspace")
    slow.resolve()
    await first
    // The read that just ended is newer than any read that ended before it.
    await harness.cache.read("d", "conv-d", "/workspace")
    await harness.cache.read("slow", "conv-slow", "/workspace")

    expect(harness.created.map(({ sessionId, disposeCalls }) => [sessionId, disposeCalls])).toEqual([
      ["slow", 0],
      ["b", 1],
      ["c", 1],
      ["d", 0],
    ])
  })

  it("pins sessions that have a live session-store entry", async () => {
    const harness = cacheHarness({ maxEntries: 1 })
    harness.active.add("live")
    await harness.cache.read("live", "conv-live", "/workspace/packages/nested")
    await harness.cache.read("durable", "conv-durable", "/workspace/packages/nested")

    expect(harness.created.map(({ sessionId, disposeCalls }) => [sessionId, disposeCalls])).toEqual([
      ["live", 0],
      ["durable", 1],
    ])
  })

  it("releases a closed runner's resident and the conversation trees it read at once", async () => {
    const harness = cacheHarness()
    harness.active.add("live")
    await harness.cache.read("live", "conv-live", "/workspace/packages/nested")
    await harness.cache.read("other", "conv-other", "/workspace/packages/nested")
    const liveTree = createConversationTreeProjection(harness.store, "conv-live")
    const otherTree = createConversationTreeProjection(harness.store, "conv-other")
    expect(createConversationTreeProjection(harness.store, "conv-live")).toBe(liveTree)

    harness.active.delete("live")
    await harness.cache.release("live")

    expect(harness.created.map(({ sessionId, disposeCalls }) => [sessionId, disposeCalls])).toEqual([
      ["live", 1],
      ["other", 0],
    ])
    expect(createConversationTreeProjection(harness.store, "conv-live")).not.toBe(liveTree)
    expect(createConversationTreeProjection(harness.store, "conv-other")).toBe(otherTree)
    await harness.cache.read("live", "conv-live", "/workspace/packages/nested")
    expect(harness.created).toHaveLength(3)
  })

  it("releases an idle unpinned resident and its tree on its own timer, with no read to trigger it", async () => {
    const harness = cacheHarness({ maxEntries: 8, idleTtlMs: 10, now: Date.now })
    harness.active.add("live")
    await harness.cache.read("live", "conv-live", "/workspace/packages/nested")
    await harness.cache.read("idle", "conv-idle", "/workspace/packages/nested")
    const idleTree = createConversationTreeProjection(harness.store, "conv-idle")
    const liveTree = createConversationTreeProjection(harness.store, "conv-live")

    await Bun.sleep(25)

    expect(harness.created.map(({ sessionId, disposeCalls }) => [sessionId, disposeCalls])).toEqual([
      ["live", 0],
      ["idle", 1],
    ])
    expect(createConversationTreeProjection(harness.store, "conv-idle")).not.toBe(idleTree)
    expect(createConversationTreeProjection(harness.store, "conv-live")).toBe(liveTree)
    await harness.cache.dispose()
  })

  it("retains read projections when runtime membership changes", async () => {
    const harness = cacheHarness()
    await harness.cache.read("session", "conversation-a", "/workspace/packages/nested")
    await harness.cache.read("session", "conversation-b", "/workspace/packages/nested")

    harness.active.add("session")
    await harness.cache.read("session", "conversation-a", "/workspace/packages/nested")
    await harness.cache.read("session", "conversation-b", "/workspace/packages/nested")

    expect(harness.created.map(({ conversationId, disposeCalls }) => [conversationId, disposeCalls])).toEqual([
      ["conversation-a", 0],
      ["conversation-b", 0],
    ])
  })

  it("disposes and drops a projection whose conversation tree is missing", async () => {
    const harness = cacheHarness({ nullProjections: 1 })

    expect(await harness.cache.read("session", "conversation", "/workspace/packages/nested")).toBeNull()
    const reopened = await harness.cache.read("session", "conversation", "/workspace/packages/nested")
    await harness.cache.read("session", "conversation", "/workspace/packages/nested")

    expect(reopened?.consistencyToken).toBe("chat-tree:v1:conversation")
    expect(harness.created.map(({ disposeCalls }) => disposeCalls)).toEqual([1, 0])
  })

  it("rebuilds a resident only when the resolved execution directory changes", async () => {
    const harness = cacheHarness()
    await harness.cache.read("session", "conversation", "/workspace/appeared")
    await harness.cache.read("session", "conversation", "/workspace/appeared")
    await harness.cache.read("session", "conversation", "/workspace")

    expect(harness.created.map(({ executionCwd, disposeCalls }) => [executionCwd, disposeCalls])).toEqual([
      ["/workspace/appeared", 1],
      ["/workspace", 0],
    ])
  })

  it("a session reader starts its read when it is called, so a failure reaches its caller and never goes unhandled", async () => {
    const store = reader()
    const cache = createTranscriptProjectionCache({
      sessionStore: { get: () => undefined },
      reader: store,
      projectionReader: store,
      projectRoot: "/workspace",
      createProjection: ({ conversationId }) => ({
        read: async () => ({
          ...indexOutputBlocks([]), consistencyToken: `chat-tree:v1:${conversationId}`, tipEntryId: null,
          visibleUserFilteredIndices: [], openCallIds: new Set<string>(), groupChildren: async () => { throw new Error("No group") },
        }),
        dispose: async () => { throw new Error("projection dispose failed") },
      }),
    })
    await cache.read("session", "conversation", "/workspace/one")

    // A new execution directory rebuilds the resident, whose disposal fails.
    // bun test fails the running test on an unhandled rejection.
    const readSession = cache.createSessionReader("session", "/workspace/two")
    await Bun.sleep(0)

    await expect(readSession.readConversation("conversation")).rejects.toThrow("projection dispose failed")
  })

  it("disposes every projection once when dispose is called repeatedly", async () => {
    const harness = cacheHarness()
    const readA = harness.cache.createSessionReader("a", "/workspace/packages/nested")
    await readA.readConversation("conv-a-1")
    await readA.readConversation("conv-a-2")
    await harness.cache.read("b", "conv-b", "/workspace/packages/nested")

    const tree = createConversationTreeProjection(harness.store, "conv-a-2")

    await Promise.all([harness.cache.dispose(), harness.cache.dispose()])

    expect(harness.created.map(({ disposeCalls }) => disposeCalls)).toEqual([1, 1, 1])
    // An owner that disposes its cache after one read, as the history Worker
    // does, keeps no conversation tree either.
    expect(createConversationTreeProjection(harness.store, "conv-a-2")).not.toBe(tree)
    await expect(harness.cache.read("c", "conv-c", "/workspace/packages/nested")).rejects.toThrow("disposed")
  })
})

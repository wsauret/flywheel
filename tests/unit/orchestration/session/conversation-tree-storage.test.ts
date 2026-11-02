import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface, type AsyncGuardedEventWriter, type EventStore } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { ConversationTreeStorage } from "../../../../src/orchestration/session/conversation/conversation-tree-storage"
import type { ConversationEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types"
import { ConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree"
import { createConversationTreeProjection } from "../../../../src/orchestration/session/conversation/conversation-projection"
import { ContextContentIdentities } from "../../../../src/orchestration/session/conversation/conversation-context-identities"
import { countStateRequests, factsRead } from "../../../helpers/state-requests"
import { createProjectExecutionState } from "../../../../src/orchestration/app-service/project-execution-state"
import { closeFixtures, fixture } from "../app-service/_project-state-worker-fixture"

let baseDir: string
let store: EventStore
let reader: AsyncEventStateReadSurface
const sessionId = "s_abcd1234"
const conversationId = "c_abcd1234"
let nowCounter = 0

function nextTimestamp(): string {
  nowCounter += 1
  return new Date(2026, 4, 21, 0, 0, 0, nowCounter).toISOString()
}

function makeMessageEntry(parentId: string | null, id: string): ConversationEntry {
  return {
    kind: "message",
    id,
    parentId,
    timestamp: nextTimestamp(),
    message: { kind: "user", content: `from ${id}` },
  }
}

async function createStorage(): Promise<ConversationTreeStorage> {
  return ConversationTreeStorage.create({
    conversationId,
    sessionId,
    now: nextTimestamp,
    store: reader,
    writer: asAsyncEventWriter(store),
  })
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-session-tree-"))
  nowCounter = 0
  store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
  reader = asAsyncEventReadSurface(store)
})

afterEach(async () => {
  store.close()
  fs.rmSync(baseDir, { recursive: true, force: true })
  await closeFixtures()
})

describe("ConversationTreeStorage.create", () => {
  it("yields before materializing a captured branch and keeps its committed boundary", async () => {
    const storage = await createStorage()
    const seed = Array.from({ length: 128 }, (_, index) =>
      makeMessageEntry(index === 0 ? null : `walk-${index - 1}`, `walk-${index}`))
    await storage.appendEntries(seed)
    const input = await storage.captureInput()
    const root = input.entriesById["walk-0"]
    let rootVisits = 0
    Object.defineProperty(input.entriesById, "walk-0", {
      configurable: true, enumerable: true,
      get() { rootVisits += 1; return root },
    })
    const reached = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    let clock = 0
    let paused = false
    const capture = storage.captureCommittedActiveBranch({
      now: () => { clock += 8; return clock },
      yieldToNextTask: async () => {
        if (paused) return
        paused = true
        reached.resolve()
        await resume.promise
      },
    })
    await reached.promise
    try {
      expect(rootVisits).toBe(0)
      await storage.appendEntries([makeMessageEntry("walk-127", "walk-later")])
    } finally {
      resume.resolve()
    }
    const selected = await capture
    expect(selected.entries).toHaveLength(128)
    expect(selected.leafEntryId).toBe("walk-127")
    expect(selected.foldedPosition).toBe(input.foldedPosition)
    expect((await storage.captureCommittedActiveBranch()).entries).toHaveLength(129)
  })

  it("fails when the chat tree already exists", async () => {
    const storage = await createStorage()
    storage.dispose()
    await expect(createStorage()).rejects.toThrow(/already exists/)
  })
})

describe("appendEntries", () => {
  it("keeps gap-record identities on the selected context boundary through compaction and rewind", async () => {
    const storage = await createStorage()
    try {
      await storage.appendEntry(makeMessageEntry(null, "source"))
      const identity = "c".repeat(64)
      store.append({
        aggregateId: `conversation:${conversationId}`, type: "chat.entries.appended", version: 999,
        actor: "flywheel", sessionId, timestamp: Date.now(), payload: { unreadableNotice: identity },
      })
      const owner = createConversationTreeProjection(reader, conversationId)
      const gap = await owner.replay()
      expect(gap.contextIdentities.at(gap.leafId).has(identity)).toBe(true)
      expect((await new ConversationTree(storage).buildContext()).messages.some(message => JSON.stringify(message).includes(identity))).toBe(true)
      await storage.appendEntry(makeMessageEntry("source", "after-gap"))
      await storage.appendEntry({
        kind: "compaction", id: "first-reset", parentId: "after-gap", timestamp: nextTimestamp(),
        mode: "reset", sourceLeafId: "source", tokensBefore: 1000, tokensAfter: 100,
      })
      const retained = await owner.replay()
      expect(retained.contextIdentities.at(retained.leafId).has(identity)).toBe(true)
      await storage.appendEntry({
        kind: "compaction", id: "second-reset", parentId: "first-reset", timestamp: nextTimestamp(),
        mode: "reset", sourceLeafId: "first-reset", tokensBefore: 100, tokensAfter: 0,
      })
      const removed = await owner.replay()
      expect(removed.contextIdentities.at(removed.leafId).has(identity)).toBe(false)
      await storage.appendEntry({
        kind: "leaf", id: "rewind-gap", parentId: "second-reset", targetId: "after-gap", timestamp: nextTimestamp(),
      })
      const rewound = await owner.replay()
      expect(rewound.contextIdentities.at(rewound.leafId).has(identity)).toBe(true)
    } finally {
      storage.dispose()
    }
  })

  it.each(["reset", "summary"] as const)("selects retained and concurrently appended identities across a %s compaction and rewind", async (mode) => {
    const storage = await createStorage()
    try {
      const original = "a".repeat(64)
      const suffix = "b".repeat(64)
      await storage.appendEntries([
        { ...makeMessageEntry(null, "source"), kind: "message", message: { kind: "user", content: original } },
        { ...makeMessageEntry("source", "suffix"), kind: "message", message: { kind: "user", content: suffix } },
      ])
      const fields = { kind: "compaction" as const, id: "compaction", parentId: "suffix", sourceLeafId: "source", timestamp: nextTimestamp(), tokensBefore: 1000, tokensAfter: 100 }
      await storage.appendEntry(mode === "reset"
        ? { ...fields, mode }
        : { ...fields, mode, summary: "summary", retainedMessages: [{ kind: "user", content: original }] })
      const owner = createConversationTreeProjection(reader, conversationId)
      const compacted = await owner.replay()
      const selected = compacted.contextIdentities.at(compacted.leafId)
      expect(selected.has(original)).toBe(mode === "summary")
      expect(selected.has(suffix)).toBe(true)
      await storage.appendEntry({ kind: "leaf", id: "rewind", parentId: "compaction", targetId: "source", timestamp: nextTimestamp() })
      const rewound = await owner.replay()
      const previous = rewound.contextIdentities.at(rewound.leafId)
      expect(previous.has(original)).toBe(true)
      expect(previous.has(suffix)).toBe(false)
      expect(selected.has(suffix)).toBe(true)
    } finally {
      storage.dispose()
    }
  })

  it.each([3, 60])("advances context identity selection without revisiting %i earlier messages", async (history) => {
    const counter = countStateRequests(reader)
    reader = counter.reader
    const storage = await createStorage()
    try {
      const seed = Array.from({ length: history }, (_, index): ConversationEntry => ({
        ...makeMessageEntry(index === 0 ? null : `identity-${index - 1}`, `identity-${index}`),
        kind: "message",
        message: { kind: "user", content: (index + 1).toString(16).padStart(64, "0") },
      }))
      await storage.appendEntries(seed)
      const owner = createConversationTreeProjection(reader, conversationId)
      const initial = await owner.replay()
      const previous = initial.contextIdentities.at(initial.leafId)
      const textVisits = spyOn(ContextContentIdentities.prototype, "appendText")
      try {
        const next = "f".repeat(64)
        counter.take()
        await storage.appendEntry({
          ...makeMessageEntry(`identity-${history - 1}`, "later"),
          kind: "message", message: { kind: "user", content: next },
        })
        const state = await owner.replay()
        const selected = state.contextIdentities.at(state.leafId)
        expect(selected.has(next)).toBe(true)
        expect(previous.has(next)).toBe(false)
        expect(selected.changesSince(previous)).toEqual({ added: [next], removed: [] })
        expect(textVisits).toHaveBeenCalledTimes(1)
        expect(factsRead(counter.take())).toBe(1)
      } finally {
        textVisits.mockRestore()
      }
    } finally {
      storage.dispose()
    }
  })

  it("an executor's append folds its own facts and their tool content from the commit window", async () => {
    const state = await fixture(undefined, undefined, false, [], { commitWindow: true })
    const execution = await createProjectExecutionState(state.client)
    const storage = await ConversationTreeStorage.create({ conversationId, sessionId, now: nextTimestamp, store: execution.eventReader, writer: execution.eventWriter })
    try {
      await storage.appendEntries([{ kind: "message", id: "ask", parentId: null, timestamp: nextTimestamp(), message: { kind: "assistant", content: [{ type: "tool_use", id: "tool", name: "search", input: {} }] } }])
      // Text over the inline threshold becomes a tool content row of the append.
      const result: ConversationEntry = { kind: "message", id: "result", parentId: "ask", timestamp: nextTimestamp(), message: { kind: "toolResult", toolUseId: "tool", content: [{ type: "text", text: "output ".repeat(1_000) }] } }
      const requests = spyOn(state.service, "enqueue")
      await storage.appendEntries([result])
      // The barriers of the guard read, which the window answers, and of the
      // fold before the append; the fold after it reads nothing.
      expect(requests.mock.calls.map(([, operation]) => operation.kind)).toEqual(["position.capture", "position.capture", "append"])
      const sql = await createConversationTreeProjection(asAsyncEventReadSurface(state.store), conversationId).replay()
      expect(sql.entriesById["result"]).toEqual(result)
      expect(storage.openedState().entriesById["result"]).toEqual(result)
    } finally {
      storage.dispose()
      await execution.eventStoreRuntime.dispose()
    }
  })

  it.each(["before", "preparation", "accepted"] as const)("reset cancellation only withdraws before writer admission: %s", async (boundary) => {
    const storage = await createStorage()
    await storage.appendEntry(makeMessageEntry(null, "root"))
    const abort = new AbortController()
    const reason = new Error("interrupted")
    if (boundary === "before") abort.abort(reason)
    let clock = 0
    let yielded = false
    const tree = new ConversationTree(storage, boundary === "preparation" ? {
      now: () => { clock += 8; return clock },
      yieldToNextTask: async () => { yielded = true; abort.abort(reason) },
    } : undefined)
    const writer = asAsyncEventWriter(store)
    const admitted = spyOn(writer, "appendBatchGuarded")
    const selected = await ConversationTreeStorage.open({ conversationId, sessionId, store: reader, writer })
    const resetTree = boundary === "accepted" ? new ConversationTree(selected) : tree
    if (boundary === "accepted") admitted.mockImplementation(async (events) => {
      abort.abort(reason)
      return asAsyncEventWriter(store).appendBatchGuarded(events)
    })
    const reset = resetTree.appendCompaction({
      sourceLeafId: "root", tokensBefore: 200_000, tokensAfter: 10,
      opening: [{ message: { kind: "user", content: "session notes" } }],
    }, abort.signal)
    try {
      if (boundary === "accepted") {
        await reset
        expect((await resetTree.getBranch()).some((entry) => entry.kind === "compaction")).toBe(true)
      } else {
        await expect(reset).rejects.toThrow(/notCommitted/)
        expect(await tree.getLeafId()).toBe("root")
        expect(store.read({ aggregateId: `conversation:${conversationId}` })).toHaveLength(2)
        if (boundary === "preparation") expect(yielded).toBe(true)
      }
    } finally {
      admitted.mockRestore()
      selected.dispose()
      storage.dispose()
    }
  })

  it("withdraws a reset interrupted during storage validation before writer admission", async () => {
    const storage = await createStorage()
    await storage.appendEntry(makeMessageEntry(null, "root"))
    const abort = new AbortController()
    const reason = new Error("interrupted during validation")
    const reset: ConversationEntry = {
      kind: "compaction", id: "reset", timestamp: nextTimestamp(), mode: "reset",
      sourceLeafId: "root", tokensBefore: 200_000, tokensAfter: 10,
      get parentId() { abort.abort(reason); return "root" },
    }
    try {
      expect(await storage.extendBranch(async () => [reset], undefined, abort.signal)).toEqual({ kind: "notCommitted", cause: reason })
      expect(await storage.getLeafId()).toBe("root")
      expect(store.read({ aggregateId: `conversation:${conversationId}` })).toHaveLength(2)
    } finally {
      storage.dispose()
    }
  })

  it("validates and folds small appends without visiting unrelated committed entries", async () => {
    const storage = await createStorage()
    const seed = Array.from({ length: 128 }, (_, index) =>
      makeMessageEntry(index === 0 ? null : `seed-${index - 1}`, `seed-${index}`))
    await storage.appendEntries(seed)
    let visits = 0
    const before = await storage.getState()
    const root = await storage.getEntry("seed-0")
    Object.defineProperty(before.entriesById, "seed-0", {
      enumerable: true,
      configurable: true,
      get() { visits += 1; return root },
    })
    const branch = await storage.getPathToRoot(before.leafId)
    visits = 0
    for (let index = 0; index < 32; index += 1) {
      const outcome = await storage.appendEntry(makeMessageEntry(index === 0 ? "seed-127" : `tail-${index - 1}`, `tail-${index}`))
      expect(outcome.kind).toBe("committed")
    }
    expect(visits).toBe(0)
    const after = await storage.getState()
    expect(after).not.toBe(before)
    expect(after.entriesById).toBe(before.entriesById)
    expect(before.leafId).toBe("seed-127")
    expect(before.assistantWatermark).toBe(-1)
    expect(branch).toHaveLength(128)
    expect(branch.at(-1)?.id).toBe("seed-127")
    expect(after.leafId).toBe("tail-31")
    expect(await storage.getState()).toBe(after)
    storage.dispose()
  })

  it("does not publish a batch when the writer refuses it", async () => {
    const initial = await createStorage()
    await initial.appendEntry(makeMessageEntry(null, "root"))
    const storage = await ConversationTreeStorage.open({
      conversationId, sessionId, store: reader,
      writer: {
        append: async () => { throw new Error("refused") },
        appendBatch: async () => { throw new Error("refused") },
      },
    })
    const before = await storage.getState()
    const position = await storage.getFoldedPosition()
    const pending = makeMessageEntry("root", "pending")
    storage.appendPending(pending)
    expect((await storage.appendEntries([pending, makeMessageEntry("pending", "child")])).kind).toBe("notCommitted")
    expect(await storage.getState()).toBe(before)
    expect(await storage.getEntry("pending")).toBeUndefined()
    expect(await storage.getEntry("child")).toBeUndefined()
    expect(await storage.getFoldedPosition()).toBe(position)
    expect(storage.getPendingEntries()).toEqual([pending])
    storage.dispose()
    initial.dispose()
  })

  it("refreshes and retries a guarded save-point conflict", async () => {
    const initial = await createStorage()
    const base = asAsyncEventWriter(store)
    let attempts = 0
    const writer: AsyncGuardedEventWriter = {
      ...base,
      appendBatchGuarded: async (events) => {
        attempts += 1
        const [event] = events
        if (attempts === 1 && event) {
          return {
            kind: "conflict",
            conflict: { aggregateId: event.aggregateId, expectedSeq: event.expectedSeq ?? 0, actualSeq: (event.expectedSeq ?? 0) + 1 },
          }
        }
        return base.appendBatchGuarded(events)
      },
    }
    const storage = await ConversationTreeStorage.open({ conversationId, sessionId, store: reader, writer })

    expect(await storage.appendEntry(makeMessageEntry(null, "retried"))).toEqual({ kind: "committed" })
    expect(attempts).toBe(2)
    expect(await storage.getLeafId()).toBe("retried")
    storage.dispose()
    initial.dispose()
  })

  it("validates follow-up identity across the committed index and the pending overlay", async () => {
    const storage = await createStorage()
    const request: ConversationEntry = {
      kind: "message", id: "request", parentId: null, timestamp: nextTimestamp(),
      message: { kind: "user", content: "question" }, followUpRequestSequence: 1,
    }
    const duplicate: ConversationEntry = { ...request, id: "duplicate", parentId: "request" }
    await expect(storage.prepareEntriesAppend(async () => [request, duplicate])).rejects.toThrow(/duplicate follow-up/)
    expect(await storage.getEntry("request")).toBeUndefined()
    await storage.appendEntry(request)
    const before = await storage.getState()
    await expect(storage.prepareEntriesAppend(async () => [makeMessageEntry("request", "pending"), duplicate])).rejects.toThrow(/duplicate follow-up/)
    expect(await storage.getEntry("pending")).toBeUndefined()
    expect(await storage.getState()).toBe(before)
    storage.dispose()
  })

  it("commits a save-point batch as one SQLite fact and advances the active leaf", async () => {
    const storage = await createStorage()
    const first = makeMessageEntry(null, "a0000001")
    const second = makeMessageEntry("a0000001", "a0000002")
    const third = makeMessageEntry("a0000002", "a0000003")

    const outcome = await storage.appendEntries([first, second, third])

    expect(outcome.kind).toBe("committed")
    expect(await storage.getLeafId()).toBe("a0000003")
    try {
      const events = store.read({ aggregateId: `conversation:${conversationId}` })
      expect(events.map((event) => event.type)).toEqual(["chat.tree.created", "chat.entries.appended"])
      const payload = events[1]?.payload
      expect(payload && "entries" in payload ? payload.entries : undefined).toHaveLength(3)
    } finally {
      storage.dispose()
    }
  })

  it("stores a content-repair decision at version 8 and keeps every other batch at its earlier version", async () => {
    const storage = await createStorage()
    const contentRepair = { kind: "withhold", toolUseId: "toolu_1", partIndex: 1, partKind: "image" } as const
    const decision: ConversationEntry = {
      kind: "message", id: "a0000002", parentId: "a0000001", timestamp: nextTimestamp(),
      message: { kind: "system", content: "The provider refused an image; it is withheld.", contentRepair },
    }
    try {
      await storage.appendEntries([makeMessageEntry(null, "a0000001"), decision])
      await storage.appendEntries([makeMessageEntry("a0000002", "a0000003")])
      const appended = store.read({ aggregateId: `conversation:${conversationId}`, types: ["chat.entries.appended"] })
      expect(appended.map((event) => event.version)).toEqual([8, 3])

      const reopened = await ConversationTreeStorage.open({ conversationId, sessionId, store: reader, writer: asAsyncEventWriter(store) })
      const folded = await reopened.getEntry("a0000002")
      reopened.dispose()
      expect(folded?.kind === "message" ? folded.message : undefined).toEqual(decision.message)
    } finally {
      storage.dispose()
    }
  })

  it("rejects a batch with an orphan entry without mutating the projection", async () => {
    const storage = await createStorage()
    const valid = makeMessageEntry(null, "a0000001")
    const child = makeMessageEntry("a0000001", "a0000002")
    const orphan = makeMessageEntry("a9999999", "a0000003")

    await expect(storage.appendEntries([valid, child, orphan])).rejects.toThrow(/missing parent/)
    expect(await storage.getEntry("a0000001")).toBeUndefined()
    expect(await storage.getEntry("a0000002")).toBeUndefined()
    expect(await storage.getLeafId()).toBeNull()

    const reopened = await ConversationTreeStorage.open({ conversationId, sessionId, store: reader, writer: asAsyncEventWriter(store) })
    expect(await reopened.getLeafId()).toBeNull()
    reopened.dispose()
    storage.dispose()
  })

  it("gives every entry of one batch its own allocated id", async () => {
    const storage = await createStorage()
    const draws = ["0000000a", "0000000a", "0000000b", "0000000b", "0000000c"]
    const uuid = spyOn(crypto, "randomUUID").mockImplementation(() => `${draws.shift() ?? "ffffffff"}-0000-4000-8000-000000000000`)
    try {
      const outcome = await storage.extendBranch(async () => {
        const first = makeMessageEntry(null, await storage.allocateId())
        return [first, makeMessageEntry(first.id, await storage.allocateId())]
      })
      expect(outcome.kind).toBe("committed")
      expect(await storage.getLeafId()).toBe("0000000b")
      // A committed id stays taken after the batch that issued it.
      expect(await storage.allocateId()).toBe("0000000c")
    } finally {
      uuid.mockRestore()
      storage.dispose()
    }
  })
})

// Builds before 2026-10-03 ran workflow follow-up turns in the workflow's own
// conversation and closed each one with a `chat.follow_up_turn.completed`
// marker. No current path writes the marker, but stored conversations hold it,
// and strict replay must keep reading it.
describe("historical follow-up turn markers", () => {
  type HistoricalFact =
    | { readonly type: "chat.entries.appended"; readonly entries: readonly ConversationEntry[] }
    | { readonly type: "chat.follow_up_turn.completed"; readonly requestSequence: number }

  function appendHistorical({ type, ...payload }: HistoricalFact): void {
    store.append({ aggregateId: `conversation:${conversationId}`, sessionId, type, version: 1, actor: "flywheel", timestamp: 125, payload: { conversationId, ...payload } })
  }

  async function seedFollowUpTurn(): Promise<void> {
    const storage = await createStorage()
    await storage.appendEntry(makeMessageEntry(null, "a0000001"))
    storage.dispose()
    const request: ConversationEntry = {
      kind: "message", id: "a0000002", parentId: "a0000001", timestamp: nextTimestamp(),
      message: { kind: "user", content: "follow-up question" }, followUpRequestSequence: 1,
    }
    appendHistorical({ type: "chat.entries.appended", entries: [request] })
    appendHistorical({ type: "chat.follow_up_turn.completed", requestSequence: 1 })
  }

  it("replays a completed follow-up turn", async () => {
    await seedFollowUpTurn()
    const reopened = await ConversationTreeStorage.open({ conversationId, sessionId, store: reader })
    try {
      expect((await reopened.getState()).completedFollowUpRequestSequences).toEqual([1])
      expect((await reopened.getPathToRoot(await reopened.getLeafId())).map((entry) => entry.id)).toEqual(["a0000001", "a0000002"])
    } finally {
      reopened.dispose()
    }
  })

  it("rejects a repeated completion marker", async () => {
    await seedFollowUpTurn()
    appendHistorical({ type: "chat.follow_up_turn.completed", requestSequence: 1 })
    await expect(ConversationTreeStorage.open({ conversationId, sessionId, store: reader })).rejects.toThrow(/already completed/)
  })
})

describe("setLeafId and getPathToRoot", () => {
  it("reads the active branch with one catch-up after a change", async () => {
    const counter = countStateRequests(reader)
    reader = counter.reader
    const storage = await createStorage()
    try {
      await storage.appendEntries([makeMessageEntry(null, "a0000001"), makeMessageEntry("a0000001", "a0000002")])
      store.append({
        aggregateId: `conversation:${conversationId}`, sessionId, type: "chat.entries.appended", version: 1, actor: "flywheel", timestamp: 123,
        payload: { conversationId, entries: [makeMessageEntry("a0000002", "a0000003")] },
      })
      counter.take()
      expect((await new ConversationTree(storage).getBranch()).map((entry) => entry.id)).toEqual(["a0000001", "a0000002", "a0000003"])
      expect(counter.take().filter((request) => request.method === "readPage")).toHaveLength(1)
    } finally {
      storage.dispose()
    }
  })

  it("records leaf movement as an in-band tree entry", async () => {
    const storage = await createStorage()
    const first = makeMessageEntry(null, "a0000001")
    const second = makeMessageEntry("a0000001", "a0000002")
    await storage.appendEntries([first, second])
    await storage.setLeafId("a0000001")

    expect(await storage.getLeafId()).toBe("a0000001")
    const reopened = await ConversationTreeStorage.open({ conversationId, sessionId, store: reader, writer: asAsyncEventWriter(store) })
    expect(await reopened.getLeafId()).toBe("a0000001")
    reopened.dispose()
    storage.dispose()
  })

  it("keeps disconnected committed entries out of topology and exposes safe transcript notices", async () => {
    const storage = await createStorage()
    const root = makeMessageEntry(null, "a0000001")
    await storage.appendEntry(root)
    storage.dispose()
    store.append({
      aggregateId: `conversation:${conversationId}`,
      sessionId,
      type: "chat.entries.appended",
      version: 1,
      actor: "flywheel",
      timestamp: 123,
      payload: {
        conversationId,
        entries: [
          makeMessageEntry("missing-1", "orphan-1"),
          makeMessageEntry("orphan-1", "orphan-2"),
        ],
      },
    })

    const reopened = await ConversationTreeStorage.open({ conversationId, sessionId, store: reader, writer: asAsyncEventWriter(store) })
    expect((await reopened.getPathToRoot(await reopened.getLeafId())).map((entry) => entry.id)).toEqual([root.id])
    expect((await reopened.getContextPathToRoot(await reopened.getLeafId())).map((entry) => entry.id)).toEqual([root.id])
    expect(await reopened.getEntry("orphan-1")).toBeUndefined()
    const transcript = await reopened.getTranscriptToRoot(await reopened.getLeafId())
    expect(transcript.map((entry) => entry.kind)).toEqual(["message", "degraded", "degraded"])
    expect(transcript.filter((entry) => entry.kind === "degraded").map((entry) => entry.block.notice)).toEqual([
      "Part of this transcript could not be displayed.",
      "Part of this transcript could not be displayed.",
    ])
    reopened.dispose()
  })

  it("salvages valid siblings around a malformed historical entry in source order", async () => {
    const storage = await createStorage()
    const root = makeMessageEntry(null, "a0000001")
    await storage.appendEntry(root)
    storage.dispose()
    const first = makeMessageEntry(root.id, "a0000002")
    const last = makeMessageEntry(first.id, "a0000003")
    store.append({
      aggregateId: `conversation:${conversationId}`,
      sessionId,
      type: "chat.entries.appended",
      version: 1,
      actor: "flywheel",
      timestamp: 124,
      payload: { conversationId, entries: [first, { kind: "message", id: "broken", parentId: first.id }, last] },
    })

    const reopened = await ConversationTreeStorage.open({ conversationId, sessionId, store: reader })
    expect((await reopened.getPathToRoot(await reopened.getLeafId())).map((entry) => entry.id)).toEqual([root.id, first.id, last.id])
    const transcript = await reopened.getTranscriptToRoot(await reopened.getLeafId())
    expect(transcript.map((entry) => entry.kind)).toEqual(["message", "message", "degraded", "message"])
    const gap = transcript[2]
    if (gap?.kind !== "degraded") throw new Error("expected degraded transcript item")
    expect(gap.sourceEntryId).toBe("broken")
    expect(gap.ordinal).toBe(1)
    expect(gap.event.version).toBe(1)
    reopened.dispose()
  })

  it("rejects leaf targets pointing to unknown entries", async () => {
    const storage = await createStorage()
    await expect(storage.setLeafId("unknown")).rejects.toThrow()
    storage.dispose()
  })
})

describe("borrowed store lifecycle", () => {
  it("dispose leaves the owner store usable", async () => {
    const storage = await createStorage()
    storage.dispose()

    const event = store.append({
      aggregateId: "owner:lifecycle",
      type: "owner.store.usable",
      version: 1,
      timestamp: Date.now(),
      actor: "test",
      sessionId,
      payload: {},
    })

    expect(store.read({ aggregateId: "owner:lifecycle" })).toEqual([event])
  })
})

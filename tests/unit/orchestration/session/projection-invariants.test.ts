import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { asAsyncEventReadSurface, CorruptEventRowError, type EventStore } from "../../../../src/infra/event-store-types"
import { InvariantViolation } from "../../../../src/infra/invariant"
import { createSessionMetadataProjection, createSingleSessionMetadataProjection, recoverSessionMetadata } from "../../../../src/orchestration/session/session-metadata-projection"
import { readSessionMetadata } from "../../../../src/orchestration/session/session-metadata-store"
import { branchVisibleTranscriptEntries, createConversationTreeProjection } from "../../../../src/orchestration/session/conversation/conversation-projection"
import { walkBranchFromLeaf } from "../../../../src/orchestration/session/conversation/conversation-tree-context"
import { assertTolerantReprojectionRegistryComplete, registeredPhaseOneWireTestNames, tolerantReprojectionFixtures } from "../../../fixtures/tolerant-reprojection-fixtures.js"
import { readToolResultDisplayMeta } from "../../../../src/orchestration/session/conversation/tool-result-meta.js"
import { sessionMetadataCatalogFromState } from "../../../../src/orchestration/session/session-catalog-read.js"
import { countStateRequests, factsRead } from "../../../helpers/state-requests.js"

interface ChatEntryFixture {
  [key: string]: unknown
}
let tmpDir: string
let store: EventStore

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-proj-inv-"))
  store = createSqliteEventStore(path.join(tmpDir, "flywheel.sqlite"))
})

afterEach(() => {
  store.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function appendChildLinkedWithoutCreated(sessionId: string) {
  store.append({
    aggregateId: `session:${sessionId}`,
    type: "session.child.linked",
    version: 1,
    timestamp: Date.now(),
    actor: "flywheel",
    sessionId,
    payload: { childSessionId: "child-1", lastUpdated: new Date().toISOString() },
  })
}

function appendCreated(sessionId: string) {
  store.append({
    aggregateId: `session:${sessionId}`,
    type: "session.created",
    version: 3,
    timestamp: Date.now(),
    actor: "flywheel",
    sessionId,
    payload: { label: "Chat", name: "Chat", lifecycleState: "inactive", executionCwd: tmpDir, lastUpdated: "2026-05-08T00:00:00.000Z", kind: "chat", command: "chat", conversationId: `conv-${sessionId}` },
  })
}

function appendLabelUpdated(sessionId: string) {
  store.append({
    aggregateId: `session:${sessionId}`,
    type: "session.label.updated",
    version: 1,
    timestamp: Date.now(),
    actor: "flywheel",
    sessionId,
    payload: { label: "Renamed", shortLabel: "Renamed", name: "Renamed", lastUpdated: "2026-05-08T00:00:01.000Z" },
  })
}

/** Simulates on-disk corruption of one row, out of band of the writer. */
function corruptPayload(sessionId: string, eventType: string) {
  const db = new Database(path.join(tmpDir, "flywheel.sqlite"))
  db.run("update event set payload = '{{{not-json' where session_id = ? and type = ?", [sessionId, eventType])
  db.close()
}

describe("session-metadata-projection invariants", () => {
  test("registry matrix names every authoritative family and gives every leaf a disposition", () => {
    expect(() => assertTolerantReprojectionRegistryComplete()).not.toThrow()
    expect(tolerantReprojectionFixtures.session_metadata.descriptors).toContainEqual({ type: "session.created", version: 5 })
    expect(tolerantReprojectionFixtures.chat_tree.descriptors).toContainEqual({ type: "chat.entries.appended", version: 1 })
    expect(tolerantReprojectionFixtures.decorations.descriptors).toContainEqual({ type: "tool.result.recorded", version: 1 })
    expect(tolerantReprojectionFixtures.workflow_control.descriptors).toContainEqual({ type: "workflow.control.committed", version: 2 })
    expect(registeredPhaseOneWireTestNames).toHaveLength(15)
  })

  // The metadata projection is workspace-wide, so corruption is captured as
  // per-session state instead of thrown: one bad session must not poison the
  // projection or block listing the rest.
  test("session_metadata mutation-before-creation strict-projection records the missing creation invariant", async () => {
    appendChildLinkedWithoutCreated("sess-1")

    const state = await createSessionMetadataProjection(asAsyncEventReadSurface(store)).replay()

    expect(state.sessions["sess-1"]).toBeUndefined()
    expect(state.errors["sess-1"]).toContain("session.created has not been observed for sess-1")
  })

  test("single-session reads never evict the held workspace catalog and fold only their own aggregate", async () => {
    const catalog = createSessionMetadataProjection(asAsyncEventReadSurface(store))
    for (let index = 0; index < 100; index++) {
      await readSessionMetadata(asAsyncEventReadSurface(store), `sess-lookup-${index}`)
    }
    // Single-session projections live in their own registry family: sharing
    // the catalog's would have evicted it after 64 reads and refolded the
    // workspace from position zero on the next listing.
    expect(createSessionMetadataProjection(asAsyncEventReadSurface(store))).toBe(catalog)
    const one = createSingleSessionMetadataProjection(asAsyncEventReadSurface(store), "recoverable-1")
    expect(createSingleSessionMetadataProjection(asAsyncEventReadSurface(store), "recoverable-1")).toBe(one)
    appendCreated("only-this-one")
    appendCreated("not-this-one")
    const state = await createSingleSessionMetadataProjection(asAsyncEventReadSurface(store), "only-this-one").replay()
    expect(Object.keys(state.sessions)).toEqual(["only-this-one"])
  })

  test("facts after a session.deleted tombstone are superseded, not corruption", async () => {
    store.append({
      aggregateId: "session:sess-2",
      type: "session.deleted",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: "sess-2",
      payload: { lastUpdated: new Date().toISOString() },
    })
    appendChildLinkedWithoutCreated("sess-2")

    const state = await createSessionMetadataProjection(asAsyncEventReadSurface(store)).replay()

    expect(state.sessions["sess-2"]).toBeUndefined()
    expect(state.errors["sess-2"]).toBeUndefined()
    expect(state.deleted["sess-2"]).toBe(true)
  })

  test("session_metadata invalid JSON strict-projection captures a per-session error and strict read throws", async () => {
    appendCreated("healthy-1")
    appendCreated("corrupt-1")
    corruptPayload("corrupt-1", "session.created")

    const state = await createSessionMetadataProjection(asAsyncEventReadSurface(store)).replay()

    expect(state.sessions["healthy-1"]).toBeDefined()
    expect(state.sessions["corrupt-1"]).toBeUndefined()
    expect(state.errors["corrupt-1"]).toContain("corrupt event row")
    expect(() => store.read({ aggregateId: "session:corrupt-1", types: ["session.created"] })).toThrow(CorruptEventRowError)
  })

  test("session_metadata valid-current strict-projection accepts the registered current wire", async () => {
    appendCreated("current-1")
    expect((await createSessionMetadataProjection(asAsyncEventReadSurface(store)).replay()).sessions["current-1"]).toBeDefined()
  })

  test("decorations tool-result-without-tool-use decoration-reader preserves metadata by tool identity", async () => {
    store.append({
      aggregateId: "session:decorated", sessionId: "decorated", type: "tool.result.recorded", version: 1, actor: "flywheel", timestamp: 1,
      payload: { toolUseId: "missing", outcome: "ok", details: { diff: "sanitized diff", filetype: "typescript" } },
    })
    expect((await readToolResultDisplayMeta(asAsyncEventReadSurface(store), "decorated")).get("missing")).toEqual({ diff: "sanitized diff", filetype: "typescript" })
  })

  test("folds a mixed history to one result in one catch-up and per-fact catch-ups", async () => {
    const history = [
      () => appendCreated("keep-1"),
      () => appendCreated("gone-1"),
      () => appendLabelUpdated("keep-1"),
      () => appendChildLinkedWithoutCreated("orphan-1"),
      () => store.append({
        aggregateId: "session:gone-1", type: "session.deleted", version: 1, timestamp: Date.now(),
        actor: "flywheel", sessionId: "gone-1", payload: { lastUpdated: "2026-05-08T00:00:02.000Z" },
      }),
      () => appendCreated("keep-2"),
      () => appendChildLinkedWithoutCreated("keep-2"),
      () => appendCreated("gone-1"),
    ]
    const perFact = createSingleSessionMetadataProjection(asAsyncEventReadSurface(store), "keep-2")
    const catalogPerFact = createSessionMetadataProjection(asAsyncEventReadSurface(store))
    const snapshots = []
    for (const append of history) {
      append()
      snapshots.push(structuredClone(await catalogPerFact.replay()))
      await perFact.replay()
    }
    // A second reader holds its own catalog, which folds the whole history at once.
    const oneCatchUp = await createSessionMetadataProjection({ ...asAsyncEventReadSurface(store) }).replay()

    expect(Object.keys(oneCatchUp.sessions)).toEqual(["keep-1", "keep-2", "gone-1"])
    expect(oneCatchUp.sessions["keep-1"]?.label).toBe("Renamed")
    expect(oneCatchUp.sessions["keep-2"]?.childSessionIds).toEqual(["child-1"])
    expect(oneCatchUp.deleted).toEqual({})
    expect(Object.keys(oneCatchUp.errors)).toEqual(["orphan-1"])
    expect(snapshots.at(-1)).toEqual(oneCatchUp)
    expect(perFact.getState().sessions).toEqual({ "keep-2": oneCatchUp.sessions["keep-2"]! })
    // Snapshot 5 is the state right after the deletion.
    expect(snapshots[4]?.deleted).toEqual({ "gone-1": true })
  })

  test("a catch-up that folds facts publishes a new state and leaves earlier states unchanged", async () => {
    const catalog = createSessionMetadataProjection(asAsyncEventReadSurface(store))
    appendCreated("first-1")
    const first = await catalog.replay()
    const firstCopy = structuredClone(first)
    expect(await catalog.replay()).toBe(first)

    appendLabelUpdated("first-1")
    appendCreated("second-1")
    const second = await catalog.replay()

    expect(second).not.toBe(first)
    expect(first).toEqual(firstCopy)
    expect(second.sessions["first-1"]?.label).toBe("Renamed")
    expect(Object.keys(second.sessions)).toEqual(["first-1", "second-1"])
  })

  test("aggregate salvage recovers a session quarantined by a readable fact", async () => {
    appendCreated("first-1")
    appendCreated("second-1")
    store.append({
      aggregateId: "session:first-1", type: "session.created", version: 3, timestamp: Date.now(),
      actor: "flywheel", sessionId: "first-1", payload: { label: 42 },
    })

    const state = await createSessionMetadataProjection(asAsyncEventReadSurface(store)).replay()

    expect(state.errors["first-1"]).toBeDefined()
    expect(state.sessions["first-1"]).toBeUndefined()
    expect((await recoverSessionMetadata(asAsyncEventReadSurface(store), "first-1"))?.label).toBe("Chat")
    expect((await recoverSessionMetadata(asAsyncEventReadSurface(store), "second-1"))?.label).toBe("Chat")
  })

  test("quarantined catalog reads advance once per change, independent of retained damaged sessions", async () => {
    const workPerChange = async (count: number) => {
      const { reader, take } = countStateRequests(asAsyncEventReadSurface(store))
      const projection = createSessionMetadataProjection(reader)
      const ids = Array.from({ length: count }, (_, index) => `damaged-${count}-${index}`)
      for (const id of ids) {
        appendCreated(id)
        store.append({
          aggregateId: `session:${id}`, type: "session.created", version: 3, timestamp: Date.now(),
          actor: "flywheel", sessionId: id, payload: { label: 42 },
        })
      }
      await sessionMetadataCatalogFromState(await projection.replay(), reader)
      take()
      const id = ids[0]
      if (!id) throw new Error("Missing damaged session")
      appendLabelUpdated(id)
      const catalog = await sessionMetadataCatalogFromState(await projection.replay(), reader)
      expect(catalog.entries.find((entry) => entry.id === id)?.data.label).toBe("Renamed")
      const requests = take()
      return { requests: requests.length, facts: factsRead(requests) }
    }
    const few = await workPerChange(3)
    const many = await workPerChange(30)
    expect(many).toEqual(few)
    expect(many.facts).toBe(2)
  })

  test("workspace replay identifies a session recoverable from surviving aggregate facts", async () => {
    appendCreated("recoverable-1")
    appendLabelUpdated("recoverable-1")
    corruptPayload("recoverable-1", "session.label.updated")

    const state = await createSessionMetadataProjection(asAsyncEventReadSurface(store)).replay()

    expect((await recoverSessionMetadata(asAsyncEventReadSurface(store), "recoverable-1"))?.label).toBe("Chat")
    expect(state.errors["recoverable-1"]).toContain("corrupt event row")
  })
})

function appendConversationTreeCreated(conversationId: string) {
  store.append({
    aggregateId: `conversation:${conversationId}`,
    type: "chat.tree.created",
    version: 1,
    timestamp: Date.now(),
    actor: "flywheel",
    sessionId: conversationId,
    payload: { conversationId, createdAt: new Date().toISOString() },
  })
}

function appendEntries(conversationId: string, entries: readonly ChatEntryFixture[]) {
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

function messageEntry(id: string, parentId: string | null) {
  return {
    id,
    parentId,
    timestamp: new Date().toISOString(),
    kind: "message",
    message: { kind: "user", content: "x" },
  }
}

function appendProvisional(conversationId: string, entry: ChatEntryFixture) {
  store.append({
    aggregateId: `conversation:${conversationId}`,
    type: "chat.entry.provisional",
    version: 1,
    timestamp: Date.now(),
    actor: "flywheel",
    sessionId: conversationId,
    payload: { conversationId, entry },
  })
}

function appendDiscardMarker(conversationId: string, count: number) {
  store.append({
    aggregateId: `conversation:${conversationId}`,
    type: "chat.provisionals.discarded",
    version: 1,
    timestamp: Date.now(),
    actor: "flywheel",
    sessionId: conversationId,
    payload: { conversationId, count },
  })
}

function leafEntry(id: string, parentId: string | null, targetId: string | null) {
  return {
    id,
    parentId,
    timestamp: new Date().toISOString(),
    kind: "leaf",
    targetId,
  }
}

describe("conversation-projection invariants", () => {
  test("salvaged batches share the keyed accumulator and preserve gap chronology and watermark", async () => {
    const conversationId = "salvaged-fold"
    appendConversationTreeCreated(conversationId)
    appendEntries(conversationId, [messageEntry("root", null)])
    const projection = createConversationTreeProjection(asAsyncEventReadSurface(store), conversationId)
    const before = await projection.replay()
    appendEntries(conversationId, [
      { ...messageEntry("child", "root"), historicalExtra: true },
      { ...messageEntry("broken", "child"), timestamp: "invalid" },
      { ...messageEntry("assistant", "child"), message: { kind: "assistant", content: "answer" } },
    ])
    const after = await projection.replay()
    const branch = walkBranchFromLeaf(after.entriesById, after.leafId, () => { throw new Error("unexpected gap") })
    const transcript = branchVisibleTranscriptEntries(branch, after.degraded)
    expect(after).not.toBe(before)
    expect(after.entriesById).toBe(before.entriesById)
    expect(before.leafId).toBe("root")
    expect(before.assistantWatermark).toBe(-1)
    expect(after.leafId).toBe("assistant")
    expect(after.assistantWatermark).toBe(projection.getPosition())
    expect(transcript.map((entry) => entry.kind === "degraded" ? entry.sourceEntryId : entry.id)).toEqual(["root", "child", "broken", "assistant"])
    expect(after.degraded.materialize()[0]).toMatchObject({ ordinal: 1, anchorLeafId: "child", block: { failureClass: "decode_failure" } })
    expect(after.entriesById.broken).toBeUndefined()
  })

  test("degraded records reach the transcript in fold order without a sort", async () => {
    const conversationId = "degraded-order"
    appendConversationTreeCreated(conversationId)
    appendEntries(conversationId, [
      messageEntry("root", null),
      { ...messageEntry("broken-first", "root"), timestamp: "invalid" },
      { ...messageEntry("broken-second", "root"), timestamp: "invalid" },
    ])
    store.append({
      aggregateId: `conversation:${conversationId}`, type: "chat.entries.appended", version: 999,
      timestamp: Date.now(), actor: "flywheel", sessionId: conversationId, payload: { unreadable: true },
    })
    const state = await createConversationTreeProjection(asAsyncEventReadSurface(store), conversationId).replay()
    const branch = walkBranchFromLeaf(state.entriesById, state.leafId, () => { throw new Error("unexpected gap") })
    const transcript = branchVisibleTranscriptEntries(branch, state.degraded)
    expect(transcript.map((entry) => entry.kind === "degraded" ? [entry.event.position, entry.ordinal] : entry.id)).toEqual([
      "root", [expect.any(Number), 1], [expect.any(Number), 2], [expect.any(Number), expect.any(Number)],
    ])
    const positions = transcript.flatMap((entry) => entry.kind === "degraded" ? [entry.event.position] : [])
    expect(positions[0]).toBe(positions[1])
    expect(positions[2]).toBeGreaterThan(positions[1] ?? Infinity)
  })

  test("a late tool identity violation publishes neither entries nor degraded records", async () => {
    const conversationId = "atomic-fold"
    appendConversationTreeCreated(conversationId)
    appendEntries(conversationId, [messageEntry("root", null)])
    const projection = createConversationTreeProjection(asAsyncEventReadSurface(store), conversationId)
    const before = await projection.replay()
    const position = projection.getPosition()
    const event = store.append({
      aggregateId: `conversation:${conversationId}`, sessionId: conversationId,
      type: "chat.entries.appended", version: 1, actor: "flywheel", timestamp: 1,
      payload: {
        conversationId,
        entries: [
          messageEntry("orphan", "missing"),
          { ...messageEntry("assistant", "root"), message: { kind: "assistant", content: [{ type: "tool_use", id: "expected", name: "read", input: {} }] } },
          { ...messageEntry("result", "assistant"), message: { kind: "toolResult", toolUseId: "wrong", content: [{ type: "text", text: "result" }] } },
        ],
      },
    })
    await expect(projection.apply(event)).rejects.toThrow(/conflicts with preceding tool identity/)
    expect(projection.getState()).toBe(before)
    expect(projection.getPosition()).toBe(position)
    expect(Object.keys(before.entriesById)).toEqual(["root"])
    expect(before.leafId).toBe("root")
    expect(before.assistantWatermark).toBe(-1)
    expect(before.degraded.length).toBe(0)
  })

  test("chat_tree invalid JSON degrades without blocking transcript replay", async () => {
    const sessionId = "tree-invalid-json"
    appendConversationTreeCreated(sessionId)
    corruptPayload(sessionId, "chat.tree.created")

    const state = await createConversationTreeProjection(asAsyncEventReadSurface(store), sessionId).replay()
    expect(state.created).toBe(false)
    expect(state.degraded.materialize()).toEqual([
      expect.objectContaining({ block: expect.objectContaining({ failureClass: "decode_failure" }) }),
    ])
  })

  test("duplicate chat.tree.created degrades the offending fact without replacing identity", async () => {
    const sessionId = "tree-dup"
    appendConversationTreeCreated(sessionId)
    appendConversationTreeCreated(sessionId)

    const state = await createConversationTreeProjection(asAsyncEventReadSurface(store), sessionId).replay()
    expect(state.created).toBe(true)
    expect(state.conversationId).toBe(sessionId)
    expect(state.degraded.length).toBe(1)
    expect(state.degraded.materialize()[0]?.block.failureClass).toBe("structural_violation")
  })

  test("chat_tree mutation-before-creation strict-projection throws missing-producer-event", async () => {
    const sessionId = "tree-no-create"
    appendEntries(sessionId, [leafEntry("e1", null, null)])

    let caught: unknown
    try {
      await createConversationTreeProjection(asAsyncEventReadSurface(store), sessionId).replay()
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(InvariantViolation)
    if (!(caught instanceof InvariantViolation)) throw new Error("expected a typed projection error")
    expect(caught.kind).toBe("missing-producer-event")
  })

  test("entry referencing a missing parent degrades without changing topology", async () => {
    const sessionId = "tree-missing-parent"
    appendConversationTreeCreated(sessionId)
    appendEntries(sessionId, [leafEntry("child-1", "ghost-parent", null)])

    const state = await createConversationTreeProjection(asAsyncEventReadSurface(store), sessionId).replay()

    expect(state.entriesById).toEqual({})
    expect(state.leafId).toBeNull()
    expect(state.degraded.length).toBe(1)
    expect(state.degraded.materialize()[0]?.sourceParentId).toBe("ghost-parent")
    expect(state.degraded.materialize()[0]?.block.failureClass).toBe("structural_violation")
  })

  test("a store written before turn fragments were retired still opens, ignoring them", async () => {
    // The whole compatibility story for retiring a fact family: the fold
    // selects by type, so an unlisted type is never read. No adapter, no
    // version fence, no migration - a conversation written by the old writer
    // opens as the committed turns it always was.
    const sessionId = "tree-historical-fragments"
    appendConversationTreeCreated(sessionId)
    appendEntries(sessionId, [messageEntry("committed-1", null)])
    appendProvisional(sessionId, messageEntry("frag-1", "committed-1"))
    appendProvisional(sessionId, messageEntry("frag-2", "frag-1"))
    // Even a fragment that never chained, which the old fold logged and dropped.
    appendProvisional(sessionId, messageEntry("frag-orphan", "never-written"))
    appendDiscardMarker(sessionId, 3)
    appendEntries(sessionId, [messageEntry("committed-2", "committed-1")])

    const state = await createConversationTreeProjection(asAsyncEventReadSurface(store), sessionId).replay()

    expect(state.leafId).toBe("committed-2")
    expect(Object.keys(state.entriesById).sort()).toEqual(["committed-1", "committed-2"])
    expect(state.degraded.length).toBe(0)
  })

  test("duplicate entry id degrades the offending member and keeps later siblings readable", async () => {
    const sessionId = "tree-dup-entry"
    appendConversationTreeCreated(sessionId)
    appendEntries(sessionId, [messageEntry("e1", null)])
    appendEntries(sessionId, [messageEntry("e1", null), messageEntry("e2", "e1")])

    const state = await createConversationTreeProjection(asAsyncEventReadSurface(store), sessionId).replay()
    expect(Object.keys(state.entriesById)).toEqual(["e1", "e2"])
    expect(state.leafId).toBe("e2")
    expect(state.degraded.materialize().map((record) => record.sourceEntryId)).toEqual(["e1"])
  })

  test("degraded replay appends into one projection-owned sequence", async () => {
    const sessionId = "tree-degraded-sequence"
    appendConversationTreeCreated(sessionId)
    const projection = createConversationTreeProjection(asAsyncEventReadSurface(store), sessionId)
    await projection.replay()
    const sequence = projection.getState().degraded
    appendEntries(sessionId, [leafEntry("first", "missing", null)])
    await projection.replay()
    appendEntries(sessionId, [leafEntry("second", "missing", null)])
    const state = await projection.replay()

    expect(state.degraded).toBe(sequence)
    expect(state.degraded.materialize().map((record) => record.sourceEntryId)).toEqual(["first", "second"])
  })
})

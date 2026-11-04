import assert from "node:assert/strict"
import { test } from "node:test"
import { jest } from "bun:test"

import type { ChildSessionRow, FrontendEvent, FrontendOutputBlock, RuntimeQuery, SessionCatalogRow } from "../../../src/protocol/app-service-types.js"
import { blockIdentity } from "../../../src/protocol/block-identity.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import type { MutationEvidenceReader, MutationFilesView } from "../../../src/protocol/client/mutation-evidence.js"
import { outputCursor } from "../../../src/protocol/output-protocol-types.js"
import { fakeLanes, LANE_BREAK } from "../../../tests/helpers/fake-lanes.js"
import { createRuntimeSession } from "./session.js"
import { fakeRuntimeConnection } from "./runtime-connection-fixture.js"
import { detailView, tailWindow } from "../../../tests/helpers/runtime-views.js"
import { recordedQuery, runtimeDispatch, runtimeQuery } from "../../../tests/helpers/runtime-dispatch.js"

type MutationEvidenceEntry = MutationFilesView["files"][number]
type SessionContentManifestReference = Parameters<MutationEvidenceReader["open"]>[1]

/** A page keeps its recently shown sessions resident: a return shows what
 *  it kept at once and reads nothing, and the page holds the root chat of
 *  each resident session (PI-REMOTE-008). */

const chatRow = (id: string, lifecycleState: "active" | "inactive" = "active"): SessionCatalogRow => ({
  id, kind: "chat", title: id, shortTitle: id, lifecycleState, activity: "idle", inputMode: { kind: "chat" },
  createdAt: "2026-01-01T00:00:00.000Z", lastUpdated: "2026-01-01T00:00:00.000Z", notices: [], executionCwd: "/project", totalsLoading: true,
})

const text = (id: string): FrontendOutputBlock => ({ kind: "text", id, content: id, timestamp: 0 })

interface Read { readonly type: string; readonly sessionId?: string }

/** A runtime with `count` live chats whose lanes and output the test controls. */
function residentConnection(count: number, bodyBytes = BODY_BYTES) {
  const listeners = new Set<(event: FrontendEvent) => void>()
  const lanes = fakeLanes()
  const reads: Read[] = []
  const claims: string[] = []
  const rows = Array.from({ length: count }, (_, index) => chatRow(`chat-${index}`))
  /** A subagent of the first chat, which only its detail serves. */
  const child: ChildSessionRow = {
    id: "child", kind: "subagent", title: "child", shortTitle: "child", lifecycleState: "active", activity: "idle", inputMode: { kind: "message" },
    admittedActions: ["session.send"], createdAt: "2026-01-01T00:00:00.000Z", lastUpdated: "2026-01-01T00:00:00.000Z", parentSessionId: "chat-0",
    notices: [], executionCwd: "/project", totalsLoading: true,
  }
  const tails = new Map<string, FrontendOutputBlock[]>([...rows, child].map((row) => [row.id, [text(`${row.id}-1`)]]))
  /** Window reads that wait for the test, by session. */
  const heldWindows = new Map<string, PromiseWithResolvers<void>>()
  /** How many of each session's next window reads fail. */
  const failingWindows = new Map<string, number>()
  let position = 10
  const base = fakeRuntimeConnection()
  const record = (request: RuntimeQuery) => {
    const sessionId = "sessionId" in request ? request.sessionId : "sessionIds" in request ? request.sessionIds[0] : undefined
    reads.push({ type: request.type, ...(sessionId === undefined ? {} : { sessionId }) })
  }
  const views = async () => ({ snapshotPosition: 0, views: [] })
  const answer = runtimeQuery({
    snapshot: async () => ({ rows, activeRuntimeCount: rows.length, errors: [], snapshotPosition: 0, projectRoot: "/project", runtimeVersion: "test", runtimeBuildId: null, chatDefault: { kind: "none" }, executor: { kind: "serving" }, service: { kind: "serving" } }),
    sessionDetailSnapshot: async (request) => ({ snapshotPosition: 0, views: request.sessionIds.map((id) => {
      const row = [...rows, child].find((candidate) => candidate.id === id)
      return { sessionId: id, view: row === undefined ? null : detailView(row) }
    }) }),
    outputWindow: async (request) => {
      await heldWindows.get(request.sessionId)?.promise
      const failures = failingWindows.get(request.sessionId) ?? 0
      if (failures > 0) {
        failingWindows.set(request.sessionId, failures - 1)
        throw new Error("the window read failed")
      }
      return tailWindow([...tails.get(request.sessionId) ?? []], { snapshotPosition: position })
    },
    outputBlockBody: async (request) => ({ blockId: request.request.blockId, content: "x".repeat(bodyBytes) }),
    mutationFiles: async (request) => ({
      kind: "available", sessionId: request.sessionId, manifest: request.manifest, requestedOffset: request.offset, offset: request.offset,
      totalFiles: evidenceManifest.entries, totalBytes: evidenceManifest.bytes, files: evidenceFiles, nextOffset: null,
    }),
    modelAssignments: async () => [{ slot: { kind: "role", roleId: "chat" }, label: "Chat", model: "model-a", effort: "high", modelSource: "default", matchesInheritedPair: true }],
    roleSnapshot: async (request) => ({ snapshotPosition: 0, views: request.sessionIds.map((id) => ({ sessionId: id, view: { assignments: {}, serving: { slot: { kind: "role", roleId: "chat" }, selection: { model: "model-a", effort: "high" } } } })) }),
    effortOptions: async () => [],
    commandCatalog: async () => ({ revision: 1, builtInCommands: [], offCommands: [], snapshotPosition: 0 }),
    statusSnapshot: views, budgetSnapshot: views, questionSnapshot: views,
  }, base.query)
  const query = recordedQuery(record, answer)
  /** Records each session activation and release it acknowledges. */
  const claim = async (command: { readonly type: string; readonly sessionId: string }) => {
    claims.push(`${command.type} ${command.sessionId}`)
    return { ok: true as const }
  }
  const acknowledge = async () => ({ ok: true as const })
  const dispatch = runtimeDispatch({ "session.activate": claim, "session.release": claim, "session_detail.release": acknowledge, "session.send": acknowledge })
  const connection: RuntimeConnection = {
    ...base,
    ...lanes.client,
    query,
    dispatch,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const emit = (event: FrontendEvent) => { for (const listener of Array.from(listeners)) listener(event) }
  return {
    connection,
    reads,
    /** Reads made since `from`, as `type sessionId`. */
    readsSince: (from: number) => reads.slice(from).map((read) => `${read.type}${read.sessionId === undefined ? "" : ` ${read.sessionId}`}`),
    /** The session activations and releases dispatched, as `type sessionId`. */
    claims: () => [...claims],
    failWindows(sessionId: string, times: number) { failingWindows.set(sessionId, times) },
    holdWindow(sessionId: string) {
      const gate = Promise.withResolvers<void>()
      heldWindows.set(sessionId, gate)
      return () => { heldWindows.delete(sessionId); gate.resolve() }
    },
    /** The runtime appends `block` to the session's transcript and publishes it. */
    append(sessionId: string, block: FrontendOutputBlock) {
      const blocks = tails.get(sessionId) ?? []
      blocks.push(block)
      tails.set(sessionId, blocks)
      position += 1
      emit({ type: "patch", patch: {
        cursor: outputCursor(sessionId), position, prevPosition: position - 1,
        payload: { kind: "output.delta", delta: { visibleMessageCount: blocks.length, blocks: [{ kind: "insert", index: blocks.length - 1, blockId: blockIdentity(block), block }] } },
      } })
    },
    /** The runtime pauses the chat, as a recovery or another client's close
     *  does: its catalog row turns inactive. */
    paused(sessionId: string) {
      const row = chatRow(sessionId, "inactive")
      rows[rows.findIndex((candidate) => candidate.id === sessionId)] = row
      emit({ type: "patch", patch: { cursor: { scope: "session", domain: "session", sessionId }, position: 1, prevPosition: 0, payload: { kind: "session.updated", row } } })
    },
    /** Another client deletes the chat: its catalog row leaves. */
    removedElsewhere(sessionId: string) {
      rows.splice(rows.findIndex((row) => row.id === sessionId), 1)
      emit({ type: "patch", patch: { cursor: { scope: "session", domain: "session", sessionId }, position: 1, prevPosition: 0, payload: { kind: "session.removed" } } })
    },
    breakLane() { lanes.end(); emit(LANE_BREAK) },
    openLane() { lanes.open() },
  }
}

const settle = () => new Promise<void>((resolve) => { setImmediate(resolve) })
/** One opened body: three of them pass the residents' shared body budget. */
const BODY_BYTES = 6 * 1024 * 1024
const evidenceFiles: readonly MutationEvidenceEntry[] = [
  { kind: "not_applied", path: "a.ts", reason: "conflict" },
  { kind: "not_applied", path: "b.ts", reason: "conflict" },
]
const evidenceManifest: SessionContentManifestReference = {
  version: 1, root: "a".repeat(64), entries: evidenceFiles.length, bytes: Buffer.byteLength(evidenceFiles.map(file => JSON.stringify(file)).join("")),
}
/** Model large payloads at the accounting seam. The real reader still owns
 * publications, retained metadata, and release. */
function modelEvidenceBytes(reader: MutationEvidenceReader, bytes: number): void {
  const held = Object.getOwnPropertyDescriptor(reader, "heldBytes")?.get
  assert.ok(held)
  Object.defineProperty(reader, "heldBytes", { get: () => held.call(reader) === 0 ? 0 : bytes })
}
const blockIds = (session: ReturnType<typeof createRuntimeSession>) => session.transcript?.view.blocks.map((block) => block.kind === "question" ? block.toolUseId : block.id) ?? []

test("a return to a resident session shows its kept window and seat in the tap and reads nothing", async () => {
  const fake = residentConnection(3)
  const session = createRuntimeSession({ connection: fake.connection })
  try {
    await settle()
    assert.equal(session.sessionId, "chat-0")
    await session.select("chat-1")
    await settle()
    const from = fake.reads.length
    const claims = fake.claims().length

    void session.select("chat-0")
    assert.equal(session.transcript?.status, "ready")
    assert.deepEqual(blockIds(session), ["chat-0-1"])
    assert.deepEqual(session.activeModel, { model: "model-a", effort: "high" })
    await settle()
    assert.deepEqual(fake.readsSince(from), [])
    assert.equal(fake.claims().length, claims, "the runner of a resident session is already held")
  } finally { session.dispose() }
})

test("a return to a resident whose recovery failed keeps its window and memory on screen and reads it again", async () => {
  const fake = residentConnection(2)
  const session = createRuntimeSession({ connection: fake.connection })
  try {
    await settle()
    const transcript = session.transcript
    const memory = session.memory("chat-0")
    assert.ok(transcript !== undefined && memory !== undefined)
    fake.failWindows("chat-0", 4)
    jest.useFakeTimers()
    const recovering = transcript.refresh()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await settle()
      jest.advanceTimersByTime(4_000)
    }
    await recovering
    jest.useRealTimers()
    assert.equal(transcript.status, "recovery-failed")
    await session.select("chat-1")
    await settle()
    const release = fake.holdWindow("chat-0")
    const from = fake.reads.length

    void session.select("chat-0")
    await settle()
    assert.deepEqual(fake.readsSince(from).filter((read) => read.startsWith("outputWindow")), ["outputWindow chat-0"])
    assert.equal(session.transcript, transcript, "the resident stays")
    assert.equal(session.memory("chat-0"), memory)
    assert.deepEqual(blockIds(session), ["chat-0-1"])
    release()
    await settle()
    assert.equal(transcript.status, "ready")
    assert.deepEqual(blockIds(session), ["chat-0-1"])
  } finally { jest.useRealTimers(); session.dispose() }
})

test("a hidden resident applies its output while hidden, so a return shows it without a read", async () => {
  const fake = residentConnection(2)
  const session = createRuntimeSession({ connection: fake.connection })
  try {
    await settle()
    await session.select("chat-1")
    await settle()
    fake.append("chat-0", text("chat-0-2"))
    const from = fake.reads.length
    void session.select("chat-0")
    assert.deepEqual(blockIds(session), ["chat-0-1", "chat-0-2"])
    await settle()
    assert.deepEqual(fake.readsSince(from).filter((read) => read.startsWith("outputWindow")), [])
  } finally { session.dispose() }
})

test("the page holds the root chat of each of its eight most recently shown sessions and releases only the one that leaves", async () => {
  const fake = residentConnection(10)
  const session = createRuntimeSession({ connection: fake.connection })
  try {
    await settle()
    for (let index = 1; index <= 8; index += 1) {
      await session.select(`chat-${index}`)
      await settle()
    }
    assert.deepEqual(fake.claims(), [
      ...Array.from({ length: 8 }, (_, index) => `session.activate chat-${index}`),
      "session.release chat-0",
      "session.activate chat-8",
    ])
    // The session that left the set kept nothing: a return reads it again.
    const from = fake.reads.length
    await session.select("chat-0")
    await settle()
    assert.ok(fake.readsSince(from).includes("outputWindow chat-0"))
    assert.ok(fake.claims().includes("session.release chat-1"))
  } finally { session.dispose() }
})

test("after a lane break only the shown session reads and activates, and a dormant resident shown later paints its kept window, activates, and then reads", async () => {
  const fake = residentConnection(2)
  const session = createRuntimeSession({ connection: fake.connection })
  try {
    await settle()
    await session.select("chat-1")
    await settle()
    fake.breakLane()
    await settle()
    const from = fake.reads.length
    const claimsFrom = fake.claims().length
    const release = fake.holdWindow("chat-1")
    fake.openLane()
    await settle()
    assert.deepEqual(fake.readsSince(from).filter((read) => read.startsWith("outputWindow")), ["outputWindow chat-1"])
    assert.deepEqual(fake.claims().slice(claimsFrom), ["session.activate chat-1"])
    release()
    await settle()
    assert.deepEqual(fake.claims().slice(claimsFrom), ["session.activate chat-1"], "a dormant resident holds no runner")
    assert.deepEqual(fake.readsSince(from).filter((read) => read.startsWith("sessionDetailSnapshot")), ["sessionDetailSnapshot chat-1"], "a dormant resident reads no detail")

    fake.append("chat-0", text("chat-0-2"))
    void session.select("chat-0")
    assert.deepEqual(blockIds(session), ["chat-0-1"], "a dormant resident paints what it kept")
    assert.deepEqual(fake.claims().slice(claimsFrom), ["session.activate chat-1", "session.activate chat-0"])
    await settle()
    assert.deepEqual(fake.readsSince(from).filter((read) => read.startsWith("outputWindow")), ["outputWindow chat-1", "outputWindow chat-0"])
    assert.deepEqual(blockIds(session), ["chat-0-1", "chat-0-2"])
    assert.ok(!fake.claims().includes("session.release chat-1"), "a resident hidden on an open lane keeps its runner")
  } finally { session.dispose() }
})

test("a message the runtime adopts while its session is hidden leaves the page's local entries", async () => {
  const fake = residentConnection(2)
  const session = createRuntimeSession({ connection: fake.connection })
  try {
    await settle()
    await session.send("also update docs")
    const [entry] = session.localSubmissions
    assert.ok(entry)
    await session.select("chat-1")
    await settle()
    fake.append("chat-0", { kind: "userMessage", id: "message", content: "also update docs", timestamp: 0, pending: false, injected: false, submissionIds: [entry.id] })
    await session.select("chat-0")
    assert.deepEqual(session.localSubmissions, [])
  } finally { session.dispose() }
})

test("a hidden resident whose chat is closed elsewhere keeps what it held and its hold on the lane, is not opened again on the next lane, and opens again when shown; one deleted elsewhere leaves and is released", async () => {
  const fake = residentConnection(3)
  const session = createRuntimeSession({ connection: fake.connection })
  try {
    await settle()
    session.onLeave((sessionId, memory) => { memory.draft = { text: `draft for ${sessionId}` } })
    await session.select("chat-1")
    await session.select("chat-2")
    await settle()
    // An executor recovery pauses every live chat, and a close elsewhere
    // looks the same in the catalog; neither may drop what the page kept.
    fake.paused("chat-0")
    fake.removedElsewhere("chat-1")
    await settle()
    assert.deepEqual(fake.claims().filter((claim) => claim.startsWith("session.release")), ["session.release chat-1"])
    assert.equal(session.memory("chat-0")?.draft?.text, "draft for chat-0")
    assert.equal(session.memory("chat-1"), undefined)
    fake.breakLane()
    const claimsFrom = fake.claims().length
    fake.openLane()
    await settle()
    assert.deepEqual(fake.claims().slice(claimsFrom), ["session.activate chat-2"], "a chat closed elsewhere is not opened again behind the person")
    await session.select("chat-0")
    await settle()
    assert.deepEqual(fake.claims().slice(claimsFrom), ["session.activate chat-2", "session.activate chat-0"])
    assert.equal(session.memory("chat-0")?.draft?.text, "draft for chat-0")
  } finally { session.dispose() }
})

test("on an open lane, a hidden resident closed elsewhere stays closed until it is shown, and showing it opens it again", async () => {
  const fake = residentConnection(3)
  const session = createRuntimeSession({ connection: fake.connection })
  try {
    await settle()
    await session.select("chat-1")
    await session.select("chat-2")
    await settle()
    const claimsFrom = fake.claims().length
    fake.paused("chat-0")
    await settle()
    assert.deepEqual(fake.claims().slice(claimsFrom), [], "a hidden resident is not opened again behind the person")

    await session.select("chat-0")
    await settle()
    assert.deepEqual(fake.claims().slice(claimsFrom), ["session.activate chat-0"])
    await session.select("chat-1")
    await settle()
    assert.deepEqual(fake.claims().slice(claimsFrom), ["session.activate chat-0"], "a return to a live resident asks for nothing")
  } finally { session.dispose() }
})

test("a dormant subagent resident stays resident across a lane break, and a return paints what it kept and holds its root again", async () => {
  const fake = residentConnection(2)
  const session = createRuntimeSession({ connection: fake.connection })
  try {
    await settle()
    await session.select("child")
    await settle()
    assert.deepEqual(blockIds(session), ["child-1"])
    await session.select("chat-1")
    await settle()
    fake.breakLane()
    const claimsFrom = fake.claims().length
    fake.openLane()
    await settle()
    assert.deepEqual(fake.claims().slice(claimsFrom), ["session.activate chat-1"])

    void session.select("child")
    assert.equal(session.transcript?.status, "ready")
    assert.deepEqual(blockIds(session), ["child-1"], "a dormant subagent paints what it kept")
    await settle()
    assert.deepEqual(fake.claims().slice(claimsFrom), ["session.activate chat-1", "session.activate chat-0"])
  } finally { session.dispose() }
})

test("opened bodies past the residents' budget leave the least recently shown hidden session first, and the shown one keeps its own", async () => {
  const fake = residentConnection(3)
  const session = createRuntimeSession({ connection: fake.connection })
  const opened = (blockId: string) => session.transcript?.view.bodies[blockId] !== undefined
  try {
    await settle()
    for (const id of ["chat-0", "chat-1", "chat-2"]) {
      await session.select(id)
      await settle()
      await session.transcript?.hydrateBody(`${id}-1`)
      assert.ok(opened(`${id}-1`))
    }
    await session.select("chat-1")
    assert.ok(opened("chat-1-1"))
    await session.select("chat-0")
    assert.equal(opened("chat-0-1"), false, "the oldest hidden session dropped its body")
  } finally { session.dispose() }
})

test("evidence publications share the body budget and evict the oldest hidden resident even with small bodies", async () => {
  const fake = residentConnection(3, 16)
  const session = createRuntimeSession({ connection: fake.connection })
  try {
    await settle()
    const held = []
    for (const id of ["chat-0", "chat-1", "chat-2"]) {
      await session.select(id)
      await settle()
      const transcript = session.transcript!
      await transcript.hydrateBody(`${id}-1`)
      const reader = transcript.mutationEvidence
      modelEvidenceBytes(reader, 6 * 1024 * 1024)
      const handle = reader.open(`${id}-1`, evidenceManifest)
      await handle.loadFiles()
      held.push({ transcript, handle })
    }
    assert.deepEqual(held[0]!.handle.files.files, [], "the oldest hidden evidence was released")
    assert.deepEqual(held[0]!.transcript.view.bodies, {}, "the same owner releases ordinary bodies")
    assert.equal(held[0]!.transcript.mutationEvidence.heldBytes, 0)
    for (const resident of held.slice(1)) {
      assert.deepEqual(resident.handle.files.files, evidenceFiles)
      assert.equal(Object.keys(resident.transcript.view.bodies).length, 1)
    }
    await session.select("chat-0")
    assert.equal(session.transcript, held[0]!.transcript, "body trimming does not evict the session")
  } finally { session.dispose() }
})

test("a shown session keeps oversized evidence while a hidden evidence publication is released", async () => {
  const fake = residentConnection(2, 16)
  const session = createRuntimeSession({ connection: fake.connection })
  try {
    await settle()
    const hidden = session.transcript!
    await session.select("chat-1")
    await settle()
    const shown = session.transcript!
    modelEvidenceBytes(shown.mutationEvidence, 20 * 1024 * 1024)
    const visibleFiles = shown.mutationEvidence.open("chat-1-1", evidenceManifest)
    await visibleFiles.loadFiles()
    assert.deepEqual(visibleFiles.files.files, evidenceFiles)
    const hiddenFiles = hidden.mutationEvidence.open("chat-0-1", evidenceManifest)
    await hiddenFiles.loadFiles()
    assert.deepEqual(hiddenFiles.files.files, [])
    assert.equal(hidden.mutationEvidence.heldBytes, 0)
    assert.deepEqual(visibleFiles.files.files, evidenceFiles)
    assert.equal(session.transcript, shown)
  } finally { session.dispose() }
})

test("an ordinary body publication accounts for hidden evidence in the shared budget", async () => {
  const fake = residentConnection(2, 1024)
  const session = createRuntimeSession({ connection: fake.connection })
  try {
    await settle()
    const hidden = session.transcript!
    modelEvidenceBytes(hidden.mutationEvidence, 16 * 1024 * 1024 - 512)
    const files = hidden.mutationEvidence.open("chat-0-1", evidenceManifest)
    await files.loadFiles()
    assert.deepEqual(files.files.files, evidenceFiles)
    await session.select("chat-1")
    await settle()
    const shown = session.transcript!
    await shown.hydrateBody("chat-1-1")
    assert.deepEqual(files.files.files, [])
    assert.equal(hidden.mutationEvidence.heldBytes, 0)
    assert.ok(shown.view.bodies["chat-1-1"])
  } finally { session.dispose() }
})

test("a switch reads no workspace value again", async () => {
  const fake = residentConnection(2)
  const session = createRuntimeSession({ connection: fake.connection })
  try {
    await settle()
    const from = fake.reads.length
    await session.select("chat-1")
    await settle()
    const workspace = new Set(["moduleSnapshot", "configSnapshot", "authStatusSnapshot", "snapshot", "commandCatalog"])
    assert.deepEqual(fake.readsSince(from).filter((read) => workspace.has(read)), [])
    assert.equal(fake.readsSince(from).filter((read) => read.startsWith("roleSnapshot")).length, 1, "one seat read names the model and the panel's seat")
  } finally { session.dispose() }
})

test("a move off a shown session asks the surfaces for their state while the pane still shows it, and the return finds it", async () => {
  const fake = residentConnection(2)
  const session = createRuntimeSession({ connection: fake.connection })
  try {
    await settle()
    const left: string[] = []
    session.onLeave((sessionId, memory) => {
      left.push(`${sessionId} while showing ${session.sessionId}`)
      memory.draft = { text: `draft for ${sessionId}` }
    })
    await session.select("chat-1")
    assert.deepEqual(left, ["chat-0 while showing chat-0"])
    assert.deepEqual(session.memory("chat-0")?.draft, { text: "draft for chat-0" })
    assert.equal(session.memory("chat-1")?.draft, undefined)
    assert.equal(session.memory("never-shown"), undefined)
  } finally { session.dispose() }
})

import { Database } from "bun:sqlite"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createUnreadChatsProjection, type UnreadChatsProjectionDeps } from "../../../../../src/orchestration/app-service/projections/unread-chats-projection.js"
import { parseSessionFact } from "../../../../../src/orchestration/session/persistence/session-fact-registry.js"
import type { ChatReadRecordedFact } from "../../../../../src/orchestration/session/persistence/chat-read-receipt-facts.js"
import { parseProjectionFact } from "../../../../../src/infra/substrate/projection/event-projection.js"
import { turnEndEntryId } from "../../../../../src/orchestration/session/conversation/turn-end-record.js"
import { chatEntriesFacts } from "../../../../../src/orchestration/session/conversation/conversation-facts.js"
import type { ConversationEntry } from "../../../../../src/orchestration/session/conversation/conversation-entry-types.js"
import { createSqliteEventStore } from "../../../../../src/infra/substrate/store/sqlite-event-store.js"
import { Log } from "../../../../../src/infra/diagnostics/log.js"
import { asAsyncEventReadSurface, type LocalSqliteEventStore, type StoredFact } from "../../../../../src/infra/substrate/store/event-store-types.js"
import type { RuntimeUiPatchInput } from "../../../../../src/protocol/runtime/runtime-ui-protocol-types.js"
import type { ChatTurnEnding } from "../../../../../src/protocol/session/chat-settlement-protocol-types.js"
import { countStateRequests } from "../../../../helpers/state-requests.js"

const opened: Array<{ readonly store: LocalSqliteEventStore; readonly directory: string }> = []

afterEach(() => {
  for (const { store, directory } of opened.splice(0)) {
    try {
      store.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

function openStore() {
  const directory = mkdtempSync(join(tmpdir(), "flywheel-unread-chats-"))
  const path = join(directory, "flywheel.sqlite")
  const store = createSqliteEventStore(path)
  opened.push({ store, directory })
  return { store, path }
}

let clock = 1_000

function sessionFact(store: LocalSqliteEventStore, sessionId: string, type: string, payload: { readonly [field: string]: unknown }): StoredFact {
  return store.append({ aggregateId: `session:${sessionId}`, sessionId, type, version: 1, actor: "flywheel", timestamp: clock++, payload })
}

const started = (store: LocalSqliteEventStore, sessionId: string) => sessionFact(store, sessionId, "chat.turn.started", { conversationId: `conv-${sessionId}` })

function stopped(store: LocalSqliteEventStore, sessionId: string, answer?: { readonly entryId: string; readonly firstLine: string }, ending: ChatTurnEnding = { kind: "completed" }): StoredFact {
  return sessionFact(store, sessionId, "chat.turn.stopped", { conversationId: `conv-${sessionId}`, ending, ...(answer ? { finalEntryId: answer.entryId, firstLine: answer.firstLine } : {}) })
}

let entryCount = 0
/** One entry batch of the chat's conversation: an assistant answer, or the
 *  entry that `kind` names: a compaction, or the record of the person's
 *  interrupt. */
function appended(store: LocalSqliteEventStore, sessionId: string, kind: "assistant" | "compaction" | "cut" = "assistant"): StoredFact & { readonly entryId: string } {
  const timestamp = "2026-11-26T00:00:00.000Z"
  const entryId = kind === "cut" ? turnEndEntryId({ reason: "paused", pausedBy: "person" }, `cut-${++entryCount}`) : `entry-${++entryCount}`
  const entry: ConversationEntry = kind === "assistant"
    ? { kind: "message", id: entryId, parentId: null, timestamp, message: { kind: "assistant", content: [{ type: "text", text: "Working." }] } }
    : kind === "cut"
      ? { kind: "message", id: entryId, parentId: null, timestamp, displayOnly: true, message: { kind: "system", content: "Interrupted." } }
      : { kind: "compaction", id: entryId, parentId: null, timestamp, mode: "reset", sourceLeafId: "entry-0", tokensBefore: 10, tokensAfter: 5 }
  const [fact] = chatEntriesFacts(`conv-${sessionId}`, [entry])
  return { ...store.append({ ...fact, aggregateId: `conversation:conv-${sessionId}`, sessionId, timestamp: clock++ }), entryId }
}

function receipts(store: LocalSqliteEventStore, sessionId?: string) {
  return store.read({ types: ["chat.read.recorded"], ...(sessionId ? { aggregateId: `session:${sessionId}` } : {}) }).map((fact) => ({ sessionId: fact.sessionId, ...parseProjectionFact(fact, parseSessionFact<ChatReadRecordedFact>).payload }))
}

/** A client connection, by identity. */
interface Connection { readonly connection?: never }
type Projection = ReturnType<typeof createUnreadChatsProjection<Connection>>
const presence = (projection: Projection, connection: Connection, sessionId: string | undefined) => projection.dispatch({ type: "chat.presence", ...(sessionId === undefined ? {} : { sessionId }) }, connection)
const mark = (projection: Projection, sessionId: string, read: boolean) => projection.dispatch({ type: read ? "chat.mark_read" : "chat.mark_unread", sessionId }, undefined)

function project(store: LocalSqliteEventStore, reader: UnreadChatsProjectionDeps["reader"] = asAsyncEventReadSurface(store), writer: UnreadChatsProjectionDeps["writer"] = { append: async (event) => store.append(event) }) {
  const patches: RuntimeUiPatchInput[] = []
  const projection = createUnreadChatsProjection<Connection>({
    reader, writer, onStored: store.onStored,
    bus: { publish: (patch) => { patches.push(patch) }, snapshotPosition: () => 0 },
  })
  const view = async () => {
    const { snapshotPosition: _position, ...rest } = await projection.snapshot()
    return rest
  }
  const stoppedIds = async () => (await view()).stopped.map((chat) => chat.sessionId)
  return { projection, patches, view, stoppedIds }
}

const ANSWER = { entryId: "answer-1", firstLine: "All done." }

describe("unread chats projection", () => {
  test("a chat that stops with no one at it is listed with its ending, first line, and stop time, newest first; a start takes it out", async () => {
    const { store } = openStore()
    started(store, "older")
    const olderStop = stopped(store, "older", undefined, { kind: "failed", failure: "api_error" })
    started(store, "chat")
    const { projection, view } = project(store)
    expect(await view()).toEqual({ stopped: [{ sessionId: "older", ending: { kind: "failed", failure: "api_error" }, stoppedAt: olderStop.timestamp, stopKey: `stop:${olderStop.position}` }], unread: [] })

    const stop = stopped(store, "chat", ANSWER)
    expect((await view()).stopped[0]).toEqual({ sessionId: "chat", ending: { kind: "completed" }, firstLine: "All done.", stoppedAt: stop.timestamp, stopKey: "answer-1" })
    expect((await view()).stopped.map((chat) => chat.sessionId)).toEqual(["chat", "older"])

    started(store, "chat")
    expect(await view()).toEqual({ stopped: [expect.objectContaining({ sessionId: "older" })], unread: [] })
    projection.dispose()
  })

  test("a completed stop that names no answer, or a turn with no assistant message, is never listed and cannot be marked unread", async () => {
    const { store } = openStore()
    started(store, "chat")
    stopped(store, "chat")
    started(store, "starting")
    const { projection, view } = project(store)
    expect(await view()).toEqual({ stopped: [], unread: [] })
    // The list that offered the mark hears why nothing changed.
    const refused = { ok: false, error: "This chat has no message or error to mark unread." }
    expect(await mark(projection, "chat", false)).toEqual(refused)
    expect(await mark(projection, "starting", false)).toEqual(refused)
    expect(await mark(projection, "unknown", false)).toEqual(refused)
    expect(await view()).toEqual({ stopped: [], unread: [] })
    expect(receipts(store)).toEqual([])
    projection.dispose()
  })

  test("a chat that stops while a connection is at it stays out of the view, and one receipt names its answer", async () => {
    const { store } = openStore()
    started(store, "chat")
    const { projection, view, patches } = project(store)
    await view()
    await presence(projection, {}, "chat")
    appended(store, "chat")
    stopped(store, "chat", ANSWER)
    expect(await view()).toEqual({ stopped: [], unread: [] })
    expect(receipts(store)).toEqual([{ sessionId: "chat", readThrough: expect.any(Number), finalEntryId: "answer-1", cause: "stopped_under_presence" }])
    expect(patches).toEqual([])
    projection.dispose()
  })

  test("a presence that a connection reports before any read holds for a stop that lands under it, and its receipt is recorded", async () => {
    const { store } = openStore()
    started(store, "chat")
    const { projection, view } = project(store)
    await presence(projection, {}, "chat")
    stopped(store, "chat", ANSWER)
    // The presence alone reads the set: the receipt needs no snapshot.
    for (let tick = 0; tick < 20 && receipts(store).length === 0; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(receipts(store)).toEqual([{ sessionId: "chat", readThrough: expect.any(Number), finalEntryId: "answer-1", cause: "stopped_under_presence" }])
    expect(await view()).toEqual({ stopped: [], unread: [] })
    projection.dispose()
  })

  test("the last connection that leaves a chat records one receipt when messages arrived, and none when nothing did", async () => {
    const { store } = openStore()
    started(store, "chat")
    const { projection, view, patches } = project(store)
    await view()
    const connection = {}
    await presence(projection, connection, "chat")
    const message = appended(store, "chat")
    await presence(projection, connection, undefined)
    // The receipt names the answer the person read, which the chat's stop names when its turn says nothing new.
    expect(receipts(store)).toEqual([{ sessionId: "chat", readThrough: message.position, finalEntryId: message.entryId, cause: "presence_ended" }])

    await presence(projection, connection, "chat")
    await presence(projection, connection, "other")
    await presence(projection, connection, undefined)
    expect(receipts(store)).toHaveLength(1)
    stopped(store, "chat", { entryId: message.entryId, firstLine: "Working." })
    expect(await view()).toEqual({ stopped: [], unread: [] })
    expect(patches).toEqual([])
    projection.dispose()
  })

  test("a connection at a chat makes it read for every connection until it leaves or ends", async () => {
    const { store } = openStore()
    started(store, "chat")
    stopped(store, "chat", ANSWER)
    const { projection, stoppedIds } = project(store)
    const phone = {}
    const desktop = {}
    await presence(projection, desktop, "elsewhere")
    expect(await stoppedIds()).toEqual(["chat"])
    await presence(projection, phone, "chat")
    // One view for every connection: the desktop no longer lists it either.
    expect(await stoppedIds()).toEqual([])

    projection.disconnect(phone)
    expect(await stoppedIds()).toEqual([])
    expect(receipts(store)).toEqual([{ sessionId: "chat", readThrough: expect.any(Number), finalEntryId: "answer-1", cause: "presence_ended" }])
    // Its presence ended with it: a later stop lists the chat again.
    started(store, "chat")
    stopped(store, "chat", { entryId: "answer-2", firstLine: "Next." })
    expect(await stoppedIds()).toEqual(["chat"])
    projection.dispose()
  })

  test("mark read takes a stopped chat out, mark unread returns it with the same stop, and presence reads it again", async () => {
    const { store } = openStore()
    started(store, "chat")
    stopped(store, "chat", ANSWER)
    const { projection, view } = project(store)
    const listed = (await view()).stopped
    await mark(projection, "chat", true)
    expect((await view()).stopped).toEqual([])

    await mark(projection, "chat", false)
    expect((await view()).stopped).toEqual(listed)
    const connection = {}
    await presence(projection, connection, "chat")
    expect((await view()).stopped).toEqual([])
    await presence(projection, connection, undefined)
    expect((await view()).stopped).toEqual([])
    expect(receipts(store).map((receipt) => receipt.cause)).toEqual(["marked_read", "marked_unread", "presence_ended"])
    projection.dispose()
  })

  test("marks that overlap apply in the order the person made them", async () => {
    const { store } = openStore()
    started(store, "chat")
    stopped(store, "chat", ANSWER)
    const { projection, stoppedIds } = project(store)
    await stoppedIds()
    await Promise.all([mark(projection, "chat", true), mark(projection, "chat", false)])
    expect(await stoppedIds()).toEqual(["chat"])
    expect(receipts(store).map((receipt) => receipt.cause)).toEqual(["marked_read", "marked_unread"])
    projection.dispose()
  })

  test("a stop that lands while a receipt is on its way to the store is listed, with no receipt of its own", async () => {
    const { store } = openStore()
    started(store, "chat")
    stopped(store, "chat", ANSWER)
    const writing = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const { projection, stoppedIds } = project(store, undefined, { append: async (event) => { writing.resolve(); await gate.promise; return store.append(event) } })
    await stoppedIds()
    const marking = mark(projection, "chat", true)
    await writing.promise
    started(store, "chat")
    stopped(store, "chat", { entryId: "answer-2", firstLine: "Next." })
    gate.resolve()
    await marking
    expect(await stoppedIds()).toEqual(["chat"])
    expect(receipts(store).map((receipt) => [receipt.cause, receipt.finalEntryId])).toEqual([["marked_read", "answer-1"]])
    projection.dispose()
  })

  test("a chat marked unread while a connection is at it stays unread until a connection is at it again", async () => {
    const { store } = openStore()
    started(store, "chat")
    stopped(store, "chat", ANSWER)
    const { projection, stoppedIds } = project(store)
    const connection = {}
    await presence(projection, connection, "chat")
    await mark(projection, "chat", false)
    expect(await stoppedIds()).toEqual(["chat"])
    await presence(projection, connection, "chat")
    expect(await stoppedIds()).toEqual([])
    projection.dispose()
  })

  test("a working chat with a new assistant message and no one at it is marked unread once, and its next messages publish nothing", async () => {
    const { store } = openStore()
    started(store, "chat")
    appended(store, "chat")
    const { projection, view, patches } = project(store)
    // Messages from before the baseline count as read.
    expect(await view()).toEqual({ stopped: [], unread: [] })

    appended(store, "chat")
    appended(store, "chat")
    appended(store, "chat")
    expect(await view()).toEqual({ stopped: [], unread: ["chat"] })
    expect(patches).toEqual([{ cursor: { scope: "workspace", domain: "unreadChats" }, payload: { kind: "unreadChats.changed", stopped: [], unread: ["chat"], newStops: [] } }])
    projection.dispose()
  })

  test("a working chat's messages after its receipt are unread after a restart, and a person's interrupt takes the mark away with no stop", async () => {
    const { store } = openStore()
    started(store, "chat")
    started(store, "cut")
    const first = project(store)
    await first.view()
    for (const sessionId of ["chat", "cut"]) {
      const connection = {}
      await presence(first.projection, connection, sessionId)
      appended(store, sessionId)
      await presence(first.projection, connection, undefined)
    }
    first.projection.dispose()
    // Stored while no service ran: the chats' receipts do not cover them.
    appended(store, "chat")
    appended(store, "cut")
    const second = project(store)
    expect(await second.view()).toEqual({ stopped: [], unread: ["chat", "cut"] })
    appended(store, "cut", "cut")
    expect(await second.view()).toEqual({ stopped: [], unread: ["chat"] })
    second.projection.dispose()

    const third = project(store)
    expect(await third.view()).toEqual({ stopped: [], unread: ["chat"] })
    // Resumed, the chat works again, with the message the person has not read.
    started(store, "cut")
    expect(await third.view()).toEqual({ stopped: [], unread: ["chat", "cut"] })
    third.projection.dispose()
  })

  test("a deleted chat leaves the view, also after a restart", async () => {
    const { store } = openStore()
    started(store, "chat")
    stopped(store, "chat", ANSWER)
    const first = project(store)
    expect(await first.stoppedIds()).toEqual(["chat"])
    sessionFact(store, "chat", "session.deleted", {})
    expect(await first.stoppedIds()).toEqual([])
    first.projection.dispose()
    const second = project(store)
    expect(await second.stoppedIds()).toEqual([])
    second.projection.dispose()
  })

  test("a compaction of a read stopped chat leaves it read, and a turn with no new answer keeps a chat read or unread with the same stop", async () => {
    const { store } = openStore()
    started(store, "read")
    stopped(store, "read", ANSWER)
    started(store, "unread")
    const unreadStop = { entryId: "answer-u", firstLine: "Waiting on you." }
    stopped(store, "unread", unreadStop)
    const { projection, view } = project(store)
    await mark(projection, "read", true)
    const before = (await view()).stopped
    expect(before.map((chat) => chat.sessionId)).toEqual(["unread"])

    appended(store, "read", "compaction")
    expect((await view()).stopped).toEqual(before)

    // A message from another session continues each chat, and its turn says nothing new.
    for (const [sessionId, answer] of [["read", ANSWER], ["unread", unreadStop]] as const) {
      started(store, sessionId)
      appended(store, sessionId)
      stopped(store, sessionId, answer)
    }
    const after = (await view()).stopped
    expect(after.map((chat) => chat.sessionId)).toEqual(["unread"])
    expect(after[0]?.stopKey).toBe("answer-u")
    expect(after[0]?.firstLine).toBe("Waiting on you.")
    expect((await view()).unread).toEqual([])
    projection.dispose()
  })

  test("a patch announces each live stop once, and never a baseline stop, a mark, a stop under presence, or the same stop recorded again", async () => {
    const { store } = openStore()
    started(store, "earlier")
    stopped(store, "earlier", { entryId: "answer-e", firstLine: "Before." })
    started(store, "chat")
    started(store, "watched")
    const surface = asAsyncEventReadSurface(store)
    // One stop lands while the baseline read runs: it is live, and the snapshot covers its patch.
    let during = true
    const reader = { ...surface, capturePosition: async () => { const position = await surface.capturePosition(); if (during) { during = false; stopped(store, "chat", ANSWER) } return position } }
    const { projection, patches, view } = project(store, reader)
    await view()
    const announced = () => patches.flatMap((patch) => patch.payload.kind === "unreadChats.changed" ? patch.payload.newStops.map((chat) => `${chat.sessionId}:${chat.stopKey}`) : [])
    expect(announced()).toEqual(["chat:answer-1"])

    await mark(projection, "earlier", true)
    await mark(projection, "earlier", false)
    // A turn that says nothing new records the same stop again.
    started(store, "chat")
    stopped(store, "chat", ANSWER)
    await presence(projection, {}, "watched")
    stopped(store, "watched", { entryId: "answer-w", firstLine: "Seen." })
    await presence(projection, {}, undefined)
    const failure = stopped(store, "earlier", undefined, { kind: "failed", failure: "api_error" })
    await view()
    expect(announced()).toEqual(["chat:answer-1", `earlier:stop:${failure.position}`])
    projection.dispose()
  })

  test("a restart rebuilds the same view from the store, with no presence", async () => {
    const { store } = openStore()
    started(store, "read")
    stopped(store, "read", ANSWER)
    started(store, "unread")
    stopped(store, "unread", undefined, { kind: "refused" })
    started(store, "marked")
    stopped(store, "marked", { entryId: "answer-m", firstLine: "Marked." })
    const first = project(store)
    await mark(first.projection, "read", true)
    await mark(first.projection, "marked", true)
    await mark(first.projection, "marked", false)
    const before = await first.view()
    await presence(first.projection, {}, "unread")
    expect((await first.view()).stopped.map((chat) => chat.sessionId)).toEqual(["marked"])
    first.projection.dispose()

    // The presence ended with the service: the chat it showed read is unread again.
    const second = project(store)
    expect(before.stopped.map((chat) => chat.sessionId)).toEqual(["marked", "unread"])
    expect(await second.view()).toEqual(before)
    second.projection.dispose()
  })

  test("a snapshot covers every patch that its view holds, also one published while its baseline read ran", async () => {
    const { store } = openStore()
    started(store, "chat")
    const surface = asAsyncEventReadSurface(store)
    // The stop lands while the baseline read runs.
    const reader = { ...surface, capturePosition: async () => { const position = await surface.capturePosition(); stopped(store, "chat", ANSWER); return position } }
    const patches: RuntimeUiPatchInput[] = []
    const projection = createUnreadChatsProjection<Connection>({
      reader, writer: { append: async (event) => store.append(event) }, onStored: store.onStored,
      bus: { publish: (patch) => { patches.push(patch) }, snapshotPosition: () => patches.length },
    })
    const snapshot = await projection.snapshot()
    expect(snapshot.stopped.map((chat) => chat.sessionId)).toEqual(["chat"])
    expect(patches).toHaveLength(1)
    expect(snapshot.snapshotPosition).toBe(1)
    projection.dispose()
  })

  test("a chat whose read state cannot be decoded is left out and recorded once with no stored content", async () => {
    const { store, path } = openStore()
    started(store, "corrupt")
    const stop = stopped(store, "corrupt", { entryId: "answer-c", firstLine: "storedsecret" })
    started(store, "healthy")
    stopped(store, "healthy", ANSWER)
    started(store, "superseded")
    const supersededStop = stopped(store, "superseded", { entryId: "answer-s", firstLine: "storedsecret" })
    started(store, "superseded")
    stopped(store, "superseded", { entryId: "answer-s2", firstLine: "Valid." })
    // A superseded row that parses but that the schema refuses, such as a
    // fact version that a newer build wrote before a rollback.
    started(store, "outdated")
    sessionFact(store, "outdated", "chat.turn.stopped", { conversationId: 5, ending: { kind: "completed" } })
    started(store, "outdated")
    stopped(store, "outdated", { entryId: "answer-o", firstLine: "Valid." })
    const db = new Database(path)
    try {
      for (const position of [stop.position, supersededStop.position]) db.query("UPDATE event SET payload = ? WHERE position = ?").run("{\"conversationId\": storedsecret", position)
    } finally {
      db.close()
    }
    const warn = spyOn(Log.create({ service: "unread-chats-projection" }), "warn")
    try {
      const { projection, stoppedIds } = project(store)
      // A row that a newer one superseded decides nothing, so it hides nothing.
      expect(await stoppedIds()).toEqual(["outdated", "superseded", "healthy"])
      started(store, "corrupt")
      stopped(store, "corrupt", ANSWER)
      expect(await stoppedIds()).toEqual(["outdated", "superseded", "healthy"])
      projection.dispose()
      expect(warn.mock.calls.flatMap(([, fields]) => Array.isArray(fields?.sessionIds) ? fields.sessionIds : [])).toEqual(["corrupt"])
      expect(JSON.stringify(warn.mock.calls)).not.toContain("storedsecret")
    } finally {
      warn.mockRestore()
    }
  })

  test("a receipt whose write fails leaves the chat unread, and the next trigger records it", async () => {
    const { store } = openStore()
    started(store, "chat")
    stopped(store, "chat", ANSWER)
    let fail = true
    const projection = createUnreadChatsProjection<Connection>({
      reader: asAsyncEventReadSurface(store), onStored: store.onStored,
      writer: { append: async (event) => { if (fail) throw new Error("store refused"); return store.append(event) } },
      bus: { publish() {}, snapshotPosition: () => 0 },
    })
    const warn = spyOn(Log.create({ service: "unread-chats-projection" }), "warn")
    try {
      await mark(projection, "chat", true)
      expect((await projection.snapshot()).stopped.map((chat) => chat.sessionId)).toEqual(["chat"])
      await mark(projection, "chat", true)
      expect(warn).toHaveBeenCalledTimes(1)
      fail = false
      await mark(projection, "chat", true)
      expect((await projection.snapshot()).stopped).toEqual([])
      expect(receipts(store)).toHaveLength(1)
    } finally {
      warn.mockRestore()
      projection.dispose()
    }
  })

  test("advancing the set reads nothing per change, whatever the chat count or history length", async () => {
    async function requestsPerChange(chats: number, history: number): Promise<number[]> {
      const { store } = openStore()
      for (let index = 0; index < chats; index += 1) {
        for (let turn = 0; turn < history; turn += 1) {
          started(store, `chat-${index}`)
          appended(store, `chat-${index}`)
          stopped(store, `chat-${index}`, { entryId: `answer-${index}-${turn}`, firstLine: "Done." })
        }
      }
      const counter = countStateRequests(asAsyncEventReadSurface(store))
      const { projection, view } = project(store, counter.reader)
      await view()
      const connection = {}
      counter.take()
      const counts: number[] = []
      const changes = [
        () => started(store, "chat-0"),
        () => appended(store, "chat-0"),
        () => presence(projection, connection, "chat-0"),
        () => stopped(store, "chat-0", { entryId: "answer-next", firstLine: "Next." }),
        () => presence(projection, connection, undefined),
        () => mark(projection, "chat-1", true),
        () => mark(projection, "chat-1", false),
      ]
      for (const change of changes) {
        await change()
        await view()
        counts.push(counter.take().length)
      }
      projection.dispose()
      return counts
    }

    const zero = [0, 0, 0, 0, 0, 0, 0]
    expect(await requestsPerChange(3, 2)).toEqual(zero)
    expect(await requestsPerChange(30, 2)).toEqual(zero)
    expect(await requestsPerChange(3, 20)).toEqual(zero)
  })
})

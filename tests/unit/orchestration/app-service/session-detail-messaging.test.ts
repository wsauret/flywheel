import { describe, expect, test } from "bun:test"
import { asAsyncEventReadSurface, type EventStoreReadSurface, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { createProjectControlClient } from "../../../../src/orchestration/app-service/project-control-client.js"
import { createSessionDetailProjection } from "../../../../src/orchestration/app-service/session-detail-projection.js"
import { chatEntriesAppendedVersion } from "../../../../src/orchestration/session/conversation/conversation-facts.js"
import { interruptedTurnEnd, interruptedTurnMessage, turnEndEntryId, type TurnInterruption } from "../../../../src/orchestration/session/conversation/turn-end-record.js"
import { PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/planned-session-continuation.js"
import { replyWaitLabel, WAITING_ON_PARENT } from "../../../../src/protocol/client/session-controls.js"
import { FIXTURE_EXECUTION_CWD } from "../../../helpers/directories.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { chatEntry, durableRow, managerWithSessions } from "./_frontend-projection-fixtures.js"
import { fixture } from "./_project-control-client-fixture.js"

/** The detail of chat-1 over `reader`, with a runner (`live`) or without one. */
function detail(reader: EventStoreReadSurface, live: boolean) {
  const projectionReader = asAsyncEventReadSurface(reader)
  const manager = managerWithSessions([durableRow("chat-1", { lifecycleState: "active", executionCwd: FIXTURE_EXECUTION_CWD }), durableRow("parent", { label: "Design chat", lifecycleState: "active", executionCwd: FIXTURE_EXECUTION_CWD, conversationId: "parent-conv" })])
  return createSessionDetailProjection({ projectRoot: FIXTURE_EXECUTION_CWD, sessionStore: { get: () => live ? chatEntry() : undefined }, manager, reader: projectionReader, projectionReader })
}

const timestamp = "2026-10-04T00:00:00.000Z"

/** One entry batch of chat-1's conversation at `position`. */
function batch(position: number, entries: Parameters<typeof chatEntriesAppendedVersion>[0]): StoredFact {
  return {
    id: `c-${position}`, position, seq: position - 1, aggregateId: "conversation:conv-1", sessionId: "chat-1", timestamp: position, actor: "flywheel",
    type: "chat.entries.appended", version: chatEntriesAppendedVersion(entries), payload: { conversationId: "conv-1", entries },
  }
}

/** A person's message and the interrupt `by` that cut its turn. */
function interruptedBy(by: TurnInterruption) {
  const end = interruptedTurnEnd(by)
  return [
    { kind: "message", id: "u-1", parentId: null, timestamp, message: { kind: "user", content: "sleep 60", origin: "human" } },
    { kind: "message", id: turnEndEntryId(end, "k"), parentId: "u-1", timestamp, message: { kind: "user", content: interruptedTurnMessage(end.pausedBy, true), origin: "system" } },
  ]
}

describe("session messaging in a session's detail", () => {
  test("messages held for an interrupted chat, each in its own batch after the interrupt, keep the chat's Resume", async () => {
    const end = interruptedTurnEnd("person")
    const interrupted = interruptedBy("person")
    // Each held message commits its own batch.
    const held = (call: number) => [{ kind: "message", id: `msg:sender:call-${call}`, parentId: call === 1 ? turnEndEntryId(end, "k") : `msg:sender:call-${call - 1}`, timestamp, message: { kind: "user", content: "PING", producer: { kind: "session", sessionId: "sender", conversationId: "sender-conv", toolUseId: `call-${call}`, hop: 0, envelope: { name: "Sender", relation: "other", waits: false } } } }]
    const reader = inMemoryEventReader([batch(1, interrupted), ...[1, 2, 3].map((call) => batch(call + 1, held(call)))])
    for (const live of [false, true]) {
      const history = detail(reader, live)
      try {
        // The detail's row is the catalog row a client shows.
        expect((await history.sessionDetail("chat-1")).view?.row.admittedActions).toEqual(["chat.interrupt", "chat.resume", "session.delete"])
      } finally {
        await history.dispose()
      }
    }
  })

  test("a status the history serves lists the reply waits the session stores, and shows the turn parked on them while a successor owes it", async () => {
    // The stored wait of chat-1 on its parent, as between a planned
    // replacement's cut and the successor's restore of the wait, or after a
    // person's interrupt cut the wait.
    const cell = { kind: "session.reply_wait", key: "parent:call-1", payload: { openedAtMs: 1 }, raw: JSON.stringify({ openedAtMs: 1 }) }
    const continuation = { version: 2, sessionId: "chat-1", kind: "chat", handoffId: "handoff-1" }
    const cutBy = (by: TurnInterruption): EventStoreReadSurface => ({
      ...inMemoryEventReader([batch(1, interruptedBy(by))]),
      readInFlight: (sessionId, kind) => {
        if (sessionId !== "chat-1") return []
        const kinds = typeof kind === "string" ? [kind] : kind
        const planned = by === "replacement" && kinds.includes(PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND) ? [{ kind: PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND, key: "chat-1", payload: continuation, raw: JSON.stringify(continuation) }] : []
        return [...(kinds.includes(cell.kind) ? [cell] : []), ...planned]
      },
    })
    const waits = [{ sessionId: "parent", name: "Design chat" }]
    for (const by of ["replacement", "person"] as const) {
      for (const live of [false, true]) {
        const history = detail(cutBy(by), live)
        try {
          const status = (await history.sessionDetail("chat-1")).view?.status
          expect(status?.replyWaits).toEqual(waits)
          // The turn the successor resumes reads as parked on its wait, so
          // its card names the wait; an interrupted waiter waits on nothing.
          expect(replyWaitLabel(status, "parent")).toBe(by === "replacement" ? WAITING_ON_PARENT : undefined)
        } finally {
          await history.dispose()
        }
      }
    }
    const reader = cutBy("replacement")
    // The project control serves the status of a session the executor does
    // not hold from the history, as after a planned replacement.
    const history = detail(reader, false)
    const f = fixture()
    f.metadata.set("chat-1", durableRow("chat-1", { lifecycleState: "active" }))
    const client = createProjectControlClient({ ...f.options, history: { ...f.options.history, sessionDetail: ({ sessionId }: { sessionId: string }) => history.sessionDetail(sessionId) } })
    try {
      await client.query({ type: "snapshot" })
      const status = (await client.query({ type: "statusSnapshot", sessionIds: ["chat-1"] })).views[0]?.view
      expect(status?.replyWaits).toEqual(waits)
      expect(replyWaitLabel(status ?? undefined, "parent")).toBe(WAITING_ON_PARENT)
    } finally {
      await client.close()
      await history.dispose()
    }
  })
})

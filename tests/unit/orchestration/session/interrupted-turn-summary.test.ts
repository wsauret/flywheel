import { describe, expect, mock, test } from "bun:test"
import { interruptedTurnEntryId, interruptedWorkMessage, readInterruptedWork } from "../../../../src/orchestration/session/conversation/interrupted-turn-summary.js"
import { QUEUED_USER_INPUT_IN_FLIGHT_KIND, readConversationQueuedUserInputs } from "../../../../src/orchestration/session/conversation/queued-user-inputs.js"
import { chatTurnEndOf, turnEndOfEntry, type TurnEndEntry } from "../../../../src/orchestration/session/conversation/turn-end-record.js"
import { readChatTurnEnd } from "../../../../src/orchestration/session/chat-session-run-evidence.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { asAsyncEventReadSurface, type StoredFact } from "../../../../src/infra/event-store-types.js"

function fact(position: number, sessionId: string, type: string, payload: { [key: string]: unknown }): StoredFact {
  return {
    position,
    id: `evt_${position}`,
    aggregateId: `session:${sessionId}`,
    seq: position,
    type,
    version: 1,
    timestamp: position,
    actor: "flywheel",
    sessionId,
    payload,
  }
}

/** A provider request of one conversation, which every call it makes names. */
function request(position: number, requestId: string, conversationId: string): StoredFact {
  return {
    ...fact(position, "s1", "model.requested", {
      requestId,
      identity: { providerSessionKey: conversationId, conversationId },
      turn: 1,
      model: "test-model",
      accessProvider: "openai_api",
      modelFamily: "openai",
      interactionProfileId: "default",
    }),
    version: 5,
  }
}

function fileChange(position: number, displayPath: string, toolUseId: string): StoredFact {
  return fact(position, "s1", "file.changed", { path: `/abs/${displayPath}`, displayPath, changeKind: "modified", before: null, after: null, toolUseId })
}

const scope = { sessionId: "s1", conversationId: "c1", answeredToolUseIds: new Set<string>() }

describe("interrupted turn summary", () => {
  test("selects no unrelated facts for an empty recovery", async () => {
    const store = inMemoryEventReader(Array.from({ length: 10_000 }, (_, index) =>
      fact(index + 1, "other", "tool.input.completed", { toolUseId: `t${index}`, toolName: "read" }),
    ))
    const reader = asAsyncEventReadSurface(store)
    const readSlice = mock(reader.readSlice)

    expect(await readInterruptedWork({ ...reader, readSlice }, scope, 0)).toEqual({
      finishedTools: [], unconfirmedTools: [], paths: [],
    })
    expect(readSlice).toHaveBeenCalledTimes(1)
    const result = readSlice.mock.results[0]
    if (result?.type !== "return") throw new Error("Expected a completed slice read")
    expect((await result.value).facts).toHaveLength(0)
    expect(readSlice).toHaveBeenCalledWith({
      aggregateId: "session:s1",
      types: ["tool.input.completed", "tool.result.recorded", "file.changed"],
      afterPosition: 0,
    })
  })

  test("looks up only missing finished inputs before the watermark, and the requests of the calls it names", async () => {
    const store = inMemoryEventReader([
      request(1, "r1", "c1"),
      fact(2, "s1", "tool.input.completed", { toolUseId: "t1", toolName: "read", modelRequestId: "r1" }),
      fact(4, "s1", "tool.result.recorded", { toolUseId: "t1", outcome: "success" }),
    ])
    const reader = asAsyncEventReadSurface(store)
    const readSlice = mock(reader.readSlice)

    expect(await readInterruptedWork({ ...reader, readSlice }, scope, 3)).toEqual({
      finishedTools: ["read"], unconfirmedTools: [], paths: [],
    })
    expect(readSlice.mock.calls).toEqual([
      [{
        aggregateId: "session:s1",
        types: ["tool.input.completed", "tool.result.recorded", "file.changed"],
        afterPosition: 3,
      }],
      [{ aggregateId: "session:s1", types: ["tool.input.completed"], toolUseIds: ["t1"] }],
      [{ aggregateId: "session:s1", types: ["model.requested"], beforePosition: 2, order: "desc", limit: 64 }],
    ])
  })

  test("reads only the calls that this conversation's requests made and its branch does not answer", async () => {
    const store = inMemoryEventReader([
      request(1, "mine", "c1"),
      request(2, "sibling", "c2"),
      fact(3, "s1", "tool.input.completed", { toolUseId: "own", toolName: "edit", modelRequestId: "mine" }),
      fact(4, "s1", "tool.input.completed", { toolUseId: "answered", toolName: "process", modelRequestId: "mine" }),
      fact(5, "s1", "tool.input.completed", { toolUseId: "theirs", toolName: "bash", modelRequestId: "sibling" }),
      fact(6, "s1", "tool.input.completed", { toolUseId: "unnamed", toolName: "grep" }),
      fileChange(7, "src/mine.ts", "own"),
      fileChange(8, "src/answered.ts", "answered"),
      fileChange(9, "src/theirs.ts", "theirs"),
      fact(10, "s1", "tool.result.recorded", { toolUseId: "answered", outcome: "success" }),
      fact(11, "s1", "tool.result.recorded", { toolUseId: "theirs", outcome: "success" }),
    ])

    expect(await readInterruptedWork(asAsyncEventReadSurface(store), { ...scope, answeredToolUseIds: new Set(["answered"]) }, 0)).toEqual({
      finishedTools: [], unconfirmedTools: ["edit"], paths: ["src/mine.ts"],
    })
  })

  test("names the work so the model does not repeat what finished", () => {
    const message = interruptedWorkMessage({ finishedTools: ["edit"], unconfirmedTools: [], paths: ["src/a.ts"] })
    expect(message).toContain("exited before the turn finished")
    expect(message).toContain("edit")
    expect(message).toContain("src/a.ts")
    expect(message).toContain("do not repeat work that finished")
  })

  test("a person's interrupt that ended the process reads as the person's, and its record is the person's interrupt", () => {
    const message = interruptedWorkMessage({ finishedTools: ["edit"], unconfirmedTools: [], paths: [] }, "interrupted")
    expect(message).toContain("The user interrupted this turn")
    expect(message).not.toContain("exited before the turn finished")
    expect(turnEndOfEntry({ kind: "message", id: interruptedTurnEntryId(42, "interrupted"), message: { kind: "user", origin: "system", content: message } })).toEqual({ reason: "paused", pausedBy: "person" })
  })

  test("reads as history, not as a standing instruction", () => {
    // The record stays in the branch, so every later turn reads it in its
    // chronological place. An imperative there would be an order that outlives
    // the turn it was written for.
    const message = interruptedWorkMessage({ finishedTools: ["edit"], unconfirmedTools: [], paths: [] })
    expect(message).not.toContain("Your process")
    expect(message).not.toContain("continue where you left off")
  })

  test("gives one interruption one entry id, and two interruptions different ones", () => {
    expect(interruptedTurnEntryId(42)).toBe(interruptedTurnEntryId(42))
    expect(interruptedTurnEntryId(42)).not.toBe(interruptedTurnEntryId(43))
    // The reason rides the id, where every reader of the record already looks.
    expect(interruptedTurnEntryId(42)).toMatch(/^itb-crash-[0-9a-f]{8}$/)
  })

  test("caps a long list rather than inventorying it", () => {
    const paths = Array.from({ length: 20 }, (_, i) => `src/file-${i}.ts`)
    const message = interruptedWorkMessage({ finishedTools: [], unconfirmedTools: [], paths })
    expect(message).toContain("and 8 more")
    expect(message).not.toContain("file-15")
  })

  test("dedupes repeated tools and paths", async () => {
    const store = inMemoryEventReader([
      request(1, "r1", "c1"),
      fact(2, "s1", "tool.input.completed", { toolUseId: "t1", toolName: "edit", modelRequestId: "r1" }),
      fact(3, "s1", "tool.input.completed", { toolUseId: "t2", toolName: "edit", modelRequestId: "r1" }),
      fileChange(4, "src/a.ts", "t1"),
      fileChange(5, "src/a.ts", "t2"),
    ])
    const work = await readInterruptedWork(asAsyncEventReadSurface(store), scope, 1)
    expect(work.unconfirmedTools).toEqual(["edit"])
    expect(work.paths).toEqual(["src/a.ts"])
  })

  test("preserves in-flight insertion order for one conversation", async () => {
    const base = asAsyncEventReadSurface(inMemoryEventReader([]))
    const reader = {
      ...base,
      readInFlight: async () => [
        { kind: QUEUED_USER_INPUT_IN_FLIGHT_KIND, key: "first", raw: "raw-1", payload: { conversationId: "c1", text: "one" } },
        { kind: QUEUED_USER_INPUT_IN_FLIGHT_KIND, key: "other", raw: "raw-2", payload: { conversationId: "c2", text: "skip" } },
        { kind: QUEUED_USER_INPUT_IN_FLIGHT_KIND, key: "second", raw: "raw-3", payload: { conversationId: "c1", text: "two" } },
      ],
    }

    expect((await readConversationQueuedUserInputs(reader, "s1", "c1")).map((input) => input.key)).toEqual(["first", "second"])
  })

  test("pages the tail back one batch at a time, newest first, until it reaches the turn end", async () => {
    const conversationId = "c1"
    // A person's interrupt is recorded at index 1. The three newer batches
    // hold only produced input, which decides nothing alone, so the read
    // pages back past all of them to the record and stops there.
    const entries: TurnEndEntry[] = Array.from({ length: 5 }, (_, index) => ({
      kind: "message",
      id: index === 1 ? interruptedTurnEntryId(42, "interrupted") : `entry-${index}`,
      parentId: index === 0 ? null : `entry-${index - 1}`,
      timestamp: new Date(index + 1).toISOString(),
      message: { kind: "user", ...(index === 0 ? {} : { origin: "system" as const }), content: `message ${index}` },
    }))
    const batches = entries.map((entry, index) => ({ ...fact(index + 1, "s1", "chat.entries.appended", { conversationId, entries: [entry] }), aggregateId: `conversation:${conversationId}`, version: 3 }))
    const reader = asAsyncEventReadSurface(inMemoryEventReader(batches))
    const readSlice = mock(reader.readSlice)

    const turnEnd = await readChatTurnEnd({ ...reader, readSlice }, conversationId)
    expect(turnEnd).toEqual({ end: { reason: "paused", pausedBy: "person" }, recorded: true })
    expect(turnEnd).toEqual(chatTurnEndOf(entries))
    expect(readSlice.mock.calls).toEqual([undefined, 5, 4, 3].map((beforePosition) => [{
      aggregateId: `conversation:${conversationId}`,
      types: ["chat.entries.appended"],
      order: "desc",
      limit: 1,
      ...(beforePosition === undefined ? {} : { beforePosition }),
    }, true]))
  })
})

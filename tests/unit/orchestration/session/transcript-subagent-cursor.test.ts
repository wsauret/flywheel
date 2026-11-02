import { describe, expect, it } from "bun:test"
import { asAsyncEventReadSurface, type EventStore } from "../../../../src/infra/event-store-types"
import { transcriptFixture, transcriptStores } from "./_transcript-projection-fixtures"
import { createSubagentRunsByToolUseIdCursorReader, readSubagentRunsByToolUseId } from "../../../../src/orchestration/modules/subagents/history/subagent-history"

let store: EventStore
let baseDir: string
const { appendSessionFact, appendCreatedSubagent, appendSubagentCompletion } = transcriptFixture(() => store, () => baseDir)
transcriptStores((nextStore, directory) => {
  store = nextStore
  baseDir = directory
})

describe("transcript subagent cursor", () => {
  it("preserves the subagent map on an empty catch-up and incrementally matches the batch reader", async () => {
    const sessionId = "subagent-session"
    const reader = asAsyncEventReadSurface(store)
    const cursor = createSubagentRunsByToolUseIdCursorReader(reader, sessionId)
    const empty = await cursor.replay()
    expect(empty.runsByToolUseId.size).toBe(0)
    expect(empty.position).toBe(0)
    appendCreatedSubagent(sessionId, "tool-agent")
    const populated = await cursor.replay()

    expect([...populated.changedToolUseIds]).toEqual(["tool-agent"])
    const created = store.read({ aggregateId: `session:${sessionId}`, types: ["child_run.created"] }).at(-1)
    if (!created) throw new Error("Missing child creation fact")
    expect(populated.position).toBe(created.position)
    expect(empty.position).toBe(0)
    expect(populated.runsByToolUseId).toEqual(await readSubagentRunsByToolUseId(reader, sessionId))

    const unchanged = await cursor.replay()
    expect(unchanged.runsByToolUseId).toBe(populated.runsByToolUseId)
    expect(unchanged.position).toBe(populated.position)
    expect([...unchanged.changedToolUseIds]).toEqual([])

    appendSubagentCompletion(sessionId, "tool-agent")
    const updated = await cursor.replay()
    expect([...updated.changedToolUseIds]).toEqual(["tool-agent"])
    const completed = store.read({ aggregateId: `session:${sessionId}`, types: ["subagent.completed"] }).at(-1)
    if (!completed) throw new Error("Missing subagent completion fact")
    expect(updated.position).toBe(completed.position)
    expect(updated.position).toBeGreaterThan(populated.position)
    expect(updated.runsByToolUseId).toEqual(await readSubagentRunsByToolUseId(reader, sessionId))
  })

  it("gives each reader of a parent's shared runs every change it has not seen", async () => {
    const sessionId = "shared-subagent-session"
    const reader = asAsyncEventReadSurface(store)
    const early = createSubagentRunsByToolUseIdCursorReader(reader, sessionId)
    appendCreatedSubagent(sessionId, "tool-agent")
    expect([...(await early.replay()).changedToolUseIds]).toEqual(["tool-agent"])
    // A reader that joins after the fold restates every call once.
    const late = createSubagentRunsByToolUseIdCursorReader(reader, sessionId)
    expect([...(await late.replay()).changedToolUseIds]).toEqual(["tool-agent"])
    appendSubagentCompletion(sessionId, "tool-agent")
    expect([...(await late.replay()).changedToolUseIds]).toEqual(["tool-agent"])
    // The other reader's catch-up folded the completion, and this reader still sees it.
    const caughtUp = await early.replay()
    expect([...caughtUp.changedToolUseIds]).toEqual(["tool-agent"])
    expect(caughtUp.runsByToolUseId.get("tool-agent")?.status).toBe("completed")
    expect([...(await early.replay()).changedToolUseIds]).toEqual([])
  })

  it("omits an undecodable subagent decoration and advances its cursor", async () => {
    const sessionId = "undecodable-subagent-session"
    appendSessionFact(sessionId, { type: "child_run.created", version: 1, actor: "flywheel", payload: {} })
    appendCreatedSubagent(sessionId, "tool-agent")
    const reader = asAsyncEventReadSurface(store)
    const cursor = createSubagentRunsByToolUseIdCursorReader(reader, sessionId)

    const first = await cursor.replay()
    const second = await cursor.replay()

    expect(first.runsByToolUseId.get("tool-agent")?.description).toBe("Locate it")
    expect(second.runsByToolUseId).toEqual(await readSubagentRunsByToolUseId(reader, sessionId))
    expect([...second.changedToolUseIds]).toEqual([])
  })
})

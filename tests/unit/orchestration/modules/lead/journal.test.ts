import { afterEach, beforeEach, expect, test } from "bun:test"
import { asAsyncEventReadSurface } from "../../../../../src/infra/event-store-types.js"
import { createLeadJournal } from "../../../../../src/orchestration/modules/lead/journal.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, type SupervisorTestContext } from "../../../../fixtures/runtime-supervisor-fixtures.js"

let ctx: SupervisorTestContext
beforeEach(() => { ctx = createSupervisorTestContext() })
afterEach(async () => { await disposeSupervisorTestContext(ctx) })

const journal = () => createLeadJournal({ reader: asAsyncEventReadSurface(ctx.store), writer: ctx.store })

test("an append whose fact the state already holds is skipped", async () => {
  const lead = journal()
  expect(await lead.append({ type: "lead.chat.started", payload: { sessionId: "c", sourceEntryIds: ["e1"] } })).toBe(true)
  expect(await lead.append({ type: "lead.chat.started", payload: { sessionId: "c", sourceEntryIds: ["e1"] } })).toBe(false)
  expect(await lead.append({ type: "lead.request.forwarded", payload: { leadSessionId: "l", targetSessionId: "c", newChat: true, sourceEntryIds: ["e1"] } })).toBe(true)
  expect(await lead.append({ type: "lead.request.forwarded", payload: { leadSessionId: "l", targetSessionId: "c", newChat: false, sourceEntryIds: ["e1"] } })).toBe(false)
  expect(await lead.append({ type: "lead.result.read", payload: { sessionId: "c", entryId: "r1" } })).toBe(true)
  expect(await lead.append({ type: "lead.result.read", payload: { sessionId: "c", entryId: "r1" } })).toBe(false)
  // A dismissal of a chat that is not the designated lead changes nothing.
  expect(await lead.append({ type: "lead.chat.dismissed", payload: { sessionId: "c" } })).toBe(false)
  expect(ctx.store.read({ aggregateId: "lead" }).map((fact) => fact.type)).toEqual(["lead.chat.started", "lead.request.forwarded", "lead.result.read"])
})

test("a forward fact without a passages hash, as builds before the split stored it, is a whole-entry forward; each split of the same entries is its own forward", async () => {
  const lead = journal()
  await lead.append({ type: "lead.chat.started", payload: { sessionId: "whole", sourceEntryIds: ["e1"] } })
  await lead.append({ type: "lead.request.forwarded", payload: { leadSessionId: "l", targetSessionId: "whole", newChat: true, sourceEntryIds: ["e1"] } })
  expect(await lead.append({ type: "lead.chat.started", payload: { sessionId: "first", sourceEntryIds: ["e1"], passagesHash: "h1" } })).toBe(true)
  expect(await lead.append({ type: "lead.chat.started", payload: { sessionId: "second", sourceEntryIds: ["e1"], passagesHash: "h2" } })).toBe(true)
  expect(await lead.append({ type: "lead.request.forwarded", payload: { leadSessionId: "l", targetSessionId: "whole", newChat: false, sourceEntryIds: ["e1"], passagesHash: "h1" } })).toBe(true)

  const replayed = journal()
  await replayed.reconcile()
  const state = replayed.state()
  expect([state.startedBy({ sourceEntryIds: ["e1"] }), state.startedBy({ sourceEntryIds: ["e1"], passagesHash: "h1" }), state.startedBy({ sourceEntryIds: ["e1"], passagesHash: "h2" })]).toEqual(["whole", "first", "second"])
  expect(state.forwarded("whole", { sourceEntryIds: ["e1"] })).toBe(true)
  expect(state.forwarded("whole", { sourceEntryIds: ["e1"], passagesHash: "h1" })).toBe(true)
  expect(state.forwarded("whole", { sourceEntryIds: ["e1"], passagesHash: "h2" })).toBe(false)
})

test("a chat is a member from its join until its close, joins again after the close, and keeps the briefing of its first join; the first-run seed is recorded once", async () => {
  const lead = journal()
  // A close of a chat that is not in the list changes nothing.
  expect(await lead.append({ type: "lead.chat.closed", payload: { sessionId: "c" } })).toBe(false)
  expect(await lead.append({ type: "lead.chat.joined", payload: { sessionId: "c", briefed: true } })).toBe(true)
  expect(await lead.append({ type: "lead.chat.joined", payload: { sessionId: "c", briefed: false } })).toBe(false)
  expect([...lead.state().members]).toEqual(["c"])
  expect(await lead.append({ type: "lead.chat.closed", payload: { sessionId: "c" } })).toBe(true)
  expect(await lead.append({ type: "lead.chat.closed", payload: { sessionId: "c" } })).toBe(false)
  expect([...lead.state().members]).toEqual([])
  expect([...lead.state().closed]).toEqual(["c"])
  expect(await lead.append({ type: "lead.chat.joined", payload: { sessionId: "c", briefed: false } })).toBe(true)
  expect([...lead.state().closed]).toEqual([])
  expect(lead.state().seeded).toBe(false)
  expect(await lead.append({ type: "lead.list.seeded", payload: {} })).toBe(true)
  expect(await lead.append({ type: "lead.list.seeded", payload: {} })).toBe(false)

  const replayed = journal()
  await replayed.reconcile()
  expect([...replayed.state().members]).toEqual(["c"])
  expect(replayed.state().briefed.has("c")).toBe(true)
  expect(replayed.state().seeded).toBe(true)
})

test("an append after another writer's commit lands at the next sequence, and a second journal replays both", async () => {
  const first = journal()
  const second = journal()
  expect(await first.append({ type: "lead.chat.designated", payload: { sessionId: "a" } })).toBe(true)
  // The second journal has not read the first commit; its guarded append reads it and then holds it.
  expect(await second.append({ type: "lead.chat.designated", payload: { sessionId: "a" } })).toBe(false)
  expect(await second.append({ type: "lead.chat.dismissed", payload: { sessionId: "a" } })).toBe(true)
  expect(ctx.store.read({ aggregateId: "lead" }).map((fact) => fact.seq)).toEqual([0, 1])

  const replayed = journal()
  await replayed.reconcile()
  expect(replayed.state()).toMatchObject({ lastSeq: 1, designated: "a", dismissed: true })
})

test("replay refuses a lead fact that its schema does not admit", async () => {
  await ctx.store.append({ aggregateId: "lead", type: "lead.chat.designated", version: 2, timestamp: 1, actor: "system", sessionId: "lead", payload: { sessionId: "a" } })
  await expect(journal().reconcile()).rejects.toThrow()
})

import { afterEach, beforeEach, expect, test } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter, type StoredFact } from "../../../../../src/infra/event-store-types.js"
import type { RuntimeSupervisor } from "../../../../../src/orchestration/app-service/runtime-supervisor-types.js"
import { QUEUED_USER_INPUT_IN_FLIGHT_KIND } from "../../../../../src/orchestration/session/conversation/queued-user-inputs.js"
import { LEAD_AGGREGATE_ID } from "../../../../../src/orchestration/modules/lead/facts.js"
import { createLeadJournal } from "../../../../../src/orchestration/modules/lead/journal.js"
import { leadQuestionCall, leadReportCall } from "../../../../../src/protocol/modules/lead.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, supervisorConversationFixture, type SupervisorTestContext } from "../../../../fixtures/runtime-supervisor-fixtures.js"
import { accountOpenChat, committedEntries, finalMessage, leadHarness, settle } from "./_lead-harness.js"

// The reports of the lead's listed chats (PI-LEAD-006): what reaches the lead, and when a report counts as read.

let ctx: SupervisorTestContext
let supervisor: RuntimeSupervisor
let disposeAll: (() => Promise<void>)[] = []
beforeEach(() => { ctx = createSupervisorTestContext() })
afterEach(async () => {
  for (const dispose of disposeAll) await dispose()
  disposeAll = []
  await disposeSupervisorTestContext(ctx)
})

function harness(projectionReader = asAsyncEventReadSurface(ctx.store), onStored = ctx.store.onStored) {
  const lead = leadHarness(ctx, { projectionReader, onStored })
  supervisor = lead.supervisor
  disposeAll.push(lead.dispose)
  return lead
}

/** A chat that the lead started, which no client shows and which has no runner, once the service lists it. */
async function startedChat(lead: ReturnType<typeof harness>): Promise<string> {
  const { sessionId } = await accountOpenChat(ctx)({ name: "Login" })
  await lead.service.journal.append({ type: "lead.chat.started", payload: { sessionId, sourceEntryIds: [`entry-${sessionId}`] } })
  await settle(() => lead.service.journal.state().members.has(sessionId))
  return sessionId
}

test("a chat that the lead started posts its report to the lead once, as a message from the chat, instead of a turn-end notice; the report counts as read, and the chat at rest leaves the list and closes", async () => {
  const { service, openLead, sessionEvents, notices, trace, reports } = harness()
  const lead = await openLead()
  if (lead === null) throw new Error("expected the lead to open")
  await supervisor.ensureChatRunner(lead)
  // A started chat that no client shows, with no runner.
  const { sessionId: chat } = await accountOpenChat(ctx)({ name: "Login" })
  await service.journal.append({ type: "lead.chat.started", payload: { sessionId: chat, sourceEntryIds: ["entry-1"] } })
  await settle(() => service.journal.state().members.has(chat))
  sessionEvents.report(chat, "turn_ended")
  await Bun.sleep(1)
  expect(notices).toEqual([])

  const report = "The login page works now.\nThe sign-in form had two handlers."
  const final = "final-1"
  await (await finalMessage(ctx, chat, final, report))()
  await settle(() => trace.some((line) => line.startsWith("report")))
  expect(trace.filter((line) => line.startsWith("report"))).toEqual([`report ${chat} ${leadReportCall(final)}`])
  await settle(() => !service.journal.state().members.has(chat))
  expect((await service.view()).rows).toEqual([])
  const facts = ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).map((fact) => ({ type: fact.type, payload: fact.payload }))
  expect(facts.slice(-2)).toEqual([{ type: "lead.result.read", payload: { sessionId: chat, entryId: final } }, { type: "lead.chat.retired", payload: { sessionId: chat } }])
  // The lead held the chat while it showed a row; at rest it closes as a closed tab does.
  await settle(async () => (await ctx.manager.read(chat))?.lifecycleState === "inactive")
  // The runtime's delivery took the whole report to the lead as a message from the chat.
  expect(reports).toEqual([{ fromSessionId: chat, toSessionId: lead, call: leadReportCall(final), text: report, status: "delivered" }])
  // Reading the rows again posts nothing more.
  await Bun.sleep(20)
  expect(trace.filter((line) => line.startsWith("report"))).toHaveLength(1)
})

// PI-LEAD-006: only a report that the lead holds as an entry counts as read.
test("a report to a lead with no runner stays unread in the list, and the lead's runner attach posts each waiting report once and reads it", async () => {
  const lead = harness()
  const leadId = await lead.openLead()
  if (leadId === null) throw new Error("expected the lead to open")
  const chats = [await startedChat(lead), await startedChat(lead)]
  for (const [index, chat] of chats.entries()) await (await finalMessage(ctx, chat, `final-${index}`, `Report ${index}.`))()
  await settle(() => lead.reports.length === 2)
  await Bun.sleep(20)
  expect(lead.reports.map((report) => report.status)).toEqual(["held", "held"])
  expect(ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).some((fact) => fact.type === "lead.result.read")).toBe(false)
  expect((await lead.service.view()).rows.map((row) => [row.sessionId, row.state])).toEqual(chats.map((chat) => [chat, "result"]))

  // A store change that attaches no runner to the lead posts nothing.
  ctx.sessionStore.updateEntry(leadId, { runnerState: "absent" })
  ctx.sessionStore.updateEntry(chats[0]!, { runnerState: "absent" })
  await Bun.sleep(20)
  expect(lead.reports).toHaveLength(2)

  await supervisor.ensureChatRunner(leadId)
  await settle(() => ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).filter((fact) => fact.type === "lead.result.read").length === 2)
  expect(lead.reports.slice(2).map((report) => [report.call, report.status]).toSorted()).toEqual([[leadReportCall("final-0"), "delivered"], [leadReportCall("final-1"), "delivered"]])
  for (const [index, chat] of chats.entries()) {
    const key = `msg:${chat}:${leadReportCall(`final-${index}`)}`
    // The cell that the first send held and the send after the attach commit one entry.
    expect(await committedEntries(ctx, leadId, key)).toHaveLength(1)
    expect(ctx.store.readInFlight(leadId, QUEUED_USER_INPUT_IN_FLIGHT_KIND, key)).toEqual([])
  }
  // Later store changes of the lead with its runner post nothing more.
  ctx.sessionStore.updateEntry(leadId, { runnerState: "idle" })
  await Bun.sleep(20)
  expect(lead.reports).toHaveLength(4)
})

test("a question of a listed chat posts to a lead with no runner once, a later publish of its row posts it again never, and the lead's runner attach delivers it once", async () => {
  const lead = harness()
  const leadId = await lead.openLead()
  if (leadId === null) throw new Error("expected the lead to open")
  const chat = await startedChat(lead)
  const conversationId = await supervisorConversationFixture(() => ctx).chatConversationId(chat)
  const ask = (id: string, timestamp: number) => ctx.store.append({
    aggregateId: `session:${chat}`, sessionId: chat, type: "agent_input.requested", version: 3, actor: "agent", timestamp,
    payload: { interactionId: id, conversationId, toolUseId: id, request: [{ question: `${id}?`, multiSelect: false, choices: [{ kind: "option" as const, choiceId: "a", label: "Yes" }] }] },
  })
  await ask("ask-1", 1_000)
  await settle(() => lead.reports.length === 1)
  // A second question publishes the row again.
  await ask("ask-2", 2_000)
  await settle(() => lead.reports.length === 2)
  ctx.sessionStore.updateEntry(chat, { runnerState: "absent" })
  await Bun.sleep(20)
  expect(lead.reports.map((report) => [report.call, report.status])).toEqual([[leadQuestionCall("ask-1"), "held"], [leadQuestionCall("ask-2"), "held"]])

  await supervisor.ensureChatRunner(leadId)
  await settle(() => lead.reports.length === 4)
  await Bun.sleep(20)
  expect(lead.reports.slice(2).map((report) => [report.call, report.status])).toEqual([[leadQuestionCall("ask-1"), "delivered"], [leadQuestionCall("ask-2"), "delivered"]])
  for (const id of ["ask-1", "ask-2"]) {
    const key = `msg:${chat}:${leadQuestionCall(id)}`
    expect(await committedEntries(ctx, leadId, key)).toHaveLength(1)
    expect(ctx.store.readInFlight(leadId, QUEUED_USER_INPUT_IN_FLIGHT_KIND, key)).toEqual([])
  }
})

test("a report whose send read the lead at rest while the lead's runner attached posts again once the send settles", async () => {
  const answered = Promise.withResolvers<void>()
  const lead = leadHarness(ctx, { answered: () => answered.promise })
  supervisor = lead.supervisor
  disposeAll.push(async () => { answered.resolve(); await lead.dispose() })
  const leadId = await lead.openLead()
  if (leadId === null) throw new Error("expected the lead to open")
  const chat = await startedChat(lead)
  await (await finalMessage(ctx, chat, "final-1", "The login page works now."))()
  await settle(() => lead.reports.length === 1)
  expect(lead.reports.map((report) => report.status)).toEqual(["held"])
  // The runner attaches while the service has yet to read the send's answer.
  await supervisor.ensureChatRunner(leadId)
  answered.resolve()
  await settle(() => ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).some((fact) => fact.type === "lead.result.read"))
  expect(lead.reports.map((report) => report.status)).toEqual(["held", "delivered"])
  const key = `msg:${chat}:${leadReportCall("final-1")}`
  expect(await committedEntries(ctx, leadId, key)).toHaveLength(1)
  expect(ctx.store.readInFlight(leadId, QUEUED_USER_INPUT_IN_FLIGHT_KIND, key)).toEqual([])
})

test("a report that waited for a lead with no runner across a restart commits once when the lead's runner attaches", async () => {
  const before = harness()
  const leadId = await before.openLead()
  if (leadId === null) throw new Error("expected the lead to open")
  // The person talked to the lead before, so the stop keeps the lead chat.
  await supervisorConversationFixture(() => ctx).appendConversation(leadId, [{ kind: "user", content: "Fix the login page", origin: "human" }])
  const chat = await startedChat(before)
  await (await finalMessage(ctx, chat, "final-1", "The login page works now."))()
  await settle(() => before.reports.length === 1)
  expect(before.reports.map((report) => report.status)).toEqual(["held"])
  await before.dispose()
  disposeAll = disposeAll.filter((dispose) => dispose !== before.dispose)

  const after = harness()
  await settle(() => after.reports.length === 1)
  expect(after.reports.map((report) => report.status)).toEqual(["held"])
  // The client opens the lead again, and its runner attaches.
  expect(await after.openLead()).toBe(leadId)
  expect(await supervisor.activateSession(leadId)).toBe(true)
  await supervisor.ensureChatRunner(leadId)
  await settle(() => ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).some((fact) => fact.type === "lead.result.read"))
  expect(after.reports.map((report) => report.status)).toEqual(["held", "delivered"])
  const key = `msg:${chat}:${leadReportCall("final-1")}`
  expect(await committedEntries(ctx, leadId, key)).toHaveLength(1)
  expect(ctx.store.readInFlight(leadId, QUEUED_USER_INPUT_IN_FLIGHT_KIND, key)).toEqual([])
})

test("a report that the lead holds is not delivered again after a restart that lost its read mark", async () => {
  // The first process delivers the report to the lead's runner and stops before its read mark lands.
  const store = asAsyncEventWriter(ctx.store)
  const appendGuarded: typeof store.appendGuarded = async (event) => {
    if (event.type === "lead.result.read") throw new Error("the process stopped")
    return await store.appendGuarded(event)
  }
  const before = leadHarness(ctx, { eventWriter: { ...store, appendGuarded } })
  supervisor = before.supervisor
  disposeAll.push(before.dispose)
  const leadId = await before.openLead()
  if (leadId === null) throw new Error("expected the lead to open")
  await supervisor.ensureChatRunner(leadId)
  const chat = await startedChat(before)
  await (await finalMessage(ctx, chat, "final-1", "The login page works now."))()
  await settle(() => before.reports.length > 0)
  await Bun.sleep(20)
  expect(before.reports.map((report) => report.status)).toEqual(["delivered"])
  expect(ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).some((fact) => fact.type === "lead.result.read")).toBe(false)
  await before.dispose()
  disposeAll = disposeAll.filter((dispose) => dispose !== before.dispose)

  // The next process posts the unread result again, and the runtime's delivery finds the entry that the lead holds.
  const key = `msg:${chat}:${leadReportCall("final-1")}`
  const after = harness()
  await settle(() => ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).some((fact) => fact.type === "lead.result.read"))
  expect(after.reports).toEqual([expect.objectContaining({ call: leadReportCall("final-1"), status: "delivered" })])
  expect(await committedEntries(ctx, leadId, key)).toHaveLength(1)
  expect(ctx.store.readInFlight(leadId, QUEUED_USER_INPUT_IN_FLIGHT_KIND, key)).toEqual([])
  expect(ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).filter((fact) => fact.type === "lead.result.read").map((fact) => fact.payload)).toEqual([{ sessionId: chat, entryId: "final-1" }])
})

test("two finals of one chat that fold before their reports post each report with its own text", async () => {
  // The store's broadcast, held while the test appends, then delivered one batch after another in one go.
  const listeners = new Set<(events: readonly StoredFact[]) => void>()
  let held: (readonly StoredFact[])[] | undefined
  disposeAll.push(async () => { unsubscribe() })
  const unsubscribe = ctx.store.onStored((events) => { if (held) held.push(events); else for (const listener of listeners) listener(events) })
  const lead = harness(asAsyncEventReadSurface(ctx.store), (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } })
  if (await lead.openLead() === null) throw new Error("expected the lead to open")
  // A started chat with no runner, so each final message reads as a result at once.
  const { sessionId: chat } = await accountOpenChat(ctx)({ name: "Login" })
  // Appended through another connection, as the route of another process does, so the service follows it from the broadcast.
  await createLeadJournal({ reader: asAsyncEventReadSurface(ctx.store), writer: ctx.store }).append({ type: "lead.chat.started", payload: { sessionId: chat, sourceEntryIds: ["entry-1"] } })
  await settle(async () => (await lead.service.progress(chat)).kind !== "refused")
  const first = await finalMessage(ctx, chat, "final-1", "First answer.")
  const second = await finalMessage(ctx, chat, "final-2", "Second answer.")
  // Both batches reach the service before its lane runs the first report.
  held = []
  await first()
  await second()
  const batches = held
  held = undefined
  for (const events of batches) for (const listener of listeners) listener(events)
  await settle(() => lead.reports.length >= 2)
  expect(lead.reports.map((report) => [report.call, report.text])).toEqual([[leadReportCall("final-1"), "First answer."], [leadReportCall("final-2"), "Second answer."]])
})


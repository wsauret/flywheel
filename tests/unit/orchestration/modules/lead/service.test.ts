import { afterEach, beforeEach, expect, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { asAsyncEventReadSurface, asAsyncEventWriter, type StoredFact } from "../../../../../src/infra/event-store-types.js"
import type { RuntimeSupervisor } from "../../../../../src/orchestration/app-service/runtime-supervisor-types.js"
import { decodeQueuedUserInputCell, QUEUED_USER_INPUT_IN_FLIGHT_KIND } from "../../../../../src/orchestration/session/conversation/queued-user-inputs.js"
import { EventReaderService } from "../../../../../src/infra/event-store-effect.js"
import { LEAD_AGGREGATE_ID } from "../../../../../src/orchestration/modules/lead/facts.js"
import { createLeadJournal } from "../../../../../src/orchestration/modules/lead/journal.js"
import { leadChatsCursor, leadQuestionCall, leadReportCall } from "../../../../../src/protocol/modules/lead.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, supervisorConversationFixture, type SupervisorTestContext } from "../../../../fixtures/runtime-supervisor-fixtures.js"
import { countStateRequests, factsRead } from "../../../../helpers/state-requests.js"
import { createUnstartedChild } from "../subagents/_subagent-child-fixtures.js"
import { accountOpenChat, leadHarness } from "./_lead-harness.js"
import { composeModuleServices } from "../../../../../src/infra/module-service.js"
import { createMessageSessionTool } from "../../../../../src/orchestration/agent-runtime/tools/message-session.js"
import { milestoneMessageUse } from "../../../../../src/orchestration/modules/lead/prompt.js"
import { createLeadRuntime } from "../../../../../src/orchestration/modules/lead/runtime.js"
import { createSessionMessaging } from "../../../../../src/orchestration/session/session-messaging.js"
import { unusedChildSessionControl } from "../../../../helpers/child-session-control.js"

let ctx: SupervisorTestContext
let supervisor: RuntimeSupervisor
let disposeAll: (() => Promise<void>)[] = []
beforeEach(() => { ctx = createSupervisorTestContext() })
afterEach(async () => {
  for (const dispose of disposeAll) await dispose()
  disposeAll = []
  await disposeSupervisorTestContext(ctx)
})

const conversation = supervisorConversationFixture(() => ctx)

function harness(projectionReader = asAsyncEventReadSurface(ctx.store), onStored = ctx.store.onStored) {
  const lead = leadHarness(ctx, { projectionReader, onStored })
  supervisor = lead.supervisor
  disposeAll.push(lead.dispose)
  return lead
}

test("dispose settles the startup replay, and nothing is published after it resolves", async () => {
  const reader = asAsyncEventReadSurface(ctx.store)
  const gate = Promise.withResolvers<void>()
  const { service, patches } = harness({ ...reader, capturePosition: async () => { await gate.promise; return reader.capturePosition() } })
  let disposed = false
  const disposing = (async () => { await service.dispose(); disposed = true })()
  await Bun.sleep(1)
  expect(disposed).toBe(false)
  gate.resolve()
  await disposing
  await Bun.sleep(1)
  expect(patches.filter((patch) => patch.cursor.domain === leadChatsCursor().domain)).toEqual([])
})

test("while the module is off a listed chat's failure gives no notice, and after it turns on a failure gives one", async () => {
  const { service, openLead, sessionEvents, notices, setEnabled } = harness()
  const lead = await openLead()
  expect(lead).not.toBeNull()
  await service.journal.append({ type: "lead.chat.joined", payload: { sessionId: "c", briefed: false } })
  await supervisor.ensureChatRunner(lead!)

  await setEnabled(false)
  sessionEvents.report("c", "failed")
  await Bun.sleep(1)
  expect(notices).toEqual([])

  await setEnabled(true)
  sessionEvents.report("c", "failed")
  await Bun.sleep(1)
  expect(notices).toEqual([lead!])
})

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
  await (await finalMessage(chat, final, report))()
  await settle(() => trace.some((line) => line.startsWith("report")))
  expect(trace.filter((line) => line.startsWith("report"))).toEqual([`report ${chat} ${leadReportCall(final)}`])
  await settle(() => !service.journal.state().members.has(chat))
  expect((await service.view()).rows).toEqual([])
  const facts = ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).map((fact) => ({ type: fact.type, payload: fact.payload }))
  expect(facts.slice(-2)).toEqual([{ type: "lead.result.read", payload: { sessionId: chat, entryId: final } }, { type: "lead.chat.retired", payload: { sessionId: chat } }])
  // The lead held the chat while it showed a row; at rest it closes as a closed tab does.
  await settle(async () => (await ctx.manager.read(chat))?.lifecycleState === "inactive")
  // The runtime's delivery took the whole report to the lead as a message from the chat.
  expect(reports).toEqual([{ fromSessionId: chat, toSessionId: lead, call: leadReportCall(final), text: report, status: expect.stringMatching(/^(delivered|held)$/) }])
  // Reading the rows again posts nothing more.
  await Bun.sleep(20)
  expect(trace.filter((line) => line.startsWith("report"))).toHaveLength(1)
})

test("a listed chat's question posts to the lead once, word for word, as a question message instead of a notice, and its query follows it to its answer", async () => {
  const lead = harness()
  const { leadId, chat } = await listedChat(lead)
  const context = "The login page has two forms."
  const question = { question: "Which form should change?", header: "Form", multiSelect: false, choices: [
    { kind: "option" as const, choiceId: "a", label: "Sign-in form", description: "The form on the start page", recommended: true },
    { kind: "option" as const, choiceId: "b", label: "Sign-up form" },
  ] }
  // The chat's runner parks on the question before its call commits, as a running turn does.
  ctx.sessionStore.updateEntry(chat, { runnerState: "awaiting_user" })
  await conversation.appendConversation(chat, [{ kind: "assistant", content: [{ type: "tool_use", id: "ask-1", name: "ask_user", input: { context, questions: [] } }] }])
  await ctx.store.append({
    aggregateId: `session:${chat}`, sessionId: chat, type: "agent_input.requested", version: 3, actor: "agent", timestamp: 1_000,
    payload: { interactionId: "ask-1", conversationId: await conversation.chatConversationId(chat), toolUseId: "ask-1", request: [question] },
  })
  lead.sessionEvents.report(chat, "asked")
  await settle(() => lead.reports.some((report) => report.call === leadQuestionCall("ask-1")))
  expect(lead.reports.filter((report) => report.call === leadQuestionCall("ask-1"))).toEqual([{
    fromSessionId: chat, toSessionId: leadId, call: leadQuestionCall("ask-1"), status: expect.stringMatching(/^(delivered|held)$/),
    text: `Context:\n${context}\nQuestion (Form): Which form should change?\nOptions:\n- Sign-in form: The form on the start page (recommended)\n- Sign-up form`,
  }])
  // The message replaces the hidden notice of a question.
  expect(lead.notices).toEqual([])
  expect(await lead.service.question(chat, "ask-1")).toEqual({
    state: "pending", context, question: { kind: "question", toolUseId: "ask-1", questions: [question], timestamp: 1_000 },
  })

  await ctx.store.append({
    aggregateId: `session:${chat}`, sessionId: chat, type: "agent_input.answered", version: 3, actor: "user", timestamp: 2_000,
    payload: { interactionId: "ask-1", answers: { [question.question]: { kind: "choice", selections: [{ choiceId: "a" }], text: "Sign-in form" } } },
  })
  expect(await lead.service.question(chat, "ask-1")).toEqual({ state: "answered", answers: { [question.question]: "Sign-in form" } })
  expect(await lead.service.question(chat, "ask-2")).toEqual({ state: "unknown" })
  // The rows that change after it post nothing more.
  await Bun.sleep(20)
  expect(lead.reports.filter((report) => report.call === leadQuestionCall("ask-1"))).toHaveLength(1)
})

test("a chat that asks two questions in one batch posts both to the lead, oldest first", async () => {
  const lead = harness()
  const { chat } = await listedChat(lead)
  const conversationId = await conversation.chatConversationId(chat)
  const ask = (id: string, text: string, timestamp: number) => ({
    aggregateId: `session:${chat}`, sessionId: chat, type: "agent_input.requested", version: 3, actor: "agent" as const, timestamp,
    payload: { interactionId: id, conversationId, toolUseId: id, request: [{ question: text, multiSelect: false, choices: [{ kind: "option" as const, choiceId: "a", label: "Yes" }] }] },
  })
  await ctx.store.appendBatch([ask("ask-1", "First?", 1_000), ask("ask-2", "Second?", 2_000)])
  lead.sessionEvents.report(chat, "asked")
  const posted = () => lead.reports.flatMap((report) => report.call.startsWith(leadQuestionCall("")) ? [report.call] : [])
  await settle(() => posted().length === 2)
  expect(posted()).toEqual([leadQuestionCall("ask-1"), leadQuestionCall("ask-2")])
})

/** Opens a new lead with its runner started and a listed chat whose turn works, and answers both ids. */
async function listedChat(lead: ReturnType<typeof harness>): Promise<{ readonly leadId: string; readonly chat: string }> {
  const leadId = await lead.openLead()
  if (leadId === null) throw new Error("expected the lead to open")
  await supervisor.ensureChatRunner(leadId)
  return { leadId, chat: await personChat(lead) }
}

/** The append of one final assistant message of `sessionId`, which the store broadcasts at once. */
async function finalMessage(sessionId: string, id: string, text: string) {
  const conversationId = await conversation.chatConversationId(sessionId)
  return () => ctx.store.append({
    aggregateId: `conversation:${conversationId}`, type: "chat.entries.appended", version: 7, timestamp: Date.now(), actor: "flywheel", sessionId,
    payload: { conversationId, entries: [{ kind: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { kind: "assistant", content: [{ type: "text", text }] } }] },
  })
}

async function settle(until: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200 && !await until(); attempt += 1) await Bun.sleep(5)
}

test("a report that the lead holds is not delivered again after a restart that lost its read mark", async () => {
  // The first process sends the report and stops before its read mark lands.
  const store = asAsyncEventWriter(ctx.store)
  const appendGuarded: typeof store.appendGuarded = async (event) => {
    if (event.type === "lead.result.read") throw new Error("the process stopped")
    return await store.appendGuarded(event)
  }
  const first = harness()
  const { leadId, chat } = await listedChat(first)
  await first.dispose()
  disposeAll = disposeAll.filter((dispose) => dispose !== first.dispose)
  const before = leadHarness(ctx, { eventWriter: { ...store, appendGuarded } })
  supervisor = before.supervisor
  disposeAll.push(before.dispose)
  await (await finalMessage(chat, "final-1", "The login page works now."))()
  await settle(() => before.reports.length > 0)
  await Bun.sleep(20)
  expect(before.reports.map((report) => report.status)).toEqual([expect.stringMatching(/^(delivered|held)$/)])
  expect(ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).some((fact) => fact.type === "lead.result.read")).toBe(false)
  await before.dispose()
  disposeAll = disposeAll.filter((dispose) => dispose !== before.dispose)

  // The next process posts the unread result again, and the runtime's delivery finds the report the lead holds.
  const key = `msg:${chat}:${leadReportCall("final-1")}`
  const held = () => ctx.store.readInFlight(leadId, QUEUED_USER_INPUT_IN_FLIGHT_KIND, key).length
  const heldBefore = held()
  const after = harness()
  await settle(async () => (await after.service.view()).rows.every((row) => row.state !== "result") && after.reports.length > 0)
  expect(after.reports).toEqual([expect.objectContaining({ call: leadReportCall("final-1"), status: "delivered" })])
  expect(held()).toBe(heldBefore)
  await settle(() => ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).some((fact) => fact.type === "lead.result.read"))
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
  const first = await finalMessage(chat, "final-1", "First answer.")
  const second = await finalMessage(chat, "final-2", "Second answer.")
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

type Collection = readonly unknown[] | ReadonlyMap<unknown, unknown> | ReadonlySet<unknown>

/** Resolves on the next turn of the event loop. The service folds each stored batch in promise continuations that
 *  nothing awaits, with no timer and no input or output, and every continuation runs before the next turn, whatever
 *  the load of the machine. */
const nextTurn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

/** The frame of a call from the lead module's own source. */
const LEAD_SOURCE = /[\\/]src[\\/]orchestration[\\/]modules[\\/]lead[\\/]/

/** The in-memory collection work that the lead module's own code does for `work` until the next turn after it: each
 *  step of a Map or Set iterator, including the iteration that a spread or a copy does, each element that an array
 *  search or transform visits, and each Map or Set lookup. A scan, a copy, or a linear search over the started chats
 *  shows as a count that grows with them. Only calls in the asynchronous context of `work` count, so work of earlier
 *  setup, or of another test file that the same process runs, never counts, also when it lands inside the window.
 *  Only calls from the lead module count: a kernel read that the lead starts, such as a read of the session manager,
 *  catches up shared projections over whatever other writers committed meanwhile, so its cost depends on the timing
 *  of the machine, and the kernel's own work-count tests bound it. */
async function collectionWorkOf(work: () => Promise<void>): Promise<number> {
  const scope = new AsyncLocalStorage<true>()
  let steps = 0
  // True while a count reads its caller, whose stack text the patched methods must not count.
  let counting = false
  const count = (cost: number): void => {
    if (cost === 0 || counting || !scope.getStore()) return
    counting = true
    try {
      // Frames: the message, this function, the patched method, then its caller, past any native frame such as Array.from.
      const caller = new Error("the caller of a collection call").stack?.split("\n").slice(3).find((frame) => !frame.includes("(native"))
      if (caller !== undefined && LEAD_SOURCE.test(caller)) steps += cost
    } finally { counting = false }
  }
  const restores: (() => void)[] = []
  const size = (receiver: Collection): number => Array.isArray(receiver) ? receiver.length : "size" in receiver ? receiver.size : 0
  /** Replaces one built-in method with one that counts `cost(receiver)` and, for an iterator, each step it takes. */
  function patch(proto: Collection, name: PropertyKey, cost: (receiver: Collection) => number, kind: "iterator" | "call" = "call") {
    const original = Object.getOwnPropertyDescriptor(proto, name)
    if (!original) return
    Object.defineProperty(proto, name, { ...original, value(this: Collection, ...args: never[]) {
      count(cost(this))
      const result = original.value.apply(this, args)
      if (kind === "iterator") {
        const next = result.next.bind(result)
        Object.defineProperty(result, "next", { value: (...nextArgs: never[]) => { count(1); return next(...nextArgs) } })
      }
      return result
    } })
    restores.push(() => { Object.defineProperty(proto, name, original) })
  }
  for (const proto of [Map.prototype, Set.prototype]) {
    for (const name of ["keys", "values", "entries", Symbol.iterator]) patch(proto, name, () => 0, "iterator")
    for (const name of ["get", "has"]) patch(proto, name, () => 1)
    patch(proto, "forEach", size)
  }
  for (const name of ["some", "every", "find", "findIndex", "filter", "map", "flatMap", "forEach", "includes", "indexOf", "reduce"]) patch(Array.prototype, name, size)
  try {
    await scope.run(true, async () => {
      await work()
      await nextTurn()
    })
    return steps
  } finally {
    for (const restore of restores.toReversed()) restore()
  }
}

/** The store's broadcast, except that while `hold` is on it keeps back the facts of the lead aggregate, so that a test
 *  can `deliver` each of them as a batch of its own. Every other fact passes at once. A commit batch of the store
 *  holds whatever every writer committed at the same time, and each listener walks the whole batch, so only a
 *  delivery of one fact has a cost that is the same in every run. */
function heldLeadFacts(onStored: (listener: (events: readonly StoredFact[]) => void) => () => void) {
  const listeners = new Set<(events: readonly StoredFact[]) => void>()
  let held: StoredFact[] | undefined
  const notify = (events: readonly StoredFact[]): void => { for (const listener of listeners) listener(events) }
  const unsubscribe = onStored((events) => {
    if (!held) return notify(events)
    held.push(...events.filter((event) => event.aggregateId === LEAD_AGGREGATE_ID))
    const passing = events.filter((event) => event.aggregateId !== LEAD_AGGREGATE_ID)
    if (passing.length > 0) notify(passing)
  })
  return {
    onStored(listener: (events: readonly StoredFact[]) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    hold() { held = [] },
    /** Ends the hold and answers the facts that it kept, in commit order. */
    release(): readonly StoredFact[] { const facts = held ?? []; held = undefined; return facts },
    deliver(fact: StoredFact) { notify([fact]) },
    [Symbol.dispose]: unsubscribe,
  }
}

test("each applied lead fact costs work that grows with neither the listed chats, the chats that left the list, nor the history", async () => {
  /** The state requests, the watches, and the collection work of the service, the control part, and the journal for
   *  each of `facts` chats that join the list through another writer and get a forward, and checks again, after
   *  `existing` listed chats. */
  async function costs(existing: number, facts: number) {
    const counter = countStateRequests(asAsyncEventReadSurface(ctx.store))
    using stored = heldLeadFacts(ctx.store.onStored)
    const { service, openLead, trace, dispose } = harness(counter.reader, stored.onStored)
    // Only this run's service observes its facts.
    disposeAll = disposeAll.filter((other) => other !== dispose)
    await using _service = { [Symbol.asyncDispose]: dispose }
    const writer = createLeadJournal({ reader: asAsyncEventReadSurface(ctx.store), writer: ctx.store })
    const lead = await openLead()
    if (lead === null) throw new Error("expected the lead to open")
    const working: string[] = []
    for (let index = 0; index < existing; index += 1) {
      // A real chat that works, so the rows owner shows its row and a walk of the rows would show in the collection work.
      const chat = await supervisor.openSessionRuntime()
      await conversation.appendConversation(chat, [{ kind: "user", content: "Fix it", origin: "human" }])
      working.push(chat)
      await writer.append({ type: "lead.chat.started", payload: { sessionId: chat, sourceEntryIds: [`old-entry-${existing}-${index}`] } })
      await writer.append({ type: "lead.request.forwarded", payload: { leadSessionId: lead, targetSessionId: chat, newChat: true, sourceEntryIds: [`old-entry-${existing}-${index}`] } })
      // As many chats that left the list at rest, which a walk of every chat that ever joined would show.
      const gone = await ctx.manager.createChat({ initialState: "inactive" })
      await writer.append({ type: "lead.chat.joined", payload: { sessionId: gone, briefed: false } })
      await writer.append({ type: "lead.chat.retired", payload: { sessionId: gone } })
    }
    await nextTurn()
    // Each real chat joined the list at its creation; this waits for the rows owner to build each of them.
    const shown = async () => new Set((await service.view()).rows.map((row) => row.sessionId))
    await settle(async () => { const rows = await shown(); return working.every((chat) => rows.has(chat)) })
    expect(working.filter((chat) => !service.journal.state().members.has(chat))).toEqual([])
    const perFact = []
    for (let index = 0; index < facts; index += 1) {
      const sessionId = `new-${existing}-${index}`
      const sourceEntryIds: [string] = [`new-entry-${existing}-${index}`]
      const forwarded = { type: "lead.request.forwarded", payload: { leadSessionId: lead, targetSessionId: sessionId, newChat: true, sourceEntryIds } } as const
      counter.take()
      const watches = trace.length
      stored.hold()
      await writer.append({ type: "lead.chat.joined", payload: { sessionId, briefed: false } })
      await writer.append(forwarded)
      const applied = stored.release()
      expect(applied.map((fact) => fact.type)).toEqual(["lead.chat.joined", "lead.request.forwarded"])
      const steps = await collectionWorkOf(async () => {
        for (const fact of applied) {
          stored.deliver(fact)
          await nextTurn()
        }
        // The journal already holds this forward, so the holds rule skips it, and nothing commits.
        expect(await writer.append(forwarded)).toBe(false)
      })
      expect(service.journal.state().forwarded(sessionId, { sourceEntryIds })).toBe(true)
      expect(service.journal.state().members.has(sessionId)).toBe(true)
      const requests = counter.take()
      perFact.push({ steps, requests: requests.length, factsRead: factsRead(requests), watches: trace.length - watches })
    }
    return perFact
  }
  // The first service of the process pays the one-time setup of the session reads that a listed chat's row makes.
  await costs(1, 1)
  const few = await costs(3, 4)
  const many = await costs(30, 4)
  expect(many).toEqual(few)
  for (const cost of many) expect(cost).toMatchObject({ requests: 0, factsRead: 0, watches: 1 })
})

test("the service follows the designation that the control part appended, before the lead chat opens here", async () => {
  // The account's open writes a durable chat and opens no shell here. Its designation reaches this service through
  // the store's broadcast, which the state channel forwards to the executor when an account serves the project.
  const { service, openLead, dispose } = leadHarness(ctx, { control: { projectionReader: asAsyncEventReadSurface(ctx.store), eventWriter: ctx.store, onStored: ctx.store.onStored, openChat: accountOpenChat(ctx) } })
  disposeAll.push(dispose)
  const changes: unknown[] = []
  const unsubscribe = ctx.sessionStore.onChange((changed) => { changes.push(changed) })
  try {
    const lead = await openLead()
    if (lead === null) throw new Error("expected the lead to open")
    await nextTurn()
    // No read of the service's own: the chat profile reads the role synchronously at the lead's first request.
    expect(service.role(lead)).toBe("lead")
    expect(changes).toEqual([])
  } finally { unsubscribe() }
})

test("appends from the control part and the service to the one lead aggregate at the same time all land", async () => {
  const { service, control, openLead } = harness()
  const lead = await openLead()
  if (lead === null) throw new Error("expected the lead to open")
  await Promise.all([
    control.dismiss(lead),
    service.journal.append({ type: "lead.chat.started", payload: { sessionId: "c1", sourceEntryIds: ["entry-1"] } }),
    service.journal.append({ type: "lead.chat.started", payload: { sessionId: "c2", sourceEntryIds: ["entry-2"] } }),
  ])
  // The list's own bookkeeping, such as the lead chat's join at its creation, is left out here.
  expect(ctx.store.read({ aggregateId: "lead" }).map((fact) => fact.type).filter((type) => type !== "lead.chat.joined" && type !== "lead.list.seeded").toSorted()).toEqual(["lead.chat.designated", "lead.chat.dismissed", "lead.chat.started", "lead.chat.started"])
  await service.view()
  expect([...service.journal.state().started.keys()].toSorted()).toEqual(["c1", "c2"])
  expect(service.role(lead)).toBeUndefined()
})

/** The chats of the list other than the lead, with a row or not. */
function members(lead: ReturnType<typeof harness>): string[] {
  const { members: all, designated } = lead.service.journal.state()
  return [...all].filter((sessionId) => sessionId !== designated)
}

/** The chats that the service lists now, in list order. */
async function listed(lead: ReturnType<typeof harness>): Promise<readonly string[]> {
  return (await lead.service.view()).rows.map((row) => row.sessionId)
}

/** A root chat with one entry of the person, so a close keeps it rather than discarding it, as the person opens it in a
 *  client: active, and listed once the service folds its creation. */
async function personChat(lead: ReturnType<typeof harness>): Promise<string> {
  const chat = await supervisor.openSessionRuntime()
  await conversation.appendConversation(chat, [{ kind: "user", content: "Fix the header", origin: "human" }])
  await settle(async () => (await listed(lead)).includes(chat))
  return chat
}

test("every root chat that becomes active joins the list, whoever started it, and a child session never does", async () => {
  const lead = harness()
  const leadId = await lead.openLead()
  if (leadId === null) throw new Error("expected the lead to open")
  const opened = await personChat(lead)
  // A chat that the person opens again from the Sessions list becomes active with no creation in the batch.
  const reopened = await ctx.manager.createChat({ initialState: "inactive" })
  await ctx.manager.updateLifecycleState(reopened, "active")
  const conversationId = (await ctx.manager.read(opened))?.kind === "chat" ? await conversation.chatConversationId(opened) : ""
  const { childSessionId } = await createUnstartedChild(ctx.manager, ctx.baseDir, { sessionId: opened, conversationId })
  await ctx.manager.updateLifecycleState(childSessionId, "active")
  // A fork is an independent root chat that names the chat it came from.
  const forked = await ctx.manager.forkChat(opened)
  await ctx.manager.updateLifecycleState(forked, "active")
  await settle(() => members(lead).includes(reopened) && members(lead).includes(forked))
  await Bun.sleep(20)
  expect(members(lead).toSorted()).toEqual([opened, reopened, forked].toSorted())
  // The reopened chat holds no message, so it is at rest with nothing for the person and shows no row.
  expect([...await listed(lead)].toSorted()).toEqual([opened, forked].toSorted())
  expect(ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).filter((fact) => fact.type === "lead.chat.joined").map((fact) => fact.sessionId)).not.toContain(childSessionId)
})

test("a runtime stop keeps every row, and the person's close or a deletion removes one, also of an inactive chat", async () => {
  const lead = harness()
  await lead.openLead()
  const stopped = await personChat(lead)
  const deleted = await personChat(lead)
  // A stop or a recovery deactivates the chat and records no close.
  await ctx.manager.updateLifecycleState(stopped, "inactive")
  await Bun.sleep(20)
  expect(await listed(lead)).toContain(stopped)

  await supervisor.closeChat(stopped)
  await settle(async () => !(await listed(lead)).includes(stopped))
  expect(await listed(lead)).not.toContain(stopped)
  expect(ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).at(-1)).toMatchObject({ type: "lead.chat.closed", payload: { sessionId: stopped } })

  expect(await supervisor.deleteSession(deleted)).toBe(true)
  await settle(async () => !(await listed(lead)).includes(deleted))
  expect(await listed(lead)).toEqual([])
  // The deletion leaves the list for good: a turn off and on watches, holds, and routes to it no more.
  await lead.setEnabled(false)
  lead.trace.length = 0
  await lead.setEnabled(true)
  await Bun.sleep(20)
  expect(lead.trace).not.toContain(`watch ${deleted}`)
  expect(lead.service.journal.state().members.has(deleted)).toBe(false)

  // The chat joins again when the person makes it active again.
  await ctx.manager.updateLifecycleState(stopped, "active")
  await settle(async () => (await listed(lead)).includes(stopped))
  expect(await listed(lead)).toEqual([stopped])
})

test("while the lead shows a tab close returns its chat to the list, and while the lead is dismissed a tab close works as without a lead", async () => {
  const lead = harness()
  const leadId = await lead.openLead()
  if (leadId === null) throw new Error("expected the lead to open")
  const chat = await personChat(lead)
  const lifecycle = async () => (await ctx.manager.read(chat))?.lifecycleState

  await supervisor.activateSession(chat, { shown: true })
  await supervisor.closeChat(chat, true)
  await supervisor.releaseSession(chat)
  await Bun.sleep(20)
  expect(await lifecycle()).toBe("active")
  expect(await listed(lead)).toEqual([chat])

  await lead.control.dismiss(leadId)
  await settle(() => lead.service.role(leadId) === undefined)
  await supervisor.activateSession(chat, { shown: true })
  await supervisor.closeChat(chat, true)
  await supervisor.releaseSession(chat)
  await settle(async () => await lifecycle() === "inactive")
  expect(await lifecycle()).toBe("inactive")
  await settle(async () => !(await listed(lead)).includes(chat))
  expect(await listed(lead)).toEqual([])
})

test("a finished turn of a chat that a client shows posts no report and removes its row, the chat stays in the list with no row and no new fact across reconciles, and it leaves with one fact once no client shows it", async () => {
  const lead = harness()
  const { chat } = await listedChat(lead)
  await supervisor.activateSession(chat, { shown: true })
  await (await finalMessage(chat, "final-1", "The login page works now."))()
  await settle(async () => ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).some((fact) => fact.type === "lead.result.read") && (await listed(lead)).length === 0)
  expect(ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).at(-1)).toMatchObject({ type: "lead.result.read", payload: { sessionId: chat, entryId: "final-1" } })
  expect(lead.reports).toEqual([])

  // Each turn off and on reads the chat again and joins the active chats: nothing joins or leaves.
  const facts = ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).length
  for (let round = 0; round < 3; round += 1) {
    await lead.setEnabled(false)
    await lead.setEnabled(true)
    await lead.service.view()
    await Bun.sleep(20)
  }
  expect(ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID })).toHaveLength(facts)
  expect(await listed(lead)).toEqual([])
  expect(lead.service.journal.state().members.has(chat)).toBe(true)
  expect((await ctx.manager.read(chat))?.lifecycleState).toBe("active")

  // The client lets go of it, as a closed tab or a connection whose grace ran out does: it closes as a closed tab does
  // and leaves the list with one fact. A second release records nothing.
  await supervisor.releaseSession(chat)
  await settle(async () => !lead.service.journal.state().members.has(chat) && (await ctx.manager.read(chat))?.lifecycleState === "inactive")
  await supervisor.releaseSession(chat)
  await Bun.sleep(20)
  expect([lead.service.journal.state().members.has(chat), (await ctx.manager.read(chat))?.lifecycleState]).toEqual([false, "inactive"])
  expect(ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).slice(facts)).toEqual([expect.objectContaining({ type: "lead.chat.retired", payload: { sessionId: chat } })])
})

// PI-LEAD-006, PI-LEAD-012: the chat reaches the lead by the id that its message_session contract names, and the
// production delivery takes the message with no rule of the lead's own. The wake of an idle recipient is the delivery's
// own rule (session-messaging.test.ts); this harness's lead runner is at rest, so its message waits in its queue.
test("a listed chat's milestone message reaches the shown lead that its contract names, as a message from the chat", async () => {
  const lead = harness()
  const { leadId, chat } = await listedChat(lead)
  const use = await createLeadRuntime({ sessionId: chat, modules: composeModuleServices([["lead", lead.service]]) })?.milestoneUse()
  expect(use).toBe(milestoneMessageUse(leadId))
  // The reader with which the runtime registers each attached runner's live control.
  const reader = ctx.runtime.runSync(EventReaderService)
  const messaging = createSessionMessaging({ manager: ctx.manager, projectionReader: reader, eventWriter: asAsyncEventWriter(ctx.store) }, unusedChildSessionControl())
  const text = "Done: PR 42 is open, and I wait on its CI."
  const sent = await createMessageSessionTool(messaging, undefined, false, true, [use!]).execute({ target: "session", to: leadId, text }, {
    executionCwd: ctx.baseDir, projectRoot: ctx.baseDir, userDataRoot: ctx.baseDir, artifactScopeId: chat, retrievalSessionId: chat,
    sessionId: chat, conversationId: await conversation.chatConversationId(chat), toolUseId: "milestone-1", turnHop: () => 0, conversationHistory: () => [],
  })
  expect(sent.outcome).toBe("ok")
  const queued = ctx.store.readInFlight(leadId, QUEUED_USER_INPUT_IN_FLIGHT_KIND, `msg:${chat}:milestone-1`).map((row) => decodeQueuedUserInputCell(row, leadId))
  expect(queued).toEqual([expect.objectContaining({ text, producer: expect.objectContaining({ kind: "session", sessionId: chat, toolUseId: "milestone-1" }) })])
})

test("a chat that starts while the lead shows holds the lead's rules for its life, and one that starts while the lead is dismissed holds none", async () => {
  const lead = harness()
  // A chat that starts before any lead chat exists, as on a phone, and one that starts while execution is paused,
  // which becomes active only when the person sends it its first message.
  const early = await supervisor.openSessionRuntime()
  expect(await lead.service.settledRole(early)).toBe("briefed")
  const paused = await ctx.manager.createChat({ initialState: "inactive" })
  await ctx.manager.updateLifecycleState(paused, "active")
  await settle(() => lead.service.journal.state().members.has(paused))
  expect(await lead.service.settledRole(paused)).toBe("briefed")
  const leadId = await lead.openLead()
  if (leadId === null) throw new Error("expected the lead to open")
  const briefed = await supervisor.openSessionRuntime()
  // The chat's first request reads the role after the service folded the chat's creation.
  expect(await lead.service.settledRole(briefed)).toBe("briefed")

  await lead.control.dismiss(leadId)
  await settle(() => lead.service.role(leadId) === undefined)
  const plain = await supervisor.openSessionRuntime()
  expect(await lead.service.settledRole(plain)).toBeUndefined()
  // The lead shows again, and neither chat's role changes.
  await lead.openLead("command")
  await settle(() => lead.service.role(leadId) === "lead")
  expect(lead.service.role(briefed)).toBe("briefed")
  expect(lead.service.role(plain)).toBeUndefined()
})

test("the first run of a list joins every active root chat and each started chat that still needs a look, once", async () => {
  // The project as the lead left it before it kept a list: only started facts, and chats at rest.
  const active = await ctx.manager.createChat({ initialState: "active" })
  const unread = await ctx.manager.createChat({ initialState: "inactive" })
  const done = await ctx.manager.createChat({ initialState: "inactive" })
  await conversation.appendConversation(unread, [{ kind: "user", content: "Fix it", origin: "human" }, { kind: "assistant", content: [{ type: "text", text: "Fixed." }] }])
  await conversation.appendConversation(done, [{ kind: "user", content: "Fix it", origin: "human" }])
  const writer = createLeadJournal({ reader: asAsyncEventReadSurface(ctx.store), writer: ctx.store })
  await writer.append({ type: "lead.chat.started", payload: { sessionId: unread, sourceEntryIds: ["entry-1"] } })
  await writer.append({ type: "lead.chat.started", payload: { sessionId: done, sourceEntryIds: ["entry-2"] } })
  // The person read the done chat's result.
  await (await finalMessage(done, "final-done", "Fixed."))()
  await writer.append({ type: "lead.result.read", payload: { sessionId: done, entryId: "final-done" } })

  const lead = harness()
  await settle(async () => members(lead).length === 2 && (await listed(lead)).length === 1)
  expect(members(lead).toSorted()).toEqual([active, unread].toSorted())
  // The active chat holds no message, so only the unread result shows a row.
  expect(await listed(lead)).toEqual([unread])
  const joins = () => ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).filter((fact) => fact.type === "lead.chat.joined").map((fact) => fact.payload)
  expect(joins()).toEqual(expect.arrayContaining([{ sessionId: active, briefed: false }, { sessionId: unread, briefed: false }]))
  expect(joins()).toHaveLength(2)

  // A later start reads the joins and seeds nothing again.
  await lead.dispose()
  disposeAll = disposeAll.filter((dispose) => dispose !== lead.dispose)
  const again = harness()
  await settle(async () => (await listed(again)).length === 1)
  await Bun.sleep(20)
  expect(joins()).toHaveLength(2)
})

test("a result that finishes in a chat that a client shows while the lead is dismissed is read there, and the lead that shows again gets no report of it", async () => {
  const lead = harness()
  const { leadId, chat } = await listedChat(lead)
  await lead.control.dismiss(leadId)
  await settle(() => lead.service.role(leadId) === undefined)
  await supervisor.activateSession(chat, { shown: true })
  await (await finalMessage(chat, "final-1", "The login page works now."))()
  await settle(() => ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).some((fact) => fact.type === "lead.result.read"))
  await supervisor.releaseSession(chat)

  await lead.openLead("command")
  await settle(() => lead.service.role(leadId) === "lead")
  await Bun.sleep(20)
  expect(lead.reports).toEqual([])
  expect(ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).filter((fact) => fact.type === "lead.result.read").map((fact) => fact.payload)).toEqual([{ sessionId: chat, entryId: "final-1" }])
})

test("a chat that became active while the module was off joins when it turns on, and a deleted member leaves then", async () => {
  const lead = harness()
  const leadId = await lead.openLead()
  const deleted = await personChat(lead)
  await lead.setEnabled(false)
  const missed = await ctx.manager.createChat({ initialState: "active" })
  expect(await supervisor.deleteSession(deleted)).toBe(true)
  await Bun.sleep(20)
  await lead.setEnabled(true)
  await settle(() => members(lead).includes(missed))
  await Bun.sleep(20)
  expect(members(lead)).toEqual([missed])
  expect(lead.service.journal.state().members.has(deleted)).toBe(false)
  // PI-LEAD-012: the adopted chat holds none of the lead's prompt rules, yet as a chat in the list it may message the
  // lead at a milestone.
  expect(lead.service.role(missed)).toBeUndefined()
  const milestones = (sessionId: string) => createLeadRuntime({ sessionId, modules: composeModuleServices([["lead", lead.service]]) })?.milestoneUse()
  expect(await milestones(missed)).toBe(milestoneMessageUse(leadId!))
  expect(await milestones(deleted)).toBeUndefined()
})

test("a first run that stopped after its first join finishes at the next start", async () => {
  const first = await ctx.manager.createChat({ initialState: "active" })
  const second = await ctx.manager.createChat({ initialState: "active" })
  const unread = await ctx.manager.createChat({ initialState: "inactive" })
  await conversation.appendConversation(unread, [{ kind: "user", content: "Fix it", origin: "human" }, { kind: "assistant", content: [{ type: "text", text: "Fixed." }] }])
  const writer = createLeadJournal({ reader: asAsyncEventReadSurface(ctx.store), writer: ctx.store })
  await writer.append({ type: "lead.chat.started", payload: { sessionId: unread, sourceEntryIds: ["entry-1"] } })
  // The earlier run joined one chat and stopped.
  await writer.append({ type: "lead.chat.joined", payload: { sessionId: first, briefed: false } })

  const lead = harness()
  await settle(() => members(lead).length === 3)
  expect(members(lead).toSorted()).toEqual([first, second, unread].toSorted())
  await settle(() => lead.service.journal.state().seeded)
  expect(ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).filter((fact) => fact.type === "lead.list.seeded")).toHaveLength(1)
})

/** A chat that an earlier process left in the list, inactive as every chat is after a restart. With `final`, the chat
 *  ended its turn with a final answer, which the person read when `read` is set. */
async function earlierMember(writer: ReturnType<typeof createLeadJournal>, final?: { readonly id: string; readonly read: boolean }): Promise<string> {
  const chat = await ctx.manager.createChat({ conversationId: ctx.manager.allocateId(), executionCwd: ctx.baseDir, initialState: "inactive" })
  await conversation.appendConversation(chat, [{ kind: "user", content: "Fix it", origin: "human" }])
  if (final) await (await finalMessage(chat, final.id, "Fixed."))()
  if (final?.read) await writer.append({ type: "lead.result.read", payload: { sessionId: chat, entryId: final.id } })
  await writer.append({ type: "lead.chat.joined", payload: { sessionId: chat, briefed: false } })
  return chat
}

test("after a restart a member at rest with nothing for the person leaves the list with one fact, and a member that needs the person stays", async () => {
  const writer = createLeadJournal({ reader: asAsyncEventReadSurface(ctx.store), writer: ctx.store })
  await writer.append({ type: "lead.list.seeded", payload: {} })
  // An open turn that no runner works on reads as failed.
  const failed = await earlierMember(writer)
  const unread = await earlierMember(writer, { id: "final-unread", read: false })
  const read = await earlierMember(writer, { id: "final-read", read: true })
  const retired = () => ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).flatMap((fact) => fact.type === "lead.chat.retired" ? [fact.payload.sessionId] : [])

  const lead = harness()
  await settle(() => retired().includes(read))
  expect(members(lead).toSorted()).toEqual([failed, unread].toSorted())
  expect(retired()).toEqual([read])
  expect((await lead.service.view()).rows.map((row) => [row.sessionId, row.state]).toSorted()).toEqual([[failed, "failed"], [unread, "result"]].toSorted())
})

test("a chat that left the list at rest joins again when the person opens it, and shows its row while it works", async () => {
  const lead = harness()
  const { chat } = await listedChat(lead)
  // A final answer that follows the person's message, as a real turn writes it.
  await conversation.appendConversation(chat, [{ kind: "assistant", content: [{ type: "text", text: "Fixed." }] }])
  // The lead reads the report, and the chat at rest leaves the list and closes.
  await settle(async () => members(lead).length === 0 && (await ctx.manager.read(chat))?.lifecycleState === "inactive")
  expect([members(lead), (await ctx.manager.read(chat))?.lifecycleState]).toEqual([[], "inactive"])

  // A tab open records the chat as active, as the control part does, and attaches its runner.
  await ctx.manager.updateLifecycleState(chat, "active")
  expect(await supervisor.activateSession(chat, { shown: true })).toBe(true)
  await settle(() => members(lead).includes(chat) && ctx.sessionStore.get(chat)?.runner != null)
  // The chat stays in the list with no row while it rests, and shows its row once a turn works.
  expect(await listed(lead)).toEqual([])
  ctx.sessionStore.updateEntry(chat, { runnerState: "streaming", streamPhase: "thinking" })
  await settle(async () => (await listed(lead)).includes(chat))
  expect((await lead.service.view()).rows).toEqual([expect.objectContaining({ sessionId: chat, state: "working" })])
  expect(ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).filter((fact) => fact.type === "lead.chat.joined" && fact.payload.sessionId === chat)).toHaveLength(2)
})

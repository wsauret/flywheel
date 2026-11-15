import { afterEach, beforeEach, expect, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { asAsyncEventReadSurface, asAsyncEventWriter, type StoredFact } from "../../../../../src/infra/event-store-types.js"
import type { RuntimeSupervisor } from "../../../../../src/orchestration/app-service/runtime-supervisor-types.js"
import { QUEUED_USER_INPUT_IN_FLIGHT_KIND } from "../../../../../src/orchestration/session/conversation/queued-user-inputs.js"
import { LEAD_AGGREGATE_ID } from "../../../../../src/orchestration/modules/lead/facts.js"
import { createLeadJournal } from "../../../../../src/orchestration/modules/lead/journal.js"
import { leadChatsCursor, leadReportCall } from "../../../../../src/protocol/modules/lead.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, supervisorConversationFixture, type SupervisorTestContext } from "../../../../fixtures/runtime-supervisor-fixtures.js"
import { countStateRequests, factsRead } from "../../../../helpers/state-requests.js"
import { accountOpenChat, leadHarness } from "./_lead-harness.js"

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

test("while the module is off a started chat's question gives no notice, and after it turns on a question gives one", async () => {
  const { service, openLead, sessionEvents, notices, setEnabled } = harness()
  const lead = await openLead()
  expect(lead).not.toBeNull()
  await service.journal.append({ type: "lead.chat.started", payload: { sessionId: "c", sourceEntryIds: ["entry-1"] } })
  await supervisor.ensureChatRunner(lead!)

  await setEnabled(false)
  sessionEvents.report("c", "asked")
  await Bun.sleep(1)
  expect(notices).toEqual([])

  await setEnabled(true)
  sessionEvents.report("c", "asked")
  await Bun.sleep(1)
  expect(notices).toEqual([lead!])
})

test("a chat that the lead started posts its report to the lead once, as a message from the chat, instead of a turn-end notice, and the report counts as read", async () => {
  const { service, openLead, sessionEvents, notices, trace, reports } = harness()
  const lead = await openLead()
  if (lead === null) throw new Error("expected the lead to open")
  await conversation.appendConversation(lead, [
    { kind: "user", content: "Fix the login page", origin: "human" },
    { kind: "assistant", content: [{ type: "tool_use", id: "route-1", name: "route_request", input: { kind: "new" } }] },
  ])
  const routed = await service.route({ leadSessionId: lead, kind: "new", earlierTurns: 0 })
  if (!routed.ok) throw new Error(routed.reason)
  await supervisor.ensureChatRunner(lead)
  sessionEvents.report(routed.sessionId, "turn_ended")
  await Bun.sleep(1)
  expect(notices).toEqual([])

  const report = "The login page works now.\nThe sign-in form had two handlers."
  const final = "final-1"
  const conversationId = await conversation.chatConversationId(routed.sessionId)
  await asAsyncEventWriter(ctx.store).append({
    aggregateId: `conversation:${conversationId}`, type: "chat.entries.appended", version: 7, timestamp: Date.now(), actor: "flywheel", sessionId: routed.sessionId,
    payload: { conversationId, entries: [{ kind: "message", id: final, parentId: null, timestamp: new Date().toISOString(), message: { kind: "assistant", content: [{ type: "text", text: report }] } }] },
  })
  for (let attempt = 0; attempt < 200 && !trace.some((line) => line.startsWith("report")); attempt += 1) await Bun.sleep(5)
  expect(trace.filter((line) => line.startsWith("report"))).toEqual([`report ${routed.sessionId} ${leadReportCall(final)}`])
  for (let attempt = 0; attempt < 200 && (await service.view()).rows.some((row) => row.state === "result"); attempt += 1) await Bun.sleep(5)
  expect((await service.view()).rows.filter((row) => row.state === "result")).toEqual([])
  expect(ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).at(-1)).toMatchObject({ type: "lead.result.read", payload: { sessionId: routed.sessionId, entryId: final } })
  // The runtime's delivery took the whole report to the lead as a message from the chat.
  expect(reports).toEqual([{ fromSessionId: routed.sessionId, toSessionId: lead, call: leadReportCall(final), text: report, status: expect.stringMatching(/^(delivered|held)$/) }])
  // Reading the rows again posts nothing more.
  await Bun.sleep(20)
  expect(trace.filter((line) => line.startsWith("report"))).toHaveLength(1)
})

/** Routes one request from a new lead to a new chat, with the lead's runner started, and answers both ids. */
async function routedChat(lead: ReturnType<typeof harness>): Promise<{ readonly leadId: string; readonly chat: string }> {
  const leadId = await lead.openLead()
  if (leadId === null) throw new Error("expected the lead to open")
  await conversation.appendConversation(leadId, [
    { kind: "user", content: "Fix the login page", origin: "human" },
    { kind: "assistant", content: [{ type: "tool_use", id: "route-1", name: "route_request", input: { kind: "new" } }] },
  ])
  const routed = await lead.service.route({ leadSessionId: leadId, kind: "new", earlierTurns: 0 })
  if (!routed.ok) throw new Error(routed.reason)
  await supervisor.ensureChatRunner(leadId)
  return { leadId, chat: routed.sessionId }
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
  const { leadId, chat } = await routedChat(first)
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
  expect(ctx.store.read({ aggregateId: LEAD_AGGREGATE_ID }).at(-1)).toMatchObject({ type: "lead.result.read", payload: { sessionId: chat, entryId: "final-1" } })
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

test("each applied lead fact costs work that grows with neither the started chats nor the history", async () => {
  /** The state requests, the watches, and the collection work of the service, the control part, and the journal for
   *  each of `facts` chats that another writer starts and forwards to, and checks again, after `existing` ones. */
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
    for (let index = 0; index < existing; index += 1) {
      // A real chat, so the rows owner follows it and a walk of the rows would show in the collection work.
      const chat = await supervisor.openSessionRuntime()
      await writer.append({ type: "lead.chat.started", payload: { sessionId: chat, sourceEntryIds: [`old-entry-${existing}-${index}`] } })
      await writer.append({ type: "lead.request.forwarded", payload: { leadSessionId: lead, targetSessionId: chat, newChat: true, sourceEntryIds: [`old-entry-${existing}-${index}`] } })
    }
    await nextTurn()
    // The roster waits for the rows owner to build each started chat.
    expect(await service.progress(undefined)).toMatchObject({ kind: "roster", chats: { length: existing } })
    const perFact = []
    for (let index = 0; index < facts; index += 1) {
      const sessionId = `new-${existing}-${index}`
      const sourceEntryIds: [string] = [`new-entry-${existing}-${index}`]
      const forwarded = { type: "lead.request.forwarded", payload: { leadSessionId: lead, targetSessionId: sessionId, newChat: true, sourceEntryIds } } as const
      counter.take()
      const watches = trace.length
      stored.hold()
      await writer.append({ type: "lead.chat.started", payload: { sessionId, sourceEntryIds } })
      await writer.append(forwarded)
      const applied = stored.release()
      expect(applied.map((fact) => fact.type)).toEqual(["lead.chat.started", "lead.request.forwarded"])
      const steps = await collectionWorkOf(async () => {
        for (const fact of applied) {
          stored.deliver(fact)
          await nextTurn()
        }
        // The journal already holds this forward, so the holds rule skips it, and nothing commits.
        expect(await writer.append(forwarded)).toBe(false)
      })
      expect(service.journal.state().forwarded(sessionId, sourceEntryIds)).toBe(true)
      expect(service.journal.state().startedBy(sourceEntryIds)).toBe(sessionId)
      const requests = counter.take()
      perFact.push({ steps, requests: requests.length, factsRead: factsRead(requests), watches: trace.length - watches })
    }
    return perFact
  }
  // The first service of the process pays the one-time setup of the session reads that a started chat's row makes.
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
  expect(ctx.store.read({ aggregateId: "lead" }).map((fact) => fact.type).toSorted()).toEqual(["lead.chat.designated", "lead.chat.dismissed", "lead.chat.started", "lead.chat.started"])
  await service.view()
  expect([...service.journal.state().started.keys()].toSorted()).toEqual(["c1", "c2"])
  expect(service.role(lead)).toBeUndefined()
})

test("a started chat whose result the person read closes once it is at rest while no client shows it, and a route to it opens it again and runs the turn", async () => {
  const lead = harness()
  const { leadId, chat } = await routedChat(lead)
  const lifecycle = async () => (await ctx.manager.read(chat))?.lifecycleState
  expect(await lifecycle()).toBe("active")

  // The report reads the result, so the row leaves and nothing holds the chat open. The final message continues the
  // chat's branch, so the closed chat can open again.
  await conversation.appendConversation(chat, [{ kind: "assistant", content: [{ type: "text", text: "The login page works now." }] }])
  await settle(async () => await lifecycle() === "inactive")
  expect((await lead.service.view()).rows.map((row) => row.sessionId)).not.toContain(chat)
  expect(await lifecycle()).toBe("inactive")

  await conversation.appendConversation(leadId, [
    { kind: "user", content: "Also fix the signup page", origin: "human" },
    { kind: "assistant", content: [{ type: "tool_use", id: "route-2", name: "route_request", input: { kind: "existing", chat } }] },
  ])
  const routed = await lead.service.route({ leadSessionId: leadId, kind: "existing", chat, earlierTurns: 0 })
  if (!routed.ok) throw new Error(routed.reason)
  await settle(async () => await lifecycle() === "active")
  expect(await lifecycle()).toBe("active")
  // The chat's new runner starts its turn on the person's forwarded message.
  await settle(() => lead.inputs.some((input) => input.sessionId === chat))
  expect(JSON.stringify(lead.inputs.filter((input) => input.sessionId === chat))).toContain("Also fix the signup page")
})

test("a started chat that a client shows stays open after its row leaves", async () => {
  const lead = harness()
  const { chat } = await routedChat(lead)
  await supervisor.activateSession(chat, { shown: true })
  await (await finalMessage(chat, "final-1", "The login page works now."))()
  await settle(async () => !(await lead.service.view()).rows.some((row) => row.sessionId === chat))
  await Bun.sleep(20)
  expect((await ctx.manager.read(chat))?.lifecycleState).toBe("active")
})

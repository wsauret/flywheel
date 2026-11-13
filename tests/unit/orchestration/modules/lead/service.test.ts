import { afterEach, beforeEach, expect, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { asAsyncEventReadSurface } from "../../../../../src/infra/event-store-types.js"
import { composeModuleServices } from "../../../../../src/infra/module-service.js"
import type { RuntimeSupervisor } from "../../../../../src/orchestration/app-service/runtime-supervisor-types.js"
import { leadModule } from "../../../../../src/orchestration/modules/lead/module.js"
import { createLeadJournal } from "../../../../../src/orchestration/modules/lead/journal.js"
import type { LeadService } from "../../../../../src/orchestration/modules/lead/service.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, supervisorConversationFixture, type SupervisorTestContext } from "../../../../fixtures/runtime-supervisor-fixtures.js"
import { testDirectories } from "../../../../helpers/directories.js"
import { countStateRequests, factsRead } from "../../../../helpers/state-requests.js"
import { leadHarness } from "./_lead-harness.js"

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

function harness(projectionReader = asAsyncEventReadSurface(ctx.store)) {
  const lead = leadHarness(ctx, { projectionReader })
  supervisor = lead.supervisor
  disposeAll.push(lead.dispose)
  return lead
}

function leadFacts() {
  return ctx.store.read({ aggregateId: "lead" }).map((fact) => ({ type: fact.type, sessionId: fact.sessionId, payload: fact.payload }))
}

async function chatsNamedLead(): Promise<number> {
  return (await ctx.manager.listMetadata()).sessions.filter((row) => row.kind === "chat" && row.name === "Lead").length
}

test("a launch on an empty store opens one chat named Lead and designates it once", async () => {
  const { service } = harness()
  const sessionId = await service.open("launch")
  expect(sessionId).not.toBeNull()
  expect(await chatsNamedLead()).toBe(1)
  expect(leadFacts()).toEqual([{ type: "lead.chat.designated", sessionId: "lead", payload: { sessionId } }])

  expect(await service.open("launch")).toBe(sessionId)
  expect(leadFacts()).toHaveLength(1)
})

test("two launches at the same time leave one chat named Lead, and both answer it", async () => {
  const { service } = harness()
  const [first, second] = await Promise.all([service.open("launch"), service.open("launch")])
  expect(first).not.toBeNull()
  expect(second).toBe(first)
  expect(await chatsNamedLead()).toBe(1)
  expect(leadFacts()).toHaveLength(1)
})

test("a launch and the lead command at the same time on a dismissed lead: the command ends the dismissal", async () => {
  const { service } = harness()
  const sessionId = await service.open("launch")
  if (sessionId === null) throw new Error("expected the lead to open")
  await service.dismiss(sessionId)

  expect(await Promise.all([service.open("launch"), service.open("command")])).toEqual([null, sessionId])
  expect(leadFacts().map((fact) => fact.type)).toEqual(["lead.chat.designated", "lead.chat.dismissed", "lead.chat.designated"])
  expect(await service.view()).toEqual({ leadSessionId: sessionId, dismissed: false, rows: [] })
})

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
  expect(patches).toEqual([])
})

test("a dismissed lead does not open on launch, and the lead command designates it again", async () => {
  const { service } = harness()
  const sessionId = await service.open("launch")
  expect(sessionId).not.toBeNull()
  expect(await service.dismiss(sessionId!)).toBe(sessionId)
  expect((await service.view()).dismissed).toBe(true)

  expect(await service.open("launch")).toBeNull()
  expect(await service.open("command")).toBe(sessionId)
  expect(leadFacts().map((fact) => fact.type)).toEqual(["lead.chat.designated", "lead.chat.dismissed", "lead.chat.designated"])
  expect(await service.view()).toEqual({ leadSessionId: sessionId, dismissed: false, rows: [] })
})

test("a launch after the person deleted the lead chat opens and designates a new chat", async () => {
  const { service } = harness()
  const removed = await service.open("launch")
  expect(removed).not.toBeNull()
  await supervisor.deleteSession(removed!)
  expect(await ctx.manager.read(removed!)).toBeNull()

  const opened = await service.open("launch")
  expect(opened).not.toBeNull()
  expect(opened).not.toBe(removed)
  expect(leadFacts()).toEqual([
    { type: "lead.chat.designated", sessionId: "lead", payload: { sessionId: removed } },
    { type: "lead.chat.designated", sessionId: "lead", payload: { sessionId: opened } },
  ])
})

test("while the module is off a started chat's report gives no notice, and after it turns on a report gives one", async () => {
  const { service, sessionEvents, notices, setEnabled } = harness()
  const lead = await service.open("launch")
  expect(lead).not.toBeNull()
  await service.journal.append({ type: "lead.chat.started", payload: { sessionId: "c", sourceEntryIds: ["entry-1"] } })
  await supervisor.ensureChatRunner(lead!)

  await setEnabled(false)
  sessionEvents.report("c", "turn_ended")
  await Bun.sleep(1)
  expect(notices).toEqual([])

  await setEnabled(true)
  sessionEvents.report("c", "turn_ended")
  await Bun.sleep(1)
  expect(notices).toEqual([lead!])
})

test("a chat that the lead started reports its first turn end to the lead", async () => {
  const { service, sessionEvents, notices } = harness()
  const lead = await service.open("launch")
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
  expect(notices).toEqual([lead])
})

type Collection = readonly unknown[] | ReadonlyMap<unknown, unknown> | ReadonlySet<unknown>

/** Resolves on the next turn of the event loop. The service folds each stored batch in promise continuations that
 *  nothing awaits, with no timer and no input or output, and every continuation runs before the next turn, whatever
 *  the load of the machine. */
const nextTurn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

/** The in-memory collection work that `work` causes until the next turn after it: each step of a Map or Set
 *  iterator, including the iteration that a spread or a copy does, each element that an array search or transform
 *  visits, and each Map or Set lookup. A scan, a copy, or a linear search over the started chats shows as a count that
 *  grows with them. Only calls in the asynchronous context of `work` count: its continuations, the store commits that
 *  it starts, and the deliveries of their stored facts. Work of earlier setup, or of another test file that the same
 *  process runs, never counts, also when it lands inside the window. */
async function collectionWorkOf(work: () => Promise<void>): Promise<number> {
  const scope = new AsyncLocalStorage<true>()
  let steps = 0
  const count = (cost: number): void => { if (scope.getStore()) steps += cost }
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

test("each applied lead fact costs work that grows with neither the started chats nor the history", async () => {
  /** The state requests, the watches, and the collection work of the service and the journal for each of `facts`
   *  chats that another writer starts and forwards to, and checks again, after `existing` ones. */
  async function costs(existing: number, facts: number) {
    const counter = countStateRequests(asAsyncEventReadSurface(ctx.store))
    const { service, trace, dispose } = harness(counter.reader)
    // Only this run's service observes its facts.
    disposeAll = disposeAll.filter((other) => other !== dispose)
    await using _service = { [Symbol.asyncDispose]: dispose }
    const writer = createLeadJournal({ reader: asAsyncEventReadSurface(ctx.store), writer: ctx.store })
    const lead = await service.open("launch")
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
      const steps = await collectionWorkOf(async () => {
        await writer.append({ type: "lead.chat.started", payload: { sessionId, sourceEntryIds } })
        await writer.append(forwarded)
        // The journal already holds this forward, so the holds rule skips it.
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

test("the lead command focuses the lead chat", async () => {
  const { service } = harness()
  const command = leadModule.contributions.find((contribution) => contribution.domain === "commands")
  if (command?.domain !== "commands" || !("execute" in command.value)) throw new Error("expected the lead command")
  const outcome = await command.value.execute({
    session: undefined,
    directories: testDirectories(ctx.baseDir),
    authDirectory: () => ctx.baseDir,
    projectionReader: asAsyncEventReadSurface(ctx.store),
    runOwnedCommand: undefined,
    modules: composeModuleServices([[leadModule.id, service satisfies LeadService]]),
  })
  const { leadSessionId } = await service.view()
  if (leadSessionId === null) throw new Error("expected the command to designate the lead")
  expect(outcome).toEqual({ kind: "focus-session", sessionId: leadSessionId })
})

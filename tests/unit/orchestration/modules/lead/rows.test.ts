import { afterEach, beforeEach, expect, test } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface } from "../../../../../src/infra/event-store-types.js"
import { heldProjection } from "../../../../../src/infra/projection-registry.js"
import { createLeadJournal } from "../../../../../src/orchestration/modules/lead/journal.js"
import { turnEndEntryId } from "../../../../../src/orchestration/session/conversation/turn-end-record.js"
import { leadNeedsPerson, type LeadRow } from "../../../../../src/protocol/modules/lead.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, supervisorConversationFixture, type SupervisorTestContext } from "../../../../fixtures/runtime-supervisor-fixtures.js"
import { leadHarness } from "./_lead-harness.js"

let ctx: SupervisorTestContext
let dispose: () => Promise<void> = async () => {}
beforeEach(() => { ctx = createSupervisorTestContext() })
afterEach(async () => {
  await dispose()
  dispose = async () => {}
  await disposeSupervisorTestContext(ctx)
})
const conversation = supervisorConversationFixture(() => ctx)

const CONTEXT = "The login page has two forms.\nBoth call one handler."
const QUESTION = { question: "Which form should change?", header: "Form", multiSelect: false, choices: [{ kind: "option" as const, choiceId: "a", label: "Sign-in form" }] }

/** A started lead service over one reader that the test also holds, and a second writer of lead facts. */
function rowsHarness(reader: AsyncEventStateReadSurface = asAsyncEventReadSurface(ctx.store), runnerStartup?: Promise<void>) {
  const lead = leadHarness(ctx, { projectionReader: reader, ...(runnerStartup ? { runnerStartup } : {}) })
  dispose = lead.dispose
  const writer = createLeadJournal({ reader: asAsyncEventReadSurface(ctx.store), writer: ctx.store })
  /** The newest row patch for `sessionId`: the row, `removed`, or undefined before any. */
  const latest = (sessionId: string): LeadRow | "removed" | undefined => {
    for (const { payload } of lead.patches.toReversed()) {
      if (payload.kind === "lead.row.updated" && payload.row.sessionId === sessionId) return payload.row
      if (payload.kind === "lead.row.removed" && payload.sessionId === sessionId) return "removed"
    }
    return undefined
  }
  async function eventually<T>(read: () => T, accept: (value: T) => boolean): Promise<T> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const value = read()
      if (accept(value)) return value
      await Bun.sleep(5)
    }
    return read()
  }
  const startChat = async (): Promise<string> => {
    const chat = await lead.supervisor.openSessionRuntime()
    await writer.append({ type: "lead.chat.started", payload: { sessionId: chat, sourceEntryIds: [`entry-${chat}`] } })
    return chat
  }
  /** Appends one batch with these exact entries to the chat's conversation. */
  const appendEntries = async (chat: string, entries: readonly { readonly [key: string]: unknown }[]): Promise<void> => {
    const conversationId = await conversation.chatConversationId(chat)
    const timestamp = new Date().toISOString()
    await asAsyncEventWriter(ctx.store).append({
      aggregateId: `conversation:${conversationId}`, type: "chat.entries.appended", version: 7, timestamp: Date.now(), actor: "flywheel", sessionId: chat,
      payload: { conversationId, entries: entries.map((entry) => ({ parentId: null, timestamp, ...entry })) },
    })
  }
  /** Routes the person's message from the lead to a new chat, whose runner then starts. */
  const routeToNewChat = async (text: string): Promise<string> => {
    const leadSessionId = await lead.openLead()
    if (leadSessionId === null) throw new Error("expected the lead to open")
    await conversation.appendConversation(leadSessionId, [
      { kind: "user", content: text, origin: "human" },
      { kind: "assistant", content: [{ type: "tool_use", id: "route-1", name: "route_request", input: { kind: "new" } }] },
    ])
    const routed = await lead.service.route({ leadSessionId, kind: "new", earlierTurns: 0 })
    if (!routed.ok) throw new Error(routed.reason)
    return routed.sessionId
  }
  const published = (sessionId: string): readonly LeadRow[] => lead.patches.flatMap(({ payload }) => payload.kind === "lead.row.updated" && payload.row.sessionId === sessionId ? [payload.row] : [])
  return { lead, reader, latest, eventually, startChat, appendEntries, routeToNewChat, published }
}

test("a question, its answer and a live turn, a final answer read by the person: question, working, result, done", async () => {
  const { lead, latest, eventually, startChat, appendEntries } = rowsHarness()
  const chat = await startChat()
  await appendEntries(chat, [
    { kind: "message", id: "u1", message: { kind: "user", content: "Fix the login page", origin: "human" } },
    { kind: "message", id: "a1", message: { kind: "assistant", content: [{ type: "text", text: "Design is ready.\nDetails..." }, { type: "tool_use", id: "ask-1", name: "ask_user", input: { context: CONTEXT, question: QUESTION.question } }] } },
  ])
  await ctx.store.append({
    aggregateId: `session:${chat}`, sessionId: chat, type: "agent_input.requested", version: 3, actor: "agent", timestamp: 1_000,
    payload: { interactionId: "ask-1", conversationId: await conversation.chatConversationId(chat), toolUseId: "ask-1", request: [QUESTION] },
  })
  const question = await eventually(() => latest(chat), (row) => typeof row === "object" && row.state === "question")
  // A question row shows the question's own first line.
  expect(question).toMatchObject({ state: "question", status: QUESTION.question, waitingSince: 1_000 })

  await ctx.store.append({
    aggregateId: `session:${chat}`, sessionId: chat, type: "agent_input.answered", version: 3, actor: "user", timestamp: 2_000,
    payload: { interactionId: "ask-1", answers: { q0: { kind: "choice", selections: [{ choiceId: "a" }], text: "Sign-in form" } } },
  })
  ctx.sessionStore.updateEntry(chat, { runnerState: "streaming", streamPhase: "thinking" })
  const working = await eventually(() => latest(chat), (row) => typeof row === "object" && row.state === "working")
  expect(working).toMatchObject({ state: "working" })
  // A working row shows the newest tool call as its transcript states it.
  await conversation.appendConversation(chat, [{ kind: "assistant", content: [{ type: "tool_use", id: "edit-1", name: "edit", input: { path: "/repo/src/core.py", edits: [] } }] }])
  expect(await eventually(() => latest(chat), (row) => typeof row === "object" && row.status.startsWith("Edited"))).toMatchObject({ state: "working", status: "Edited core.py" })
  expect(working).not.toHaveProperty("question")
  expect(working).not.toHaveProperty("waitingSince")

  await conversation.appendConversation(chat, [{ kind: "assistant", content: [{ type: "text", text: "Changed the sign-in form." }] }])
  ctx.sessionStore.updateEntry(chat, { runnerState: "idle", streamPhase: null })
  const result = await eventually(() => latest(chat), (row) => typeof row === "object" && row.state === "result")
  if (typeof result !== "object" || result.result === undefined) throw new Error("expected a result row")
  expect(result.status).toBe("Changed the sign-in form.")
  expect((await lead.service.view()).rows).toEqual([result])

  expect(await lead.service.markRead(chat, result.result.entryId)).toEqual({ ok: true })
  // Reading the result keeps the row, done, with the result's first line.
  const done = await eventually(() => latest(chat), (row) => typeof row === "object" && row.state === "done")
  expect(done).toMatchObject({ state: "done", status: "Changed the sign-in form." })
  expect(done).not.toHaveProperty("result")
  expect(ctx.store.read({ aggregateId: "lead" }).at(-1)).toMatchObject({ type: "lead.result.read", payload: { sessionId: chat, entryId: result.result.entryId } })
  if (typeof done !== "object") throw new Error("expected a done row")
  expect((await lead.service.view()).rows).toEqual([done])
})

test("a routed chat reads working while its runner starts and after the runner attaches at rest, and never failed", async () => {
  const runnerStartup = Promise.withResolvers<void>()
  const { lead, latest, eventually, routeToNewChat, published } = rowsHarness(undefined, runnerStartup.promise)
  dispose = async () => { runnerStartup.resolve(); await lead.dispose() }
  const chat = await routeToNewChat("Fix the login page")
  expect(lead.supervisor.runtimeState(chat)).toEqual({ kind: "starting" })
  expect(ctx.sessionStore.get(chat)?.runner).toBeNull()
  expect(await eventually(() => latest(chat), (row) => typeof row === "object")).toMatchObject({ state: "working", status: "working" })
  expect(leadNeedsPerson(await lead.service.view())).toBe(0)

  // The store announces the attached runner at rest before the start settles and the runner takes the drained message.
  runnerStartup.resolve()
  await eventually(() => ctx.sessionStore.get(chat)?.runner ?? null, (runner) => runner !== null)
  expect(latest(chat)).toMatchObject({ state: "working" })
  expect(published(chat).map((row) => row.state)).not.toContain("failed")
})

test("a runner start that failed for a chat that a client shows reads failed with no entry", async () => {
  const runnerStartup = Promise.withResolvers<void>()
  const { lead, latest, eventually, routeToNewChat } = rowsHarness(undefined, runnerStartup.promise)
  const chat = await routeToNewChat("Fix the login page")
  // A shown chat keeps its entry, with no runner, after the failed start.
  const shown = lead.supervisor.activateSession(chat, { shown: true })
  runnerStartup.reject(new Error("no runner"))
  await shown.catch(() => false)
  expect(await eventually(() => lead.supervisor.runtimeState(chat)?.kind, (kind) => kind === "failed")).toBe("failed")
  expect(ctx.sessionStore.get(chat)?.runner).toBeNull()
  expect(await eventually(() => latest(chat), (row) => typeof row === "object" && row.state === "failed")).toMatchObject({ state: "failed", status: "failed" })
  expect(leadNeedsPerson(await lead.service.view())).toBe(1)
})

test("a visible interrupt is cut, a crash record is failed with its entry, and an open turn with no live work and no record is failed with no entry", async () => {
  const { latest, eventually, startChat, appendEntries } = rowsHarness()
  const cut = await startChat()
  const crashed = await startChat()
  const open = await startChat()
  const interrupt = turnEndEntryId({ reason: "paused", pausedBy: "person" }, "k1")
  const crash = turnEndEntryId({ reason: "crash" }, "k2")
  await appendEntries(cut, [
    { kind: "message", id: "u1", message: { kind: "user", content: "Fix it", origin: "human" } },
    { kind: "message", id: interrupt, message: { kind: "user", content: "The user interrupted this turn before it finished.", origin: "system" } },
  ])
  await appendEntries(crashed, [
    { kind: "message", id: "u1", message: { kind: "user", content: "Fix it", origin: "human" } },
    { kind: "message", id: crash, message: { kind: "user", content: "Your process exited unexpectedly.", origin: "system" } },
  ])
  await appendEntries(open, [{ kind: "message", id: "u1", message: { kind: "user", content: "Fix it", origin: "human" } }])
  // No client shows the chat after a restart, so the store holds no entry and nothing works on the open turn.
  await ctx.sessionStore.remove(open)

  expect(await eventually(() => latest(cut), (row) => typeof row === "object")).toMatchObject({ state: "cut", status: "interrupted", ended: { entryId: interrupt } })
  expect(await eventually(() => latest(crashed), (row) => typeof row === "object")).toMatchObject({ state: "failed", status: "failed", ended: { entryId: crash } })
  expect(await eventually(() => latest(open), (row) => typeof row === "object" && row.state === "failed")).toMatchObject({ state: "failed", ended: { entryId: "u1" } })
})

test("a failure that the person saw turns the row done until the chat fails again at a later entry", async () => {
  const { lead, latest, eventually, startChat, appendEntries } = rowsHarness()
  const chat = await startChat()
  const crash = turnEndEntryId({ reason: "crash" }, "k1")
  await appendEntries(chat, [
    { kind: "message", id: "u1", message: { kind: "user", content: "Fix it", origin: "human" } },
    { kind: "message", id: crash, message: { kind: "user", content: "Your process exited unexpectedly.", origin: "system" } },
  ])
  expect(await eventually(() => latest(chat), (row) => typeof row === "object")).toMatchObject({ state: "failed", ended: { entryId: crash } })
  expect(await lead.service.markSeen(chat, "failed", crash)).toEqual({ ok: true })
  expect(await eventually(() => latest(chat), (row) => typeof row === "object" && row.state === "done")).toMatchObject({ state: "done" })
  expect(ctx.store.read({ aggregateId: "lead" }).at(-1)).toMatchObject({ type: "lead.chat.seen", payload: { sessionId: chat, state: "failed", entryId: crash } })
  // A second mark of the same failure appends nothing.
  const facts = ctx.store.read({ aggregateId: "lead" }).length
  await lead.service.markSeen(chat, "failed", crash)
  expect(ctx.store.read({ aggregateId: "lead" })).toHaveLength(facts)

  const again = turnEndEntryId({ reason: "crash" }, "k2")
  await appendEntries(chat, [
    { kind: "message", id: "u2", message: { kind: "user", content: "Try again", origin: "human" } },
    { kind: "message", id: again, message: { kind: "user", content: "Your process exited unexpectedly.", origin: "system" } },
  ])
  expect(await eventually(() => latest(chat), (row) => typeof row === "object")).toMatchObject({ state: "failed", ended: { entryId: again } })
})

test("turning the module off ends the rows at once: no patch of a row's in-flight update follows its removal", async () => {
  const base = asAsyncEventReadSurface(ctx.store)
  let gate: Promise<void> | undefined
  const gated: AsyncEventStateReadSurface = { ...base, readPage: async (...args) => { await gate; return base.readPage(...args) } }
  const { lead, latest, eventually, startChat, appendEntries } = rowsHarness(gated)
  const chat = await startChat()
  await appendEntries(chat, [
    { kind: "message", id: "u1", message: { kind: "user", content: "Fix it", origin: "human" } },
    { kind: "message", id: "a1", message: { kind: "assistant", content: [{ type: "text", text: "Fixed." }] } },
  ])
  await eventually(() => latest(chat), (row) => typeof row === "object" && row.state === "result")

  const held = Promise.withResolvers<void>()
  gate = held.promise
  // The question's update reads the chat's questions, which waits on the gate while the module turns off.
  await ctx.store.append({
    aggregateId: `session:${chat}`, sessionId: chat, type: "agent_input.requested", version: 3, actor: "agent", timestamp: 1_000,
    payload: { interactionId: "ask-1", conversationId: await conversation.chatConversationId(chat), toolUseId: "ask-1", request: [QUESTION] },
  })
  await Bun.sleep(5)
  await lead.setEnabled(false)
  expect(latest(chat)).toBe("removed")
  held.resolve()
  gate = undefined
  await Bun.sleep(20)
  expect(latest(chat)).toBe("removed")
})

test("a chat that the person closed loses its row and its pinned fold", async () => {
  const { lead, latest, eventually, reader } = rowsHarness()
  const other = await lead.supervisor.openSessionRuntime()
  await conversation.appendConversation(other, [{ kind: "user", content: "Fix it", origin: "human" }])
  await eventually(() => latest(other), (row) => typeof row === "object")
  await lead.supervisor.closeChat(other)
  expect(await eventually(() => latest(other), (row) => row === "removed")).toBe("removed")
  const marker = { untouched: true }
  // The registry holds no fold of the chat, so it builds the caller's object.
  expect(heldProjection(reader, `lead-row:${other}`, () => marker)).toBe(marker)
})

test("a deleted listed chat loses its row and its pinned fold", async () => {
  const { lead, latest, eventually, reader, startChat } = rowsHarness()
  const chat = await startChat()
  await conversation.appendConversation(chat, [{ kind: "user", content: "Fix it", origin: "human" }])
  await eventually(() => latest(chat), (row) => typeof row === "object")
  expect(await lead.supervisor.deleteSession(chat)).toBe(true)
  expect(await eventually(() => latest(chat), (row) => row === "removed")).toBe("removed")
  const marker = { untouched: true }
  expect(heldProjection(reader, `lead-row:${chat}`, () => marker)).toBe(marker)
})

test("disposal releases every pinned fold", async () => {
  const { lead, latest, eventually, reader, startChat } = rowsHarness()
  const chat = await startChat()
  await conversation.appendConversation(chat, [{ kind: "user", content: "Fix it", origin: "human" }])
  await eventually(() => latest(chat), (row) => typeof row === "object")
  await lead.service.dispose()
  const marker = { untouched: true }
  expect(heldProjection(reader, `lead-row:${chat}`, () => marker)).toBe(marker)
})

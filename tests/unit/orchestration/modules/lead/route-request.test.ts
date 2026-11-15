import { afterEach, beforeEach, expect, test } from "bun:test"
import { EventReaderService } from "../../../../../src/infra/event-store-effect.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../../src/infra/event-store-types.js"
import { chatInputContent } from "../../../../../src/infra/chat-input.js"
import type { ConversationMessage } from "../../../../../src/orchestration/agent-runtime/llm/types.js"
import type { RuntimeToolInput } from "../../../../../src/orchestration/agent-runtime/tools/types.js"
import { createRouteRequestTool } from "../../../../../src/orchestration/modules/lead/route-request.js"
import { createSessionMessaging } from "../../../../../src/orchestration/session/session-messaging.js"
import { unusedChildSessionControl } from "../../../../helpers/child-session-control.js"
import { decodeQueuedUserInput, QUEUED_USER_INPUT_IN_FLIGHT_KIND } from "../../../../../src/orchestration/session/conversation/queued-user-inputs.js"
import { tryOpenConversationTree } from "../../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, supervisorConversationFixture, type SupervisorTestContext } from "../../../../fixtures/runtime-supervisor-fixtures.js"
import { makeContext } from "../../agent-runtime/tools/_fixtures.js"
import { leadHarness } from "./_lead-harness.js"

let ctx: SupervisorTestContext
let disposeAll: (() => Promise<void>)[] = []
beforeEach(() => { ctx = createSupervisorTestContext() })
afterEach(async () => {
  for (const dispose of disposeAll) await dispose()
  disposeAll = []
  await disposeSupervisorTestContext(ctx)
})
const conversation = supervisorConversationFixture(() => ctx)

/** Each turn the runtime's own steps settle in. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Bun.sleep(1)
}

/** A lead whose `route_request` tool runs in the lead chat with the kernel's own session messaging. */
async function routingLead() {
  // Runners start only at the end, so each forwarded message commits as the target chat's entry, as a real runner commits it.
  const runnerStartup = Promise.withResolvers<void>()
  const lead = leadHarness(ctx, { runnerStartup: runnerStartup.promise })
  disposeAll.push(async () => { runnerStartup.resolve(); await lead.dispose() })
  const leadSessionId = await lead.openLead()
  if (leadSessionId === null) throw new Error("expected the lead to open")
  // The registry of live sessions is keyed by the reader that the supervisor holds.
  const sessions = createSessionMessaging({ manager: ctx.manager, projectionReader: ctx.runtime.runSync(EventReaderService), eventWriter: asAsyncEventWriter(ctx.store) }, unusedChildSessionControl())
  const tool = createRouteRequestTool((input) => lead.service.route(input), sessions)
  let calls = 0
  return {
    ...lead, leadSessionId,
    /** Appends `messages` to the lead's conversation and then the assistant entry of a `route_request` call, as the
     *  runtime commits it before the tool runs, and runs the call. */
    async route(turn: readonly ConversationMessage[], input: RuntimeToolInput) {
      calls += 1
      const toolUseId = `route-${calls}`
      await conversation.appendConversation(leadSessionId, [...turn, { kind: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "route_request", input }] }])
      return tool.execute(input, makeContext({ sessionId: leadSessionId, conversationId: await conversation.chatConversationId(leadSessionId), toolUseId }))
    },
    /** Runs a call again, with no new entry in the lead's conversation. */
    async again(input: RuntimeToolInput) {
      return tool.execute(input, makeContext({ sessionId: leadSessionId, conversationId: await conversation.chatConversationId(leadSessionId), toolUseId: `route-${calls}` }))
    },
  }
}

async function messages(sessionId: string) {
  const conversationId = await conversation.chatConversationId(sessionId)
  const tree = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(ctx.store) })
  if (!tree) return []
  const branch = await tree.getBranch()
  await tree.getStorage().dispose()
  return branch.flatMap((entry) => entry.kind === "message" ? [{ id: entry.id, message: entry.message }] : [])
}

async function userEntries(sessionId: string) {
  return (await messages(sessionId)).filter((entry) => entry.message.kind === "user")
}

/** The lead facts but the list's joins, which `joins` reads. */
/** The lead facts but the list's own bookkeeping: its joins and the record of its first run. */
const leadFacts = () => ctx.store.read({ aggregateId: "lead" }).filter((fact) => fact.type !== "lead.chat.joined" && fact.type !== "lead.list.seeded").map((fact) => ({ type: fact.type, payload: fact.payload }))
const joins = () => ctx.store.read({ aggregateId: "lead" }).flatMap((fact) => fact.type === "lead.chat.joined" ? [fact.payload] : [])
/** The chat that the lead started first. */
function startedChat(): string {
  const started = ctx.store.read({ aggregateId: "lead" }).find((fact) => fact.type === "lead.chat.started")?.payload
  const sessionId = typeof started === "object" && started !== null && "sessionId" in started ? started.sessionId : undefined
  if (typeof sessionId !== "string") throw new Error("expected a started chat")
  return sessionId
}
const chatIds = async () => (await ctx.manager.listMetadata()).sessions.filter((row) => row.kind === "chat").map((row) => row.id)
const textOf = (result: { readonly content: unknown }) => typeof result.content === "string" ? result.content : JSON.stringify(result.content)

test("a new route starts a chat whose first entry is the person's message with its attachment, recorded and watched first", async () => {
  const lead = await routingLead()
  const content = chatInputContent({ text: "Fix [Image #1] on the login page", attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "iVBORw0KGgo=" }] })
  const before = await chatIds()
  const result = await lead.route([{ kind: "user", content, origin: "human" }], { kind: "new" })
  expect(result.outcome).toBe("ok")

  const [started] = (await chatIds()).filter((id) => !before.includes(id))
  if (started === undefined) throw new Error("expected a new chat")
  const [source] = await userEntries(lead.leadSessionId)
  if (!source) throw new Error("expected the person's entry")
  expect(leadFacts().slice(1)).toEqual([
    { type: "lead.chat.started", payload: { sessionId: started, sourceEntryIds: [source.id] } },
    { type: "lead.request.forwarded", payload: { leadSessionId: lead.leadSessionId, targetSessionId: started, newChat: true, sourceEntryIds: [source.id] } },
  ])
  expect(lead.trace).toEqual([`watch ${started}`, `forward ${started}`])
  // The started chat joined the list before the forward, with the lead's rules in its prompt.
  expect(joins()).toContainEqual({ sessionId: started, briefed: true })
  await settled()
  // The started fact precedes the chat's first entry in the store.
  const order = ctx.store.read().flatMap((fact) => fact.type === "lead.chat.started" ? ["started"] : JSON.stringify(fact.payload).includes(`person:forward:${source.id}`) ? ["entry"] : [])
  expect(order[0]).toBe("started")
  expect(order).toContain("entry")

  const [first, ...rest] = await messages(started)
  expect(first?.message.kind).toBe("user")
  expect(first?.message.kind === "user" ? first.message.origin : undefined).toBe("human")
  expect(JSON.stringify(first?.message.content)).toBe(JSON.stringify(content))
  // No model text reaches the chat: every other user entry is absent, and the chat's title is in the result.
  expect(rest.filter((entry) => entry.message.kind === "user")).toEqual([])
  const title = (await ctx.manager.read(started))?.name
  expect(textOf(result)).toContain(started)
  if (title) expect(textOf(result)).toContain(title)

  const factsBefore = leadFacts().length
  const repeated = await lead.again({ kind: "new" })
  expect(repeated.outcome).toBe("ok")
  expect(textOf(repeated)).toContain(`These messages already started chat ${started}`)
  expect((await chatIds()).filter((id) => !before.includes(id))).toEqual([started])
  expect(leadFacts()).toHaveLength(factsBefore)
  expect((await userEntries(started)).map((entry) => entry.id)).toEqual([`person:forward:${source.id}`])
})

test("a note arrives after the person's message as a message from the lead, and a repeated route sends it once", async () => {
  const lead = await routingLead()
  const result = await lead.route([{ kind: "user", content: "Add a logout button", origin: "human" }], { kind: "new", note: "Chat abc changes the same header." })
  expect(result.outcome).toBe("ok")
  const target = startedChat()
  const [source] = await userEntries(lead.leadSessionId)
  // The target's runner has not started, so the kernel holds the note until the chat reads it.
  expect(textOf(result)).toContain("Your note waits until the chat runs again.")
  await lead.again({ kind: "new", note: "Chat abc changes the same header." })
  await settled()
  expect(await commitHeldInput(target)).toBe(1)

  const entries = await userEntries(target)
  expect(entries.map((entry) => entry.id)).toEqual([`person:forward:${source?.id}`, expect.any(String)])
  const note = entries[1]?.message
  if (note?.kind !== "user") throw new Error("expected the note as a user entry")
  expect(note.content).toBe("Chat abc changes the same header.")
  expect(note.producer).toMatchObject({ kind: "session", sessionId: lead.leadSessionId })
})

/** Commits each message that the kernel holds for `sessionId` through the conversation's own commit, as the chat's
 *  runner does when it reads them, and answers how many it committed. */
async function commitHeldInput(sessionId: string): Promise<number> {
  const conversationId = await conversation.chatConversationId(sessionId)
  const tree = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store) })
  if (!tree) throw new Error("expected the chat's conversation")
  const cells = ctx.store.readInFlight(sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND).flatMap((row) => decodeQueuedUserInput(row, sessionId, conversationId) ?? [])
  for (const cell of cells) await tree.commitQueuedUserInput(cell)
  await tree.getStorage().dispose()
  return cells.length
}

test("an existing route reaches a listed chat that the lead did not start, and a chat that the person closed is refused and gets nothing", async () => {
  const lead = await routingLead()
  const listed = await lead.supervisor.openSessionRuntime()
  const closed = await lead.supervisor.openSessionRuntime()
  // A chat with no entry is discarded at its close, so each holds the person's earlier work.
  for (const chat of [listed, closed]) await conversation.appendConversation(chat, [{ kind: "user", content: "Earlier work", origin: "human" }])
  await settled()
  expect(joins().map((join) => join.sessionId)).toEqual(expect.arrayContaining([listed, closed]))
  await lead.supervisor.closeChat(closed)
  await settled()

  const routed = await lead.route([{ kind: "user", content: "Continue here", origin: "human" }], { kind: "existing", chat: listed })
  expect(routed.outcome).toBe("ok")
  await settled()
  expect((await userEntries(listed)).map((entry) => entry.message.kind === "user" ? entry.message.content : undefined)).toEqual(["Earlier work", "Continue here"])

  const refused = await lead.route([{ kind: "user", content: "Continue there", origin: "human" }], { kind: "existing", chat: closed })
  expect(refused.outcome).toBe("error")
  expect(textOf(refused)).toContain(`chat ${closed} is not in your list`)
  expect((await userEntries(closed)).map((entry) => entry.message.kind === "user" ? entry.message.content : undefined)).toEqual(["Earlier work"])
  expect(leadFacts().map((fact) => fact.type)).toEqual(["lead.chat.designated", "lead.chat.closed", "lead.request.forwarded"])
})

test("in a turn that a notice started, a route is refused, also with earlier turns", async () => {
  const lead = await routingLead()
  const before = await chatIds()
  await conversation.appendConversation(lead.leadSessionId, [
    { kind: "user", content: "Fix the login page", origin: "human" },
    { kind: "assistant", content: [{ type: "text", text: "Routed." }] },
  ])
  const fromNotice = await lead.route([{ kind: "user", content: "A chat finished.", origin: "system" }], { kind: "new" })
  expect(fromNotice.outcome).toBe("error")
  expect(textOf(fromNotice)).toContain("the newest turn holds no message from the person")
  const withEarlier = await lead.again({ kind: "new", earlier_turns: 1 })
  expect(withEarlier.outcome).toBe("error")
  expect(await chatIds()).toEqual(before)
  expect(leadFacts().map((fact) => fact.type)).toEqual(["lead.chat.designated"])
})

test("earlier turns forward the person's messages oldest first, and the result lists the first line of each", async () => {
  const lead = await routingLead()
  const result = await lead.route([
    { kind: "user", content: "Fix the login page\nIt hangs.", origin: "human" },
    { kind: "assistant", content: [{ type: "text", text: "Which browser?" }] },
    { kind: "user", content: "Safari only", origin: "human" },
  ], { kind: "new", earlier_turns: 1 })
  expect(result.outcome).toBe("ok")
  expect(textOf(result)).toContain("- Fix the login page\n- Safari only")
  const target = startedChat()
  await settled()
  const copies = await userEntries(target)
  expect(copies.map((entry) => entry.message.kind === "user" ? [entry.message.content, entry.message.origin] : [])).toEqual([
    ["Fix the login page\nIt hangs.", "human"],
    ["Safari only", "human"],
  ])
})

test("after a routing pick through ask_user, an existing route forwards the person's message and no text of the answer", async () => {
  const lead = await routingLead()
  const first = await lead.route([{ kind: "user", content: "Build the settings page", origin: "human" }], { kind: "new" })
  expect(first.outcome).toBe("ok")
  const target = startedChat()
  await conversation.appendConversation(lead.leadSessionId, [{ kind: "assistant", content: [{ type: "text", text: "Started." }] }])
  await settled()

  const result = await lead.route([
    { kind: "user", content: "Also add a dark mode switch", origin: "human" },
    { kind: "assistant", content: [{ type: "tool_use", id: "ask-1", name: "ask_user", input: { context: "Which chat?", question: "Route where?", options: ["Settings chat", "New chat"] } }] },
    { kind: "toolResult", toolUseId: "ask-1", content: [{ type: "text", text: "Settings chat" }] },
  ], { kind: "existing", chat: target })
  expect(result.outcome).toBe("ok")
  await settled()
  const contents = (await userEntries(target)).map((entry) => entry.message.content)
  expect(contents).toEqual(["Build the settings page", "Also add a dark mode switch"])
})

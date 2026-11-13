import { afterEach, beforeEach, expect, test } from "bun:test"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { chatInputContent } from "../../../../src/infra/chat-input.js"
import type { ChatRunner } from "../../../../src/orchestration/chat/runner-types.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { createRuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import { loadSessionView } from "../../../../src/orchestration/session-store/view.js"
import type { ChatRunnerDeps } from "../../../../src/orchestration/chat/runner.js"
import type { RuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor-types.js"
import { createDeferred, createSupervisorTestContext, disposeSupervisorTestContext, mockRunner, supervisorBaseDeps, supervisorConversationFixture, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"

let ctx: SupervisorTestContext
beforeEach(() => { ctx = createSupervisorTestContext() })
afterEach(async () => { await disposeSupervisorTestContext(ctx) })
const conversation = supervisorConversationFixture(() => ctx)

/** A supervisor that opens a durable chat again, as the executor does. */
function startSupervisor(createRunner: (deps: ChatRunnerDeps) => Promise<ChatRunner>): RuntimeSupervisor {
  const reader = asAsyncEventReadSurface(ctx.store)
  return createRuntimeSupervisor({ ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner }), sessionViewLoader: { load: (id) => loadSessionView(id, reader, reader) } })
}

/** Each turn the runtime's own steps settle in. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Bun.sleep(1)
}

interface StoredMessage {
  readonly id: string
  readonly message: { readonly content: unknown; readonly origin?: unknown; readonly producer?: unknown; readonly invocation?: unknown }
}

async function messageEntries(sessionId: string, kind: "user" | "assistant" = "user"): Promise<readonly StoredMessage[]> {
  const conversationId = await conversation.chatConversationId(sessionId)
  const tree = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(ctx.store) })
  if (!tree) return []
  const branch = await tree.getBranch()
  await tree.getStorage().dispose()
  return branch.flatMap((entry) => entry.kind === "message" && entry.message.kind === kind ? [{ id: entry.id, message: { ...entry.message } }] : [])
}
const userEntries = (sessionId: string) => messageEntries(sessionId)

/** A source chat whose conversation holds person entry A, an answer, person
 *  entry B with an image and a text file, a notice, and person entry C. */
interface SourceChat {
  readonly sessionId: string
  readonly ids: { readonly A: string; readonly B: string; readonly C: string; readonly answer: string }
}

async function sourceChat(supervisor: RuntimeSupervisor): Promise<SourceChat> {
  const sessionId = await supervisor.openSessionRuntime({ name: "Lead" })
  const withFiles = chatInputContent({ text: "Fix [Image #1] per [File #2 notes.md]", attachments: [
    { marker: "[Image #1]", mediaType: "image/png", data: "iVBORw0KGgo=" },
    { marker: "[File #2 notes.md]", mediaType: "text/markdown", name: "notes.md", data: Buffer.from("# Notes\n", "utf8").toString("base64") },
  ] })
  await conversation.appendConversation(sessionId, [
    { kind: "user", content: "A: first request", origin: "human" },
    { kind: "assistant", content: [{ type: "text", text: "Which part?" }] },
    { kind: "user", content: withFiles, origin: "human", invocation: { label: "fix" } },
    { kind: "user", content: "A chat finished.", origin: "system" },
    { kind: "user", content: "C: the login page", origin: "human" },
  ])
  const [a, b, , c] = await userEntries(sessionId)
  const [answerEntry] = await messageEntries(sessionId, "assistant")
  if (!a || !b || !c || !answerEntry) throw new Error("source conversation was not committed")
  return { sessionId, ids: { A: a.id, B: b.id, C: c.id, answer: answerEntry.id } }
}

test("the person's entries of a chat's newest turns are read from its durable entries", async () => {
  const supervisor = startSupervisor(async (deps) => mockRunner(deps.sessionId))
  try {
    const { sessionId, ids } = await sourceChat(supervisor)
    expect(await supervisor.personEntries(sessionId, 0)).toEqual([
      { entryId: ids.B, firstLine: "Fix [Image #1] per [File #2 notes.md]", turnsBack: 0 },
      { entryId: ids.C, firstLine: "C: the login page", turnsBack: 0 },
    ])
    expect((await supervisor.personEntries(sessionId, 1)).map((ref) => [ref.entryId, ref.turnsBack])).toEqual([[ids.A, 1], [ids.B, 0], [ids.C, 0]])
  } finally {
    await supervisor.disposeAll()
  }
})

test("a forward commits the person's entries in a chat with no client as that person's messages, runs a turn, and ends the runner at rest", async () => {
  const startup = createDeferred<void>()
  const delivered: unknown[] = []
  const runners: (ChatRunner & { disposeCalls(): number })[] = []
  const supervisor = startSupervisor(async (deps) => {
    await startup.promise
    const runner = mockRunner(deps.sessionId, { deliverCommitted: (input) => {
      delivered.push(input)
      ctx.sessionStore.updateChatEntry(deps.sessionId, { runnerState: "streaming" })
      return true
    } })
    runners.push(runner)
    return runner
  })
  try {
    const source = await sourceChat(supervisor)
    const target = await supervisor.openSessionRuntime()
    expect(await supervisor.forwardPersonEntries({ sourceSessionId: source.sessionId, entryIds: [source.ids.B, source.ids.C], targetSessionId: target })).toEqual({ ok: true })
    startup.resolve()
    await settled()

    const session = await ctx.manager.read(target)
    expect(session?.kind).toBe("chat")
    expect(session).not.toHaveProperty("launchedFrom")
    const sourceEntries = await userEntries(source.sessionId)
    const copies = await userEntries(target)
    expect(copies.map((entry) => entry.id)).toEqual([`person:forward:${source.ids.B}`, `person:forward:${source.ids.C}`])
    for (const [index, copy] of copies.entries()) {
      expect(copy.message.origin).toBe("human")
      expect(copy.message.producer).toBeUndefined()
      expect(JSON.stringify(copy.message.content)).toBe(JSON.stringify(sourceEntries.find((entry) => entry.id === [source.ids.B, source.ids.C][index])?.message.content))
    }
    expect(copies[0]?.message.invocation).toEqual({ label: "fix" })
    // A turn runs on the copies, and the runner ends once it comes to rest.
    expect(delivered).toHaveLength(2)
    expect(ctx.sessionStore.get(target)?.runner).not.toBeNull()
    ctx.sessionStore.updateChatEntry(target, { runnerState: "idle" })
    await settled()
    expect(ctx.sessionStore.get(target)).toBeUndefined()
    expect(runners.every((runner) => runner.disposeCalls() === 1)).toBe(true)

    expect(await supervisor.forwardPersonEntries({ sourceSessionId: source.sessionId, entryIds: [source.ids.B, source.ids.C], targetSessionId: target })).toEqual({ ok: true })
    await settled()
    expect((await userEntries(target)).map((entry) => entry.id)).toEqual(copies.map((entry) => entry.id))
  } finally {
    startup.resolve()
    await supervisor.disposeAll()
  }
})

test("a forward refuses an entry that is not the person's and a target that was deleted, and commits nothing", async () => {
  const supervisor = startSupervisor(async (deps) => mockRunner(deps.sessionId))
  try {
    const source = await sourceChat(supervisor)
    const target = await supervisor.openSessionRuntime()
    const refused = await supervisor.forwardPersonEntries({ sourceSessionId: source.sessionId, entryIds: [source.ids.B, source.ids.answer], targetSessionId: target })
    expect(refused).toEqual({ ok: false, reason: expect.stringContaining(source.ids.answer) })
    expect(await userEntries(target)).toEqual([])

    await supervisor.deleteSession(target)
    const gone = await supervisor.forwardPersonEntries({ sourceSessionId: source.sessionId, entryIds: [source.ids.B], targetSessionId: target })
    expect(gone).toEqual({ ok: false, reason: expect.stringContaining(target) })
  } finally {
    await supervisor.disposeAll()
  }
})

test("a person's answer to a chat that no client shows continues the turn, and the runner ends at the next rest", async () => {
  const supervisor = startSupervisor(async (deps) => mockRunner(deps.sessionId, {
    answerQuestion: () => { ctx.sessionStore.updateChatEntry(deps.sessionId, { runnerState: "streaming" }) },
  }))
  try {
    const sessionId = await supervisor.openSessionRuntime()
    await conversation.commitUserTurn(sessionId)
    await supervisor.ensureChatRunner(sessionId)
    const conversationId = await conversation.chatConversationId(sessionId)
    const question = { question: "Continue?", choices: [{ kind: "option" as const, choiceId: "yes", label: "Yes" }], multiSelect: false }
    await ctx.store.append({
      aggregateId: `session:${sessionId}`, sessionId, type: "agent_input.requested", version: 3, actor: "agent", timestamp: 1,
      payload: { interactionId: "ask-1", conversationId, toolUseId: "ask-1", request: [question] },
    })
    ctx.sessionStore.updateChatEntry(sessionId, { runnerState: "awaiting_user" })

    expect(await supervisor.answerQuestion(sessionId, "ask-1", { "Continue?": { kind: "choice", selections: [{ choiceId: "yes" }], text: "Yes" } })).toEqual({ ok: true })
    await settled()
    expect(ctx.sessionStore.get(sessionId)?.runner).not.toBeNull()
    ctx.sessionStore.updateChatEntry(sessionId, { runnerState: "idle" })
    await settled()
    expect(ctx.sessionStore.get(sessionId)).toBeUndefined()
  } finally {
    await supervisor.disposeAll()
  }
})

test("a chat that a client shows keeps its runner after a person's message", async () => {
  const supervisor = startSupervisor(async (deps) => mockRunner(deps.sessionId))
  try {
    const sessionId = await supervisor.openSessionRuntime()
    await supervisor.activateSession(sessionId, { shown: true })
    expect(await supervisor.sendChat(sessionId, "hello")).toEqual({ ok: true })
    await settled()
    expect(ctx.sessionStore.get(sessionId)?.runner).not.toBeNull()
  } finally {
    await supervisor.disposeAll()
  }
})

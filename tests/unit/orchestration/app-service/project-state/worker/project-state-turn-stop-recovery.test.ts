import { afterEach, describe, expect, test } from "bun:test"
import { recoverProject } from "../../../../../helpers/project-recovery.js"
import { createSessionFactWriter } from "../../../../../../src/orchestration/session/persistence/session-fact-writer.js"
import { tryOpenConversationTree } from "../../../../../../src/orchestration/session/conversation/tree/conversation-tree-handle.js"
import { authorizePlannedSessionContinuation } from "../../../../../../src/orchestration/session/control/planned-session-continuation.js"
import { holdReplyWait } from "../../../../../../src/orchestration/session/conversation/reply-wait-cells.js"
import { cleanup, closeFixtures, fixture } from "./_project-state-recovery-fixture.js"

afterEach(closeFixtures)

describe("the stop that a dead owner of a chat left out (ARCH-SESSIONS-051)", () => {
  /** A chat left active whose last turn the owner answered, with a start fact when `started`. */
  async function answeredChat(started: boolean) {
    const { store, reader, writer, manager, directories } = fixture()
    const sessionId = await manager.createChat({ name: "answered", initialState: "active" })
    const session = await manager.read(sessionId)
    if (session?.kind !== "chat") throw new Error("expected chat")
    const { conversationId } = session
    const facts = createSessionFactWriter({ sessionId, writer })
    cleanup.push(() => { facts.dispose() })
    if (started) await facts.record({ type: "chat.turn.started", version: 1, actor: "flywheel", payload: { conversationId } })
    const tree = await tryOpenConversationTree({ sessionId, conversationId, store: reader, writer })
    if (!tree) throw new Error("missing tree")
    let answerId: string | undefined
    try {
      const saved = await tree.appendMessages([{ kind: "user", content: "Hi.", origin: "human" }, { kind: "assistant", content: "**Done.**\nDetails." }])
      if (saved.kind !== "committed") throw saved.cause
      answerId = (await tree.getBranch()).at(-1)?.id
    } finally { tree.dispose() }
    const stops = () => store.read({ aggregateId: `session:${sessionId}`, types: ["chat.turn.stopped"] }).map((fact) => fact.payload)
    return { store, reader, writer, manager, directories, facts, sessionId, conversationId, answerId, stops }
  }

  test("records the stop for an owner that died after the final message, once", async () => {
    const chat = await answeredChat(true)
    expect(await recoverProject(chat, "closed-generation")).toMatchObject({ sessionIds: [chat.sessionId], degraded: [] })
    expect(chat.stops()).toEqual([{ conversationId: chat.conversationId, ending: { kind: "completed" }, finalEntryId: chat.answerId, firstLine: "Done." }])
    // A later pass over the same chat finds the stop newest and records none.
    await chat.manager.updateLifecycleState(chat.sessionId, "active")
    expect(await recoverProject(chat, "closed-generation")).toMatchObject({ sessionIds: [chat.sessionId] })
    expect(chat.stops()).toHaveLength(1)
  })

  test("records none for a chat with no start fact", async () => {
    const chat = await answeredChat(false)
    await recoverProject(chat, "closed-generation")
    expect(chat.stops()).toEqual([])
  })

  test.each<readonly [string, (chat: Awaited<ReturnType<typeof answeredChat>>) => Promise<void>, boolean]>([
    ["a capacity wait or a successor holds the continuation", (chat) => authorizePlannedSessionContinuation({ reader: chat.reader, writer: chat.writer, continuation: { target: { kind: "chat", sessionId: chat.sessionId }, continuesAt: Date.now() + 60_000 } }), false],
    ["a reply wait is open", (chat) => holdReplyWait(chat.writer, chat.sessionId, { addresseeSessionId: "peer", toolUseId: "message-1", openedAtMs: Date.now() }), false],
    ["the person interrupted the closed generation", async () => {}, true],
  ])("records none while %s", async (_name, owe, interrupted) => {
    const chat = await answeredChat(true)
    await owe(chat)
    await recoverProject(chat, "closed-generation", interrupted ? [chat.sessionId] : [])
    expect(chat.stops()).toEqual([])
  })
})

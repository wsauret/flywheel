import { afterEach, describe, expect, test } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventWriter, type EventStoreAppend } from "../../../../src/infra/event-store-types"
import type { ChatInput, SessionInputProducer } from "../../../../src/infra/chat-input"
import { buildSubagentCompleted } from "../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers"
import { holdQueuedBackgroundNotification, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND, readWorkflowBackgroundNotifications, readConversationBackgroundNotifications } from "../../../../src/orchestration/session/conversation/queued-background-notifications"
import { holdQueuedUserInput, QUEUED_USER_INPUT_IN_FLIGHT_KIND, readUnreadMessages } from "../../../../src/orchestration/session/conversation/queued-user-inputs"
import { registerLiveSessionControl, messageDisposition, type RecipientState, type DeliveryOutcome, type LiveRecipientState } from "../../../../src/orchestration/session/live-session-control"
import { createSessionManager, type SessionManager } from "../../../../src/orchestration/session/manager"
import { prepareSessionFactAppend } from "../../../../src/orchestration/session/session-fact-writer"
import { deliverSessionInput, settleUnreadMessages } from "../../../../src/orchestration/session/session-input-delivery"
import { cleanupTmpRoot, finalizeTestSessionDeletion, makeDepsWithStore, makeTmpDir, publishTestSubagent, publishTestWorkflow, startTestWorkflowMember } from "./_session-manager-fixtures"
import { returnUnreadHumanInput, claimComposerReturns, COMPOSER_RETURN_KIND } from "../../../../src/orchestration/session/composer-returns"
import { conversationPersonMessage } from "../../../../src/orchestration/session/conversation/person-message-ledger"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { createConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer"

afterEach(() => {
  cleanupTmpRoot()
})

function fromSession(sessionId: string, hop = 0, toolUseId = "call-1"): SessionInputProducer {
  return { kind: "session", sessionId, conversationId: `${sessionId}-conversation`, toolUseId, hop }
}

describe("messageDisposition", () => {
  // One row of the D4 table each: [state, session outcome, person outcome].
  const rows: readonly [RecipientState, DeliveryOutcome, DeliveryOutcome][] = [
    ["running", { status: "delivered", startsTurn: false }, { status: "delivered", startsTurn: false }],
    ["idle", { status: "delivered", startsTurn: true }, { status: "delivered", startsTurn: true }],
    ["waiting_on_work", { status: "delivered", startsTurn: false }, { status: "delivered", startsTurn: false }],
    ["planned_cut", { status: "delivered", startsTurn: false }, { status: "delivered", startsTurn: false }],
    ["interrupted", { status: "held", reason: "interrupted" }, { status: "held", reason: "interrupted" }],
    ["at_rest", { status: "held", reason: "no_reader" }, { status: "held", reason: "no_reader" }],
    ["between_steps", { status: "delivered", startsTurn: false }, { status: "delivered", startsTurn: false }],
    ["settled", { status: "refused", reason: "settled" }, { status: "refused", reason: "settled" }],
    ["deleted", { status: "refused", reason: "deleted" }, { status: "refused", reason: "deleted" }],
    ["not_found", { status: "refused", reason: "not_found" }, { status: "refused", reason: "not_found" }],
  ]
  for (const [state, session, person] of rows) {
    test(`a recipient that is ${state}`, () => {
      expect(messageDisposition({ state, origin: "session", hop: 0, self: false })).toEqual(session)
      expect(messageDisposition({ state, origin: "human", hop: 0, self: false })).toEqual(person)
    })
  }

  test("a session that messages itself is refused, and a person is never the sender", () => {
    expect(messageDisposition({ state: "running", origin: "session", hop: 0, self: true })).toEqual({ status: "refused", reason: "self" })
    expect(messageDisposition({ state: "running", origin: "human", hop: 0, self: true })).toEqual({ status: "delivered", startsTurn: false })
  })

  test("a session message at the hop limit to an idle recipient or one that waits on background work waits, unless it comes from the recipient's parent or its own child; one that a running turn reads is delivered", () => {
    expect(messageDisposition({ state: "idle", origin: "session", hop: 4, self: false })).toEqual({ status: "delivered", startsTurn: true })
    for (const state of ["idle", "waiting_on_work"] as const) {
      expect(messageDisposition({ state, origin: "session", hop: 5, self: false, relation: "other" })).toEqual({ status: "held", reason: "wake_limit" })
      expect(messageDisposition({ state, origin: "session", hop: 5, self: false, relation: "sibling" })).toEqual({ status: "held", reason: "wake_limit" })
      for (const relation of ["child", "parent"] as const) {
        expect(messageDisposition({ state, origin: "session", hop: 9, self: false, relation })).toEqual({ status: "delivered", startsTurn: state === "idle" })
      }
    }
    expect(messageDisposition({ state: "waiting_on_work", origin: "session", hop: 4, self: false, relation: "other" })).toEqual({ status: "delivered", startsTurn: false })
    expect(messageDisposition({ state: "running", origin: "session", hop: 5, self: false })).toEqual({ status: "delivered", startsTurn: false })
    expect(messageDisposition({ state: "idle", origin: "human", hop: 9, self: false })).toEqual({ status: "delivered", startsTurn: true })
  })
})

describe("deliverSessionInput", () => {
  test("a returned person's input survives one composer claim and remains an accepted submission receipt", async () => {
    const root = makeTmpDir()
    const { deps, store } = makeDepsWithStore(root)
    const manager = createSessionManager(deps)
    const reader = asAsyncEventReadSurface(store), writer = asAsyncEventWriter(store)
    const parent = await manager.createChat({ id: "parent", conversationId: "parent-conversation", name: "Parent" })
    const child = await publishTestSubagent(manager, root, "child", parent, "parent-conversation")
    const text = "the person's unread words"
    await holdQueuedUserInput(writer, child, { target: "conversation", conversationId: "child-conversation" }, { text, producer: { kind: "human" }, submissionIds: ["return-1"] })
    const cells = await readUnreadMessages(reader, child)
    await returnUnreadHumanInput({ reader, writer }, { sessionId: child, name: "Child" }, cells)
    expect(store.readInFlight(child, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toEqual([])
    expect(store.readInFlight(parent, COMPOSER_RETURN_KIND)).toHaveLength(1)
    expect(await claimComposerReturns({ reader, writer }, parent, ["someone-else"])).toEqual({ ok: true, kind: "no_match" })
    expect(store.readInFlight(parent, COMPOSER_RETURN_KIND)).toHaveLength(1)
    const results = await Promise.all([claimComposerReturns({ reader, writer }, parent, ["return-1"]), claimComposerReturns({ reader, writer }, parent, ["return-1"])])
    expect(results.filter((result) => result.ok && result.kind === "claimed")).toHaveLength(1)
    await returnUnreadHumanInput({ reader, writer }, { sessionId: child, name: "Child" }, cells)
    expect(await claimComposerReturns({ reader, writer }, parent, ["return-1"])).toEqual({ ok: true, kind: "empty" })
    expect(await conversationPersonMessage(reader, { sessionId: child, conversationId: "child-conversation", kind: "subagent" }, "person:return-1")).toBe("returned")
    expect(await deliverSessionInput({ manager, projectionReader: reader, eventWriter: writer }, child, { text, producer: { kind: "human" }, submissionIds: ["return-1"] })).toEqual({ status: "delivered", startsTurn: false, confirmedSubmissionIds: ["return-1"] })
    expect(store.readInFlight(child, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toEqual([])
    const tree = await tryOpenConversationTree({ sessionId: parent, conversationId: "parent-conversation", store: reader, writer })
    expect(await tree!.getBranch()).toContainEqual(expect.objectContaining({
      kind: "message",
      message: { kind: "system", content: `Subagent "Child" finished before reading your message:\n\n${text}` },
      displayOnly: true,
    }))
    expect(JSON.stringify(await tree!.buildContext())).not.toContain(text)
    tree!.getStorage().dispose()
    await holdQueuedUserInput(writer, child, { target: "conversation", conversationId: "child-conversation" }, { text: "sender disconnected", producer: { kind: "human" }, submissionIds: ["disconnected"] })
    await returnUnreadHumanInput({ reader, writer }, { sessionId: child, name: "Child" }, await readUnreadMessages(reader, child))
    const pendingReturns = store.readInFlight(parent, COMPOSER_RETURN_KIND)
    const controller = createConversationTreeWriterController({ sessionId: parent, conversationId: "parent-conversation", projectRoot: root, store: reader, projectionReader: reader, writer })
    await controller.commitUserTurn("next turn")
    controller.beginTurn()
    await controller.recordCanonicalMessage({ kind: "assistant", content: "done" })
    await controller.endTurn()
    expect(store.readInFlight(parent, COMPOSER_RETURN_KIND)).toEqual(pendingReturns)
    expect(JSON.stringify(await controller.buildContext({ allowAssistantTail: true }))).not.toContain("sender disconnected")
    expect(JSON.stringify((await controller.getState()).entriesById)).toContain("sender disconnected")
    await controller.dispose()
    expect(await claimComposerReturns({ reader, writer }, parent, ["disconnected"])).toMatchObject({ ok: true, kind: "claimed", items: [{ input: { text: "sender disconnected" } }] })
    expect(store.readInFlight(parent, COMPOSER_RETURN_KIND)).toEqual([])
    const unknown = { version: 2, conversationId: "parent-conversation" }
    store.putInFlight(parent, COMPOSER_RETURN_KIND, "unknown-version", unknown)
    expect(await claimComposerReturns({ reader, writer }, parent, ["return-1"])).toMatchObject({ ok: false })
    expect(store.readInFlight(parent, COMPOSER_RETURN_KIND)[0]!.payload).toEqual(unknown)
  })
  async function project(overrides: { writer?: AsyncEventWriter } = {}) {
    const root = makeTmpDir()
    const { deps, store } = makeDepsWithStore(root, overrides.writer ? { writer: overrides.writer } : {})
    const manager: SessionManager = createSessionManager(deps)
    const reader = asAsyncEventReadSurface(store)
    const writer = overrides.writer ?? asAsyncEventWriter(store)
    const delivery = { manager, projectionReader: reader, eventWriter: writer }
    const cells = (sessionId: string) => store.readInFlight(sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND)
    const notices = (sessionId: string) => store.readInFlight(sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)
    return { root, store, manager, reader, writer, delivery, cells, notices }
  }

  test("an unknown session refuses as not found and a deleted one as deleted, and neither keeps a cell", async () => {
    const { manager, delivery, cells } = await project()
    expect(await deliverSessionInput(delivery, "never-existed", "hello")).toEqual({ status: "refused", reason: "not_found" })
    const chat = await manager.createChat({ name: "Gone" })
    await finalizeTestSessionDeletion(manager, chat)
    expect(await deliverSessionInput(delivery, chat, "hello")).toEqual({ status: "refused", reason: "deleted" })
    expect(cells("never-existed")).toEqual([])
    expect(cells(chat)).toEqual([])
  })

  test("a chat that no runner shows holds the message durably under a fresh key", async () => {
    const { manager, delivery, cells } = await project()
    const chat = await manager.createChat({ name: "Closed" })
    expect(await deliverSessionInput(delivery, chat, { text: "later", producer: fromSession("sender") })).toEqual({ status: "held", reason: "no_reader" })
    expect(cells(chat).map((row) => row.key)).toEqual(["msg:sender:call-1"])
  })

  test("a live session decides from its own state and reads the message under its cell key", async () => {
    const { manager, reader, delivery, cells } = await project()
    const chat = await manager.createChat({ name: "Open" })
    const received: ChatInput[] = []
    const states: LiveRecipientState[] = ["idle", "interrupted"]
    const unregister = registerLiveSessionControl(reader, {
      sessionId: chat,
      state: async () => "idle",
      deliver: async (input, decide) => {
        received.push(input)
        return decide(states.shift() ?? "running")
      },
      notify: async () => false,
    })
    try {
      expect(await deliverSessionInput(delivery, chat, { text: "wake up", producer: fromSession("sender") })).toEqual({ status: "delivered", startsTurn: true })
      expect(await deliverSessionInput(delivery, chat, { text: "after the interrupt", producer: fromSession("sender", 0, "call-2") })).toEqual({ status: "held", reason: "interrupted" })
      expect(await deliverSessionInput(delivery, chat, { text: "chain", producer: fromSession("sender", 5, "call-3") })).toEqual({ status: "delivered", startsTurn: false })
    } finally {
      unregister()
    }
    expect(received.map((input) => input.dispatchIds)).toEqual([["msg:sender:call-1"], ["msg:sender:call-2"], ["msg:sender:call-3"]])
    expect(cells(chat).map((row) => row.key).sort()).toEqual(["msg:sender:call-1", "msg:sender:call-2", "msg:sender:call-3"])
  })

  test("a live session refuses a message from itself before anything is held or reaches its control", async () => {
    const { manager, reader, delivery, cells } = await project()
    const chat = await manager.createChat({ name: "Open" })
    const received: ChatInput[] = []
    const unregister = registerLiveSessionControl(reader, {
      sessionId: chat,
      state: async () => "idle",
      deliver: async (input, decide) => {
        received.push(input)
        return decide("idle")
      },
      notify: async () => false,
    })
    try {
      expect(await deliverSessionInput(delivery, chat, { text: "to myself", producer: fromSession(chat) })).toEqual({ status: "refused", reason: "self" })
    } finally {
      unregister()
    }
    expect(received).toEqual([])
    expect(cells(chat)).toEqual([])
  })

  test("a live control that refuses takes the hold back", async () => {
    const { manager, reader, delivery, cells } = await project()
    const chat = await manager.createChat({ name: "Closing" })
    const unregister = registerLiveSessionControl(reader, { sessionId: chat, state: async () => "idle", deliver: async () => ({ status: "refused", reason: "settled" }), notify: async () => false })
    try {
      expect(await deliverSessionInput(delivery, chat, "too late")).toEqual({ status: "refused", reason: "settled" })
    } finally {
      unregister()
    }
    expect(cells(chat)).toEqual([])
  })

  test("a subagent: a session message to itself is refused, a settled run refuses, and a run no process runs holds", async () => {
    const { root, store, manager, delivery, cells } = await project()
    const parent = await manager.createChat({ name: "Parent" })
    const child = await publishTestSubagent(manager, root, "child", parent)
    expect(await deliverSessionInput(delivery, child, { text: "me", producer: fromSession(child) })).toEqual({ status: "refused", reason: "self" })
    expect(await deliverSessionInput(delivery, child, { text: "parked", producer: fromSession(parent) })).toEqual({ status: "held", reason: "no_reader" })
    store.append(prepareSessionFactAppend(child, buildSubagentCompleted({ childRunId: `${child}-run`, status: "failed", isError: true, content: "failed", durationMs: 0 })))
    expect(await deliverSessionInput(delivery, child, "too late")).toEqual({ status: "refused", reason: "settled" })
    expect(cells(child).map((row) => row.key)).toEqual([`msg:${parent}:call-1`])
  })

  test("at delete, the parent's returned notice commits in the same append as the tombstone and every other sender gets one notice", async () => {
    const batches: EventStoreAppend[][] = []
    const root = makeTmpDir()
    const base = makeDepsWithStore(root)
    const inner = asAsyncEventWriter(base.store)
    const writer: AsyncEventWriter = {
      ...inner,
      appendBatch: async (events) => {
        batches.push([...events])
        return inner.appendBatch(events)
      },
    }
    const manager = createSessionManager({ ...base.deps, writer })
    const store = base.store
    const parent = await manager.createChat({ id: "parent", conversationId: "parent-conversation", name: "Parent" })
    const sibling = await manager.createChat({ id: "sibling", conversationId: "sibling-conversation", name: "Sibling" })
    const child = await publishTestSubagent(manager, root, "child", parent, "parent-conversation")
    await holdQueuedUserInput(writer, child, { target: "conversation", conversationId: "child-conversation" }, { text: "parent asks", producer: fromSession(parent) })
    await holdQueuedUserInput(writer, child, { target: "conversation", conversationId: "child-conversation" }, { text: "sibling asks", producer: fromSession(sibling) })

    await finalizeTestSessionDeletion(manager, child)

    const tombstone = batches.find((batch) => batch.some((event) => event.type === "session.deleted"))
    const unlink = tombstone?.find((event) => event.type === "session.child.unlinked")
    expect(unlink?.inFlight?.map((write) => "kind" in write ? write.kind : write.op)).toEqual([QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND])
    const parentNotices = store.readInFlight(parent, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)
    const siblingNotices = store.readInFlight(sibling, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)
    expect(parentNotices).toHaveLength(1)
    expect(siblingNotices).toHaveLength(1)
    expect(String(parentNotices[0]?.payload.text)).toContain("parent asks")
    expect(String(parentNotices[0]?.payload.text)).not.toContain("sibling asks")
    expect(parentNotices[0]?.payload.conversationId).toBe("parent-conversation")
    expect(String(siblingNotices[0]?.payload.text)).toContain("sibling asks")
    expect(String(siblingNotices[0]?.payload.text)).toContain('reason="deleted"')
    expect(store.readInFlight(child, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toEqual([])
  })

  test("an end that stores nothing returns nothing, and a message that arrives while a recipient ends returns once", async () => {
    const { reader, writer, cells, notices } = await project()
    const conversation = { target: "conversation" as const, conversationId: "recipient-conversation" }
    await holdQueuedUserInput(writer, "recipient", conversation, { text: "early", producer: fromSession("sibling") })
    const settle = (end: () => Promise<boolean>, committed: string[] = []) => settleUnreadMessages({ reader, writer }, {
      recipientSessionId: "recipient",
      reason: "settled",
      end,
      commitHeld: async (person) => { committed.push(...person.map((cell) => cell.text)) },
    })

    expect(await settle(async () => false)).toEqual({ stored: false })
    expect(cells("recipient")).toHaveLength(1)
    expect(notices("sibling")).toEqual([])

    const committed: string[] = []
    expect(await settle(async () => {
      await holdQueuedUserInput(writer, "recipient", conversation, { text: "late", producer: fromSession("other") })
      await holdQueuedUserInput(writer, "recipient", conversation, "the person's late note")
      return true
    }, committed)).toMatchObject({ stored: true })
    expect(notices("sibling").map((row) => String(row.payload.text))).toEqual([expect.stringContaining("early")])
    expect(notices("other").map((row) => String(row.payload.text))).toEqual([expect.stringContaining("late")])
    expect(committed).toEqual(["the person's late note"])
    expect(cells("recipient").map((row) => String(row.payload.text))).toEqual(["the person's late note"])
  })

  test("a delete stores when the parent's returned notice already stands from a return that a crash cut", async () => {
    const root = makeTmpDir()
    const { deps, store } = makeDepsWithStore(root)
    const manager = createSessionManager(deps)
    const writer = asAsyncEventWriter(store)
    const parent = await manager.createChat({ id: "parent", conversationId: "parent-conversation", name: "Parent" })
    const child = await publishTestSubagent(manager, root, "child", parent, "parent-conversation")
    const key = await holdQueuedUserInput(writer, child, { target: "conversation", conversationId: "child-conversation" }, { text: "parent asks", producer: fromSession(parent) })
    // The return held the parent's notice, and the process died before it
    // dropped the child's cell.
    await holdQueuedBackgroundNotification(writer, parent, "parent-conversation", "parent asks, returned", `returned:${child}:${key}`)

    await finalizeTestSessionDeletion(manager, child)

    expect(await manager.read(child)).toBeNull()
    expect(store.readInFlight(child, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toEqual([])
    const parentNotices = store.readInFlight(parent, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)
    expect(parentNotices).toHaveLength(1)
    expect(String(parentNotices[0]?.payload.text)).toContain("parent asks")
  })

  test("a delete that fails keeps the unread messages, and its retry converges on one notice", async () => {
    const root = makeTmpDir()
    const base = makeDepsWithStore(root)
    const inner = asAsyncEventWriter(base.store)
    let failTombstone = true
    const writer: AsyncEventWriter = {
      ...inner,
      appendBatch: async (events) => {
        if (failTombstone && events.some((event) => event.type === "session.deleted")) {
          failTombstone = false
          throw new Error("injected tombstone failure")
        }
        return inner.appendBatch(events)
      },
    }
    const manager = createSessionManager({ ...base.deps, writer })
    const store = base.store
    const parent = await manager.createChat({ id: "parent", conversationId: "parent-conversation", name: "Parent" })
    const sibling = await manager.createChat({ id: "sibling", conversationId: "sibling-conversation", name: "Sibling" })
    const child = await publishTestSubagent(manager, root, "child", parent, "parent-conversation")
    await holdQueuedUserInput(writer, child, { target: "conversation", conversationId: "child-conversation" }, { text: "sibling asks", producer: fromSession(sibling) })

    await expect(finalizeTestSessionDeletion(manager, child)).rejects.toThrow("injected tombstone failure")
    expect(store.readInFlight(child, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toHaveLength(1)

    await finalizeTestSessionDeletion(manager, child)
    expect(store.readInFlight(child, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toEqual([])
    expect(store.readInFlight(sibling, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toHaveLength(1)
  })

  test("an agent's returned private message stays in its original conversation and never becomes workflow input", async () => {
    const root = makeTmpDir()
    const { deps, store } = makeDepsWithStore(root)
    const manager = createSessionManager(deps)
    const reader = asAsyncEventReadSurface(store)
    const writer = asAsyncEventWriter(store)
    const parent = await manager.createChat({ id: "parent", conversationId: "parent-conversation", name: "Parent" })
    const workflow = await publishTestWorkflow(manager)
    const member = await startTestWorkflowMember(manager, store, workflow)
    const session = await manager.read(member)
    if (session?.kind !== "workflow-agent") throw new Error("Expected an agent member")
    const child = await publishTestSubagent(manager, root, "child", parent, "parent-conversation")
    const producer: SessionInputProducer = { kind: "session", sessionId: member, conversationId: session.conversationId, toolUseId: "call-1", hop: 0 }
    await holdQueuedUserInput(writer, child, { target: "conversation", conversationId: "child-conversation" }, { text: "workflow asks", producer })
    await finalizeTestSessionDeletion(manager, child)
    expect(await readConversationBackgroundNotifications(reader, member, session.conversationId)).toMatchObject([{ text: expect.stringContaining("workflow asks") }])
    expect(await readWorkflowBackgroundNotifications(reader, workflow)).toEqual([])
    expect(await readConversationBackgroundNotifications(reader, member, "successor-conversation")).toEqual([])
  })
})

import { afterEach, describe, expect, it, setSystemTime } from "bun:test"
import { EventBus } from "../../../../src/infra/event-bus"
import type { PausedBy } from "../../../../src/infra/output-blocks"
import { createChatSession, type ChatSessionDeps } from "../../../../src/orchestration/chat/session"
import type { ChatRunner } from "../../../../src/orchestration/chat/runner-types"
import type { StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types"
import type { RuntimeInterruption } from "../../../../src/orchestration/session/conversation/turn-end-record"
import type { SessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"
import { newTestRunner } from "../../../helpers/agent-runner.js"
import { asModelClient } from "../agent-runtime/_model-client"
import { appendTurnEnd, captureBlocks, createSessionFactWriter, createStoredChatSession, createTestChatSessionDeps, makeMemoryTreeWriter } from "./_chat-session-agent-runtime-fixtures"
import type { BackgroundWorkResult } from "../../../../src/orchestration/agent-runtime/background-work.js"
import { interruptedTurnEnd, type TurnEnd } from "../../../../src/orchestration/session/conversation/turn-end-record.js"
import type { ConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree.js"
import { CONTINUATION_MESSAGES } from "../../../../src/orchestration/agent-runtime/continuation-messages.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js"
import { recoverProject } from "../../../helpers/project-recovery.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { createSupervisorTestContext, disposeSupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { publishTestSubagent } from "../session/_session-manager-fixtures.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { authorizePlannedSessionContinuation } from "../../../../src/orchestration/session/planned-session-continuation.js"
import { prepareSessionFactAppend } from "../../../../src/orchestration/session/session-fact-writer.js"
import { buildSubagentPaused } from "../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers.js"
import { registerTestChildRun } from "../../../helpers/live-child-run.js"
import { dropReplyWait, holdReplyWait } from "../../../../src/orchestration/session/conversation/reply-wait-cells.js"
import { readChatTurnEndEvidence } from "../../../../src/orchestration/session/chat-session-run-evidence.js"
import { messageDisposition } from "../../../../src/orchestration/session/live-session-control.js"

const ASK_ID = "ask-1"

describe("a restored background wait", () => {
  const temporary = temporaryDirectories()
  // Close chat's row: the cut came while the turn waited on a background
  // command, and the close killed that command, whose notice lands before
  // the reopen's hold (PI-INTERACTION-082). It waits for the person.
  it.each([
    { label: "a completion", end: interruptedTurnEnd("replacement"), message: "The build completed while the runtime was down.", requests: 1 },
    { label: "a Resume that already began", end: interruptedTurnEnd("replacement"), message: CONTINUATION_MESSAGES.resumed, requests: 0 },
    { label: "the notice of the command Close chat ended", end: interruptedTurnEnd("close"), message: "Background command ended by signal SIGTERM", requests: 0 },
  ])("reads $label committed during downtime without an unsolicited request or continuation", async ({ end, message, requests }) => {
    const projectRoot = temporary("chat-restored-completion-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const { chat, calls, parks, parked } = await createStoredChatSession({
      sessionId: "chat-restored", conversationId: "conversation-restored", projectRoot,
      reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store),
      seed: async (tree) => {
        await tree.appendMessage({ kind: "user", content: "wait for the build", origin: "human" })
        await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "wait", name: "process", input: { action: "wait", soft_timeout: 60 } }] })
        await tree.appendMessage({ kind: "toolResult", toolUseId: "wait", content: [{ type: "text", text: "Wait acknowledged." }] })
        await appendTurnEnd(tree, end)
        await tree.appendMessage({ kind: "user", origin: "system", content: message })
      },
    })
    const later = Promise.withResolvers<BackgroundWorkResult>()
    try {
      await chat.hold()
      await parked(1)
      expect(calls).toHaveLength(requests)
      if (requests > 0) {
        expect(JSON.stringify(calls[0])).toContain(message)
        expect(JSON.stringify(calls[0])).not.toContain("nothing_pending")
        expect(JSON.stringify(calls[0])).not.toContain(CONTINUATION_MESSAGES.resumed)
      }
      if (end.closed !== true) return
      // A later completion, such as a workflow's, is recorded too; Resume continues with both.
      expect(await chat.messageState()).toBe("interrupted")
      chat.backgroundTasks.track({ done: later.promise, meta: { id: "workflow", type: "background_command", description: "workflow" } })
      later.resolve({ status: "completed", content: "the workflow finished" })
      await parked(2)
      expect(parks).toEqual([true, true])
      expect(calls).toHaveLength(0)
      expect(chat.resume({ announce: false })).toBe(true)
      await parked(3)
      expect(calls).toHaveLength(1)
      for (const text of [message, "the workflow finished", CONTINUATION_MESSAGES.resumed]) expect(JSON.stringify(calls[0])).toContain(text)
    } finally {
      later.resolve({ status: "completed", content: "" })
      await chat.dispose()
      store.close()
    }
  })

  it("waits for an owed child to register before deciding whether anything is pending", async () => {
    const ctx = createSupervisorTestContext()
    const reader = asAsyncEventReadSurface(ctx.store)
    const writer = asAsyncEventWriter(ctx.store)
    let chat: ChatRunner | undefined
    let release: (() => void) | undefined
    try {
      const parent = await ctx.manager.createChat({ id: "parent", conversationId: "parent-conversation" })
      await publishTestSubagent(ctx.manager, ctx.baseDir, "child", parent, "parent-conversation")
      const childTree = await tryOpenConversationTree({ conversationId: "child-conversation", sessionId: "child", store: reader, writer })
      if (!childTree) throw new Error("missing child conversation")
      await appendTurnEnd(childTree, interruptedTurnEnd("replacement"))
      childTree.getStorage().dispose()
      await writer.append(prepareSessionFactAppend("child", buildSubagentPaused({ childRunId: "child-run", pausedBy: "runtime" })))
      await authorizePlannedSessionContinuation({ reader, writer, continuation: { target: { sessionId: "child", kind: "subagent" }, runId: "child-run", handoffId: "handoff" } })
      const stored = await createStoredChatSession({
        sessionId: parent, conversationId: "parent-conversation", projectRoot: ctx.baseDir, reader, writer,
        seed: async (tree) => {
          await tree.appendMessage({ kind: "user", content: "wait for the child", origin: "human" })
          await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "wait-child", name: "process", input: { action: "wait", soft_timeout: 60 } }] })
          await tree.appendMessage({ kind: "toolResult", toolUseId: "wait-child", content: [{ type: "text", text: "Wait acknowledged." }] })
          await appendTurnEnd(tree, interruptedTurnEnd("replacement"))
        },
      })
      chat = stored.chat
      await chat.hold()
      expect(stored.calls).toHaveLength(0)
      expect(stored.parks).toHaveLength(0)
      const task = Promise.withResolvers<BackgroundWorkResult>()
      chat.backgroundTasks.track({ done: task.promise, meta: { id: "child", type: "background_command", description: "child work" } })
      release = registerTestChildRun(reader, {
        sessionId: "child", runId: "child-run", parentSessionId: parent, parentConversationId: "parent-conversation",
        parentToolCallId: "parent-tool", stop: () => {}, interrupt: async () => {},
      })
      await stored.parked(1)
      expect(stored.calls).toHaveLength(0)
      expect(await chat.messageState()).toBe("waiting_on_work")
      task.resolve({ status: "completed", content: "child completed" })
      await stored.parked(2)
      expect(stored.calls).toHaveLength(1)
      expect(JSON.stringify(stored.calls[0])).not.toContain("nothing_pending")
      expect(JSON.stringify(stored.calls[0])).not.toContain("Managed work is still pending")
    } finally {
      release?.()
      await chat?.dispose()
      await disposeSupervisorTestContext(ctx)
    }
  })

  it.each([interruptedTurnEnd("replacement"), { reason: "crash" } as const].flatMap((end) =>
    (["process", "reply", "held_peer"] as const).map((kind) => ({ end, kind }))))("parks a $kind wait after $end.reason without a request, then completion wakes it without Resume", async ({ end, kind }) => {
    const projectRoot = temporary("chat-restored-wait-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    let finishedAt = 0
    const { chat, calls, parked } = await createStoredChatSession({
      sessionId: "chat-restored", conversationId: "conversation-restored", projectRoot,
      reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store),
      seed: async (tree) => {
        await tree.appendMessage({ kind: "user", content: "wait for the background build", origin: "human" })
        await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "wait-build", name: kind === "reply" ? "message_session" : "process", input: kind === "reply" ? { target: "session", to: "child", wait: true } : { action: "wait", soft_timeout: 60 } }] })
        await tree.appendMessage({ kind: "toolResult", toolUseId: "wait-build", content: [{ type: "text", text: "Wait acknowledged." }] })
        finishedAt = Date.parse((await tree.getBranch()).at(-1)!.timestamp)
        if (kind === "reply") await holdReplyWait(asAsyncEventWriter(store), "chat-restored", { addresseeSessionId: "child", toolUseId: "wait-build", openedAtMs: finishedAt })
        if (kind === "held_peer") await tree.appendMessage({
          kind: "user", content: "Held peer message", producer: { kind: "session", sessionId: "peer", conversationId: "peer-conversation", toolUseId: "peer-message", hop: 5, envelope: { name: "Peer", relation: "other", waits: false } },
        })
        await appendTurnEnd(tree, end)
      },
    })
    const task = Promise.withResolvers<BackgroundWorkResult>()
    try {
      chat.backgroundTasks.track({ done: task.promise, meta: { id: "build", type: "background_command", description: "build" }, ...(kind === "reply" ? { wait: true } : {}) })
      await chat.hold()
      await parked(1)
      expect(calls).toHaveLength(0)
      expect((await readChatTurnEndEvidence(asAsyncEventReadSurface(store), "conversation-restored", { restoreWait: true }))?.restoredWait).toEqual({ deadlineMs: finishedAt + (kind === "reply" ? 240_000 : 60_000), ...(end.reason === "crash" ? { parkOnly: true } : {}) })
      expect(await chat.messageState()).toBe("waiting_on_work")
      if (kind === "reply") {
        await dropReplyWait(asAsyncEventWriter(store), "chat-restored", { addresseeSessionId: "child", toolUseId: "wait-build" })
        await chat.deliverHeldMessage({
          text: "The child replied.", producer: { kind: "session", sessionId: "child", conversationId: "child-conversation", toolUseId: "reply", hop: 5, envelope: { name: "Child", relation: "child", waits: false } },
        }, (state) => messageDisposition({ state, origin: "session", hop: 5, relation: "child", self: false }))
      }
      task.resolve({ status: "completed", content: kind === "reply" ? "" : "build completed" })
      await parked(2)
      expect(calls).toHaveLength(1)
      expect(JSON.stringify(calls[0])).toContain(kind === "reply" ? "The child replied." : "build completed")
      expect(JSON.stringify(calls[0])).not.toContain(CONTINUATION_MESSAGES.resumed)
    } finally {
      task.resolve({ status: "completed", content: "" })
      await chat.dispose()
      store.close()
    }
  })

  const seedWait = (end: TurnEnd, after?: (tree: ConversationTree) => Promise<void>, kind: "process" | "reply" = "process") => async (tree: ConversationTree) => {
    await tree.appendMessage({ kind: "user", content: "wait for the child", origin: "human" })
    await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "wait-child", name: kind === "reply" ? "message_session" : "process", input: kind === "reply" ? { target: "session", to: "child", wait: true } : { action: "wait", soft_timeout: 60 } }] })
    await tree.appendMessage({ kind: "toolResult", toolUseId: "wait-child", content: [{ type: "text", text: "Wait acknowledged." }] })
    await appendTurnEnd(tree, end)
    await after?.(tree)
  }

  it.each([
    { label: "a planned replacement's cut", end: interruptedTurnEnd("replacement"), continues: true },
    { label: "an unexpected exit", end: { reason: "crash" } as const, continues: false },
    { label: "the runtime's ordinary interrupt", end: interruptedTurnEnd("runtime"), continues: false },
  ])("whose work is gone after $label answers nothing pending only under a successor's authority, and otherwise parks until resumed work completes", async ({ end, continues }) => {
    const projectRoot = temporary("chat-restored-nothing-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const { chat, calls, parks, parked } = await createStoredChatSession({
      sessionId: "chat-restored", conversationId: "conversation-restored", projectRoot,
      reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), seed: seedWait(end),
    })
    try {
      // The exit took the child down with its parent, so nothing the parent
      // waited on runs when its tab attaches the runner again.
      await chat.hold()
      await parked(1)
      if (continues) {
        expect(calls).toHaveLength(1)
        expect(JSON.stringify(calls[0])).toContain("nothing_pending")
        return
      }
      expect(calls).toHaveLength(0)
      expect(parks).toEqual([false])
      expect(await chat.messageState()).toBe("idle")
      // A person resumes the child, which counts as the parent's background
      // work again, and its completion wakes the parent's turn.
      const child = Promise.withResolvers<BackgroundWorkResult>()
      chat.backgroundTasks.track({ done: child.promise, meta: { id: "child", type: "background_command", description: "resumed child" } })
      child.resolve({ status: "completed", content: "the resumed child finished" })
      await parked(2)
      expect(calls).toHaveLength(1)
      expect(JSON.stringify(calls[0])).toContain("the resumed child finished")
      expect(JSON.stringify(calls[0])).not.toContain("nothing_pending")
      expect(JSON.stringify(calls[0])).not.toContain(CONTINUATION_MESSAGES.resumed)
    } finally {
      await chat.dispose()
      store.close()
    }
  })

  it.each([
    { label: "a planned replacement's cut", end: interruptedTurnEnd("replacement"), expires: true },
    { label: "an unexpected exit", end: { reason: "crash" } as const, expires: false },
  ])("whose deadline passed during downtime after $label expires only under a successor's authority, and otherwise waits for the work", async ({ end, expires }) => {
    const projectRoot = temporary("chat-restored-expired-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    // The wait batch finished ten minutes ago, so its 60-second deadline
    // passed while Flywheel was down.
    setSystemTime(new Date(Date.now() - 600_000))
    const stored = await createStoredChatSession({
      sessionId: "chat-restored", conversationId: "conversation-restored", projectRoot,
      reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), seed: seedWait(end),
    }).finally(() => { setSystemTime() })
    const { chat, calls, parked } = stored
    const work = Promise.withResolvers<BackgroundWorkResult>()
    try {
      chat.backgroundTasks.track({ done: work.promise, meta: { id: "child", type: "background_command", description: "child" } })
      await chat.hold()
      await parked(1)
      if (expires) {
        // The expiry fires once the restored wait parks.
        for (const deadline = Date.now() + 3000; calls.length === 0 && Date.now() < deadline;) await Bun.sleep(2)
        expect(calls.length).toBeGreaterThan(0)
        expect(JSON.stringify(calls[0])).toContain("wait_expired")
        return
      }
      // An expiry armed at zero would have fired by now.
      await Bun.sleep(10)
      expect(calls).toHaveLength(0)
      expect(await chat.messageState()).toBe("waiting_on_work")
      work.resolve({ status: "completed", content: "the child finished" })
      await parked(2)
      expect(calls).toHaveLength(1)
      expect(JSON.stringify(calls[0])).toContain("the child finished")
      expect(JSON.stringify(calls[0])).not.toContain("wait_expired")
    } finally {
      work.resolve({ status: "completed", content: "the child finished" })
      await chat.dispose()
      store.close()
    }
  })

  it("whose work is gone after an unexpected exit continues on the person's Resume", async () => {
    const projectRoot = temporary("chat-restored-resume-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const { chat, calls, parked } = await createStoredChatSession({
      sessionId: "chat-restored", conversationId: "conversation-restored", projectRoot,
      reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), seed: seedWait({ reason: "crash" }),
    })
    try {
      await chat.hold()
      await parked(1)
      expect(calls).toHaveLength(0)
      expect(chat.resume({ announce: false })).toBe(true)
      await parked(2)
      expect(calls).toHaveLength(1)
      expect(JSON.stringify(calls[0])).toContain(CONTINUATION_MESSAGES.resumed)
      expect(JSON.stringify(calls[0])).not.toContain("nothing_pending")
    } finally {
      await chat.dispose()
      store.close()
    }
  })

  it.each([
    { label: "no successor holds its continuation", authorized: false, kind: "process" },
    { label: "a successor still holds its continuation", authorized: true, kind: "process" },
    { label: "no successor holds its continuation", authorized: false, kind: "reply" },
  ] as const)("cut by a planned replacement and then by an unexpected exit of its owner keeps its $kind deadline only when $label", async ({ authorized, kind }) => {
    const projectRoot = temporary("chat-restored-successor-exit-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const reader = asAsyncEventReadSurface(store)
    const writer = asAsyncEventWriter(store)
    const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store, writer })
    const sessionId = await manager.createChat({ name: "waiting", initialState: "active" })
    const session = await manager.read(sessionId)
    if (session?.kind !== "chat") throw new Error("expected a chat")
    const { conversationId } = session
    // The wait batch finished ten minutes ago, so its 60-second deadline
    // passed while Flywheel was down.
    setSystemTime(new Date(Date.now() - 600_000))
    try {
      const tree = await tryOpenConversationTree({ sessionId, conversationId, store: reader, writer })
      if (!tree) throw new Error("the chat has no conversation tree")
      try {
        await seedWait(interruptedTurnEnd("replacement"), undefined, kind)(tree)
        if (kind === "reply") await holdReplyWait(writer, sessionId, { addresseeSessionId: "child", toolUseId: "wait-child", openedAtMs: Date.now() })
      } finally { tree.getStorage().dispose() }
    } finally { setSystemTime() }
    // A successor that took over the cut wait retired the row; the
    // predecessor of a replacement still in progress holds it.
    if (authorized) await authorizePlannedSessionContinuation({ reader, writer, continuation: { target: { sessionId, kind: "chat" }, handoffId: "handoff" } })
    // The owner of the active chat is gone, and the next generation recovers it.
    expect((await recoverProject({ directories: testDirectories(projectRoot), reader, writer }, "closed-generation")).sessionIds).toEqual([sessionId])
    const { chat, calls, parked, turnEnds } = await createStoredChatSession({ sessionId, conversationId, projectRoot, reader, writer, seed: async () => {} })
    const work = Promise.withResolvers<BackgroundWorkResult>()
    try {
      expect(await turnEnds()).toEqual(authorized ? [interruptedTurnEnd("replacement")] : [interruptedTurnEnd("replacement"), { reason: "crash" }])
      chat.backgroundTasks.track({ done: work.promise, meta: { id: "child", type: "background_command", description: "child" }, ...(kind === "reply" ? { wait: true } : {}) })
      await chat.hold()
      await parked(1)
      if (authorized) {
        for (const deadline = Date.now() + 3000; calls.length === 0 && Date.now() < deadline;) await Bun.sleep(2)
        expect(calls.length).toBeGreaterThan(0)
        expect(JSON.stringify(calls[0])).toContain("wait_expired")
        return
      }
      // An expiry armed at zero would have fired by now.
      await Bun.sleep(10)
      expect(calls).toHaveLength(0)
      expect(await chat.messageState()).toBe("waiting_on_work")
      if (kind === "reply") return
      work.resolve({ status: "completed", content: "the child finished" })
      await parked(2)
      expect(calls).toHaveLength(1)
      expect(JSON.stringify(calls[0])).toContain("the child finished")
      expect(JSON.stringify(calls[0])).not.toContain("wait_expired")
    } finally {
      work.resolve({ status: "completed", content: "the child finished" })
      await chat.dispose()
      store.close()
    }
  })

  it("that an unexpected exit cut keeps no deadline under the successor of a later planned replacement", async () => {
    const projectRoot = temporary("chat-restored-successor-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const reader = asAsyncEventReadSurface(store)
    const writer = asAsyncEventWriter(store)
    // The wait batch finished ten minutes ago, so its 60-second deadline
    // passed long before the successor attaches.
    setSystemTime(new Date(Date.now() - 600_000))
    const first = await createStoredChatSession({
      sessionId: "chat-restored", conversationId: "conversation-restored", projectRoot, reader, writer, seed: seedWait({ reason: "crash" }),
    }).finally(() => { setSystemTime() })
    const work = Promise.withResolvers<BackgroundWorkResult>()
    let second: Awaited<ReturnType<typeof createStoredChatSession>> | undefined
    try {
      // The replacement hands the work over, so the predecessor's teardown
      // neither kills nor awaits it.
      first.chat.backgroundTasks.track({ done: work.promise, meta: { id: "child", type: "background_command", description: "child" }, hostClose: "detach" })
      await first.chat.hold()
      await first.parked(1)
      expect(await first.chat.interruptForReplacement()).toBe(true)
      expect(await first.turnEnds()).toEqual([{ reason: "crash" }, interruptedTurnEnd("replacement")])
      await first.chat.dispose()
      second = await createStoredChatSession({
        sessionId: "chat-restored", conversationId: "conversation-restored", projectRoot, reader, writer, seed: async () => {},
      })
      second.chat.backgroundTasks.track({ done: work.promise, meta: { id: "child", type: "background_command", description: "child" } })
      await second.chat.hold()
      await second.parked(1)
      // An expiry armed at zero would have fired by now.
      await Bun.sleep(10)
      expect(first.calls).toHaveLength(0)
      expect(second.calls).toHaveLength(0)
      expect(await second.chat.messageState()).toBe("waiting_on_work")
      work.resolve({ status: "completed", content: "the child finished" })
      await second.parked(2)
      expect(second.calls).toHaveLength(1)
      expect(JSON.stringify(second.calls[0])).toContain("the child finished")
      expect(JSON.stringify(second.calls[0])).not.toContain("wait_expired")
    } finally {
      work.resolve({ status: "completed", content: "the child finished" })
      await first.chat.dispose()
      await second?.chat.dispose()
      store.close()
    }
  })

  it.each(["during downtime", "after the attach"] as const)("whose work is gone wakes once for a message from another session delivered %s", async (when) => {
    const projectRoot = temporary("chat-restored-peer-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const peer = { name: "Peer", relation: "other", waits: false } as const
    const producer = { kind: "session", sessionId: "peer", conversationId: "peer-conversation", toolUseId: "peer-message", hop: 0, envelope: peer } as const
    const { chat, calls, parked } = await createStoredChatSession({
      sessionId: "chat-restored", conversationId: "conversation-restored", projectRoot,
      reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store),
      seed: seedWait({ reason: "crash" }, async (tree) => {
        if (when === "during downtime") await tree.appendMessage({ kind: "user", content: "A peer asks for the status.", producer })
      }),
    })
    try {
      await chat.hold()
      if (when === "after the attach") {
        await parked(1)
        expect(calls).toHaveLength(0)
        await chat.deliverHeldMessage({ text: "A peer asks for the status.", producer }, (state) => messageDisposition({ state, origin: "session", hop: 0, relation: "other", self: false }))
      }
      await parked(when === "after the attach" ? 2 : 1)
      expect(calls).toHaveLength(1)
      expect(JSON.stringify(calls[0])).toContain("A peer asks for the status.")
      expect(JSON.stringify(calls[0])).not.toContain("nothing_pending")
    } finally {
      await chat.dispose()
      store.close()
    }
  })
})

type FirstReply = "asks" | "answers" | "streams" | "silent"

/** A chat whose first turn asks a question and waits on the person, with
 *  every durable write it makes recorded in order. */
async function askingChat(log: string[], updateEntry?: ChatSessionDeps["updateEntry"]): Promise<ChatRunner> {
  const session = await scriptedChat(log, "asks", updateEntry)
  const deadline = Date.now() + 2_000
  while (!log.includes("agent_input.requested") && Date.now() < deadline) await Bun.sleep(5)
  expect(log).toContain("agent_input.requested")
  return session
}

/** A chat whose first turn answers and parks, its turn finished. */
async function answeredChat(log: string[]): Promise<ChatRunner> {
  const session = await scriptedChat(log, "answers")
  const deadline = Date.now() + 2_000
  while (!log.includes("turn-parked") && Date.now() < deadline) await Bun.sleep(5)
  expect(log).toContain("turn-parked")
  return session
}

/** A chat whose first turn streams until it is cut. */
async function streamingChat(log: string[], updateEntry: ChatSessionDeps["updateEntry"]): Promise<ChatRunner> {
  const session = await scriptedChat(log, "streams", updateEntry)
  const deadline = Date.now() + 2_000
  while (!log.includes("streaming") && Date.now() < deadline) await Bun.sleep(5)
  expect(log).toContain("streaming")
  return session
}

/** A chat whose first reply says nothing, so its turn's logical end is
 *  followed by the request of the reply nudge, which streams until it is cut. */
async function nudgingChat(log: string[]): Promise<ChatRunner> {
  const session = await scriptedChat(log, "silent")
  const deadline = Date.now() + 2_000
  while (!log.includes("nudge-streaming") && Date.now() < deadline) await Bun.sleep(5)
  expect(log).toContain("nudge-streaming")
  return session
}

async function scriptedChat(log: string[], first: FirstReply, updateEntry?: ChatSessionDeps["updateEntry"]): Promise<ChatRunner> {
  const facts = createSessionFactWriter()
  const sessionEventWriter: SessionFactWriter = {
    ...facts,
    record: async (fact, contentRows, inFlight) => {
      log.push(fact.type === "agent_input.withdrawn" ? `withdrawn:${JSON.stringify(fact.payload)}` : fact.type)
      return facts.record(fact, contentRows, inFlight)
    },
  }
  const treeWriter = makeMemoryTreeWriter()
  let requests = 0
  const createClient = async () => asModelClient({
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test",
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    promptNotes: { progress: "", modelNotes: "" },
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
    async *streamWithTools(options: StreamOptions) {
      const request = requests++
      if (first === "silent" && request === 1) {
        log.push("nudge-streaming")
        await new Promise<void>((resolve) => { options.signal?.addEventListener("abort", () => resolve(), { once: true }) })
        return
      }
      // Only the first request asks; any later one would mean the question
      // did not park the turn, and waits to be cut rather than spinning.
      if (request > 0) {
        log.push("unexpected-request")
        await new Promise<void>((resolve) => { options.signal?.addEventListener("abort", () => resolve(), { once: true }) })
        return
      }
      if (first === "streams") {
        yield { kind: "text_delta", text: "Working.", blockKey: "b0" } as const
        log.push("streaming")
        await new Promise<void>((resolve) => { options.signal?.addEventListener("abort", () => resolve(), { once: true }) })
        return
      }
      if (first === "silent") {
        yield { kind: "done", stopReason: "end_turn" } as const
        return
      }
      if (first === "answers") {
        yield { kind: "text_delta", text: "Done.", blockKey: "b0" } as const
        yield { kind: "done", stopReason: "end_turn" } as const
        return
      }
      yield { kind: "text_delta", text: "One decision is needed.", blockKey: "b0" } as const
      yield { kind: "tool_use", toolCall: { id: ASK_ID, name: "ask_user", input: { context: "One decision is needed before this continues.", question: "Proceed?", header: "Go", options: [{ label: "Yes" }, { label: "No" }] } } } as const
      yield { kind: "done", stopReason: "tool_use" } as const
    },
  })
  const defaults = createTestChatSessionDeps({ sessionId: "asking-chat", createAgent: () => { throw new Error("replaced below") } })
  const eventBus = new EventBus()
  eventBus.subscribeToType("agent.turn.parked", () => { log.push("turn-parked") }, { deliveryClass: "ui", label: "test-turn-parked" })
  const session = await createChatSession({ onError: () => {}, onEnded: () => {} }, createTestChatSessionDeps({
    sessionId: "asking-chat",
    createAgent: (options) => newTestRunner(options, createClient),
    eventBus,
    ...(updateEntry ? { updateEntry } : {}),
    infra: { ...defaults.infra, sessionEventWriter },
    treeWriter: {
      ...treeWriter,
      async commitTurnEnd(by: PausedBy) {
        log.push(`turn-end:${by}`)
        return treeWriter.commitTurnEnd(by)
      },
    },
  }))
  void session.send(first === "asks" ? "Ask me before continuing" : "Answer and stop")
  return session
}

describe("a chat turn parked on a question", () => {
  let session: ChatRunner | null = null
  afterEach(async () => {
    await session?.dispose()
    session = null
  })

  it("is not running work for a planned replacement's cut: the cut leaves it, and nothing is withdrawn or recorded", async () => {
    const log: string[] = []
    session = await askingChat(log)
    expect(session.holdsRunningTurn()).toBe(false)
    expect(await session.interruptForReplacement()).toBe(false)
    expect(log.some((entry) => entry.startsWith("withdrawn:"))).toBe(false)
    expect(log.filter((entry) => entry.startsWith("turn-end:"))).toEqual([])
  })

  it("that a person already interrupted is left parked for the person: the replacement neither waits on it nor records over it", async () => {
    const log: string[] = []
    session = await askingChat(log)
    expect(session.interrupt()).toBe(true)
    // A cut that waited on the parked turn would never settle, and the test would time out.
    expect(await session.interruptForReplacement()).toBe(false)
    expect(log).not.toContain("turn-end:replacement")
  })

  it.each(["replacement", "runtime"] as const)("keeps its question through a stop as %s, for the person to answer after the restart", async (by) => {
    const log: string[] = []
    const blocks = captureBlocks()
    session = await askingChat(log, blocks.updateEntry)
    session.prepareForShutdown(by)
    await session.dispose()
    session = null
    expect(log.some((entry) => entry.startsWith("withdrawn:"))).toBe(false)
    expect(log).not.toContain("agent_input.cancelled")
    expect(log).not.toContain("agent_input.answered")
    expect(log.filter((entry) => entry.startsWith("turn-end:"))).toEqual([])
    const question = blocks.blocks().find((block) => block.kind === "question" && block.toolUseId === ASK_ID)
    expect(question).toBeDefined()
    expect(question).not.toHaveProperty("answers")
    expect(question).not.toHaveProperty("cancelled")
    expect(blocks.blocks().filter((block) => block.kind === "system" && block.message.startsWith("Interrupted"))).toEqual([])
  })
})

describe("a chat whose turn has answered", () => {
  it("gets nothing written by an ordinary stop: no turn end, no interrupt", async () => {
    const log: string[] = []
    const session = await answeredChat(log)
    session.prepareForShutdown("runtime")
    await session.dispose()
    expect(log.filter((entry) => entry.startsWith("turn-end:"))).toEqual([])
    expect(log).not.toContain("unexpected-request")
  })
})

describe("a chat whose silent reply drew the reply nudge", () => {
  let session: ChatRunner | null = null
  afterEach(async () => {
    await session?.dispose()
    session = null
  })

  // The turn's logical end is reported before the nudge's request, so only
  // the runner can say that the turn still runs.
  it("holds its running turn while the nudge's request streams, and a planned replacement's cut ends that turn as the planned cut", async () => {
    const log: string[] = []
    session = await nudgingChat(log)
    expect(session.holdsRunningTurn()).toBe(true)
    expect(await session.interruptForReplacement()).toBe(true)
    expect(log.filter((entry) => entry.startsWith("turn-end:"))).toEqual(["turn-end:replacement"])
    expect(session.holdsRunningTurn()).toBe(false)
  })
})

describe("a streaming chat turn", () => {
  let session: ChatRunner | null = null
  afterEach(async () => {
    await session?.dispose()
    session = null
  })

  it("that the planned cut ended takes a person's interrupt over the cut, recorded and shown as theirs; while it runs, only the ordinary interrupt applies", async () => {
    const log: string[] = []
    const blocks = captureBlocks()
    session = await streamingChat(log, blocks.updateEntry)
    expect(await session.interruptPlannedCut("person")).toBe("running")
    expect(await session.interruptForReplacement()).toBe(true)

    expect(await session.interruptPlannedCut("person")).toBe("recorded")
    expect(log.filter((entry) => entry.startsWith("turn-end:"))).toEqual(["turn-end:replacement", "turn-end:person"])
    expect(blocks.blocks()).toContainEqual(expect.objectContaining({ kind: "system", message: "Interrupted" }))
  })

  it("that the planned cut ended answers a person's interrupt with ended once a stop has ended its runner, and records nothing, so its caller records the person's turn end", async () => {
    const log: string[] = []
    const runner = await streamingChat(log, captureBlocks().updateEntry)
    expect(await runner.interruptForReplacement()).toBe(true)

    await runner.dispose()

    expect(await runner.interruptPlannedCut("person")).toBe("ended")
    expect(log.filter((entry) => entry.startsWith("turn-end:"))).toEqual(["turn-end:replacement"])
  })

  const stops: { by: RuntimeInterruption; turnEnds: string[]; shown: string[] }[] = [
    { by: "replacement", turnEnds: ["turn-end:replacement"], shown: [] },
    { by: "runtime", turnEnds: ["turn-end:runtime"], shown: ["Interrupted by the runtime"] },
  ]
  it.each(stops)("that a stop ends as $by records that turn end and shows the interruptions $shown: a stop a planned replacement owns shows none", async ({ by, turnEnds, shown }) => {
    const log: string[] = []
    const blocks = captureBlocks()
    session = await streamingChat(log, blocks.updateEntry)
    session.prepareForShutdown(by)
    await session.dispose()
    session = null
    expect(log.filter((entry) => entry.startsWith("turn-end:"))).toEqual(turnEnds)
    expect(blocks.blocks().flatMap((block) => block.kind === "system" && block.message.startsWith("Interrupted") ? [block.message] : [])).toEqual(shown)
  })
})

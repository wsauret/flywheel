import { describe, expect, it, setSystemTime } from "bun:test"
import type { ChatRunner } from "../../../../src/orchestration/chat/runner-types"
import { appendTurnEnd, createStoredChatSession } from "./_chat-session-agent-runtime-fixtures"
import type { BackgroundWorkResult } from "../../../../src/orchestration/agent-runtime/background-work.js"
import { contextResetRecordId, interruptedTurnEnd, type TurnEnd } from "../../../../src/orchestration/session/conversation/turn-end-record.js"
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
import { SILENT_REPLY_NUDGE } from "../../../../src/orchestration/agent-runtime/reply-nudge.js"

describe("a restored background wait", () => {
  const temporary = temporaryDirectories()
  // Close chat's row: the cut came while the turn waited on a background
  // command, and the close killed that command, whose notice lands before
  // the reopen's hold (PI-INTERACTION-119). It waits for the person.
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
    (["process", "reply", "held_peer", "nudged", "compacted", "woken", "compact_parked"] as const).map((kind) => ({ end, kind }))))("parks a $kind wait after $end.reason without a request, then completion wakes it without Resume", async ({ end, kind }) => {
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
        // Requests that only re-drove the waiting turn before it parked: the
        // reply nudge, then a compaction, then the text reply that the nudge
        // asked for. The open wait and its deadline outlive them.
        if (kind === "nudged" || kind === "compacted") {
          await tree.appendMessage({ kind: "user", content: SILENT_REPLY_NUDGE, origin: "system" })
          if (kind === "compacted") await tree.appendCompaction({ sourceLeafId: (await tree.getLeafId())!, tokensBefore: 1000, tokensAfter: 100, opening: [{ message: { kind: "user", content: "Your notes.", origin: "system" } }] })
          await tree.appendMessage({ kind: "assistant", content: [{ type: "text", text: "Watching the build; I will report when it ends." }] })
        }
        // The turn parked on its wait, and a person's /compact reset its
        // context with no request after it: the reset re-drove nothing.
        if (kind === "compact_parked") {
          await tree.appendMessage({ kind: "assistant", content: [{ type: "text", text: "Watching the build." }] })
          await tree.appendMessage({ kind: "user", content: "Save one concise checkpoint.", origin: "system" })
          await tree.appendMessage({ kind: "assistant", content: [{ type: "text", text: "Saved." }] })
          await tree.appendCompaction({ sourceLeafId: (await tree.getLeafId())!, tokensBefore: 1000, tokensAfter: 100, opening: [{ message: { kind: "user", content: "Your notes.", origin: "system" }, id: contextResetRecordId() }] })
        }
        // A background notification woke the wait, so the text reply after
        // it holds only the runtime's default wait, dated from that reply.
        if (kind === "woken") {
          await tree.appendMessage({ kind: "user", content: "<background_command_notification>lint ended</background_command_notification>", origin: "system", replyRequired: true })
          await tree.appendMessage({ kind: "assistant", content: [{ type: "text", text: "Lint passed; the build still runs." }] })
          finishedAt = Date.parse((await tree.getBranch()).at(-1)!.timestamp)
        }
        await appendTurnEnd(tree, end)
      },
    })
    // A reply wait has no expiry, as the live loop opens it.
    const seconds = { process: 60, reply: undefined, held_peer: 60, nudged: 60, compacted: 60, woken: 240, compact_parked: 60 }
    const task = Promise.withResolvers<BackgroundWorkResult>()
    try {
      chat.backgroundTasks.track({ done: task.promise, meta: { id: "build", type: "background_command", description: "build" }, ...(kind === "reply" ? { wait: true } : {}) })
      await chat.hold()
      await parked(1)
      expect(calls).toHaveLength(0)
      expect((await readChatTurnEndEvidence(asAsyncEventReadSurface(store), "conversation-restored", { restoreWait: true }))?.restoredWait).toEqual({ ...(seconds[kind] === undefined ? {} : { expiry: { seconds: seconds[kind], deadlineMs: finishedAt + seconds[kind] * 1000 } }), replyWaitIds: kind === "reply" ? ["wait-build"] : [], ...(end.reason === "crash" ? { parkOnly: true } : {}) })
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

  const seedWait = (end: TurnEnd, after?: (tree: ConversationTree) => Promise<void>, kind: "process" | "reply" = "process", before?: (tree: ConversationTree) => Promise<void>) => async (tree: ConversationTree) => {
    await tree.appendMessage({ kind: "user", content: "wait for the child", origin: "human" })
    await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "wait-child", name: kind === "reply" ? "message_session" : "process", input: kind === "reply" ? { target: "session", to: "child", wait: true } : { action: "wait", soft_timeout: 60 } }] })
    await tree.appendMessage({ kind: "toolResult", toolUseId: "wait-child", content: [{ type: "text", text: "Wait acknowledged." }] })
    await before?.(tree)
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

  it.each([
    { label: "a planned replacement's successor", end: interruptedTurnEnd("replacement"), continues: true },
    { label: "a person after an unexpected exit", end: { reason: "crash" } as const, continues: false },
  ])("cut in the middle of a waiting turn, the Resume of $label keeps the open wait only under continuation authority", async ({ end, continues }) => {
    const projectRoot = temporary("chat-continued-wait-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const { chat, calls, parked } = await createStoredChatSession({
      sessionId: "chat-continued", conversationId: "conversation-continued", projectRoot,
      reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store),
      // The turn waited, a session message re-drove it, and the cut came
      // while the loop ran the request after a tool batch without a wait.
      seed: seedWait(end, undefined, "process", async (tree) => {
        await tree.appendMessage({ kind: "assistant", content: [{ type: "text", text: "Watching the child." }] })
        await tree.appendMessage({ kind: "user", content: "A note.", producer: { kind: "session", sessionId: "peer", conversationId: "peer-conversation", toolUseId: "peer-message", hop: 0, envelope: { name: "Peer", relation: "other", waits: false } } })
        await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "list-1", name: "process", input: { action: "list" } }] })
        await tree.appendMessage({ kind: "toolResult", toolUseId: "list-1", content: [{ type: "text", text: "child running" }] })
      }),
    })
    const task = Promise.withResolvers<BackgroundWorkResult>()
    try {
      chat.backgroundTasks.track({ done: task.promise, meta: { id: "child", type: "background_command", description: "child work" } })
      await chat.hold()
      await parked(1)
      expect(calls).toHaveLength(0)
      expect(chat.resume({ announce: false })).toBe(true)
      await parked(2)
      // With the wait open, the answer parks on it. A person's Resume ended
      // it, so the runtime first nudges about the pending work.
      expect(calls).toHaveLength(continues ? 1 : 2)
      expect(JSON.stringify(calls.at(-1))).toContain(continues ? CONTINUATION_MESSAGES.resumed : "Managed work is still pending")
      expect(await chat.messageState()).toBe("waiting_on_work")
    } finally {
      task.resolve({ status: "completed", content: "" })
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

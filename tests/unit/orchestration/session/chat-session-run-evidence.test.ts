import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { asAsyncEventReadSurface, asAsyncEventWriter, CorruptEventRowError, StateRequestNotServedError, type AsyncEventStateReadSurface } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { chatSessionActions, readChatTurnEnd, readPendingTurnEnd, readPendingTurnEnds, readWorkflowAgentTurnEnds, resumableAgentTurnEnd, workflowSessionActions, workflowToolCall } from "../../../../src/orchestration/session/chat-session-run-evidence.js"
import { phaseBindings, phaseControl, startNext, interrupt } from "../../workflows/vm/_tree-fixtures.js"
import { flattenWorkflowView } from "../../../../src/workflows/vm/view-flatten.js"
import { queueFactsForState } from "../../../../src/workflows/view/view-diff.js"
import { buildWorkflowControlInitializedFact } from "../../../../src/workflows/vm/session-facts.js"
import { createConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { chatTurnEndOf, interruptedTurnEnd, interruptedTurnMessage, turnEndEntryId, type TurnEnd, type TurnEndEntry } from "../../../../src/orchestration/session/conversation/turn-end-record.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { countStateRequests } from "../../../helpers/state-requests.js"
import { holdReplyWait } from "../../../../src/orchestration/session/conversation/reply-wait-cells.js"

const interrupted = { end: { reason: "paused", pausedBy: "person" }, recorded: true } as const

function message(kind: "user", options: { readonly id: string; readonly origin?: "human" | "system"; readonly content?: string }): TurnEndEntry {
  return { kind: "message", id: options.id, message: { kind, origin: options.origin ?? "system", content: options.content ?? options.id } }
}

describe("chat session admission from turn-end evidence", () => {
  test("an active chat admits Interrupt whatever the evidence says, because running is live status the row does not carry", () => {
    expect(chatSessionActions("chat", "active")).toEqual(["chat.interrupt", "session.delete"])
    expect(chatSessionActions("chat", "active", { end: { reason: "discarded" }, recorded: true })).toEqual(["chat.interrupt", "session.delete"])
  })

  test("a recorded interrupt or crash end admits Resume, with its tab open or not", () => {
    expect(chatSessionActions("chat", "active", interrupted)).toEqual(["chat.interrupt", "chat.resume", "session.delete"])
    expect(chatSessionActions("chat", "inactive", { end: { reason: "paused", pausedBy: "runtime" }, recorded: true })).toEqual(["chat.resume", "session.delete"])
    expect(chatSessionActions("chat", "inactive", { end: { reason: "crash" }, recorded: true })).toEqual(["chat.resume", "session.delete"])
  })

  test("a chat's wait that an unexpected exit or an ordinary stop cut admits Resume while open, because its attach parks the turn only; a planned cut and a workflow agent keep their admission", () => {
    const cutWhileWaiting = (end: TurnEnd) => ({ end, recorded: true, backgroundWait: true }) as const
    expect(chatSessionActions("chat", "active", cutWhileWaiting({ reason: "crash" }))).toEqual(["chat.interrupt", "chat.resume", "session.delete"])
    expect(chatSessionActions("chat", "active", cutWhileWaiting(interruptedTurnEnd("runtime")))).toEqual(["chat.interrupt", "chat.resume", "session.delete"])
    // The successor that a planned cut authorizes continues the wait itself.
    expect(chatSessionActions("chat", "active", cutWhileWaiting(interruptedTurnEnd("replacement")))).toEqual(["chat.interrupt", "session.delete"])
    // A workflow agent restores its wait only under a Resume or a continuation.
    expect(chatSessionActions("workflow-agent", "active", cutWhileWaiting({ reason: "crash" }))).toEqual(["chat.interrupt", "session.delete"])
    expect(chatSessionActions("workflow-agent", "inactive", cutWhileWaiting({ reason: "crash" }))).toEqual(["chat.resume", "session.delete"])
  })

  test("a notification that lands after an unexpected exit keeps Resume on the open chat, as it does after an interrupt", () => {
    const crash = message("user", { id: turnEndEntryId({ reason: "crash" }, "key"), content: "The runtime exited unexpectedly." })
    const notification = message("user", { id: "notification", content: "Workflow completed." })
    expect(chatSessionActions("chat", "active", chatTurnEndOf([message("user", { id: "ask", origin: "human" }), crash, notification]))).toContain("chat.resume")
  })

  test("the unrecorded crash shape admits Resume only once the session is inactive: while active it is a turn in progress", () => {
    expect(chatSessionActions("chat", "inactive", { end: { reason: "crash" }, recorded: false })).toEqual(["chat.resume", "session.delete"])
    expect(chatSessionActions("chat", "active", { end: { reason: "crash" }, recorded: false })).toEqual(["chat.interrupt", "session.delete"])
  })

  test("a discarded turn, or a listing without evidence, admits no Resume", () => {
    expect(chatSessionActions("chat", "inactive", { end: { reason: "discarded" }, recorded: true })).toEqual(["session.delete"])
    expect(chatSessionActions("chat", "inactive")).toEqual(["session.delete"])
  })
})

describe("workflow session admission", () => {
  test("a running workflow admits Interrupt, Resume while its step's turn end records an interrupt, and Stop only for a parent's tool call", () => {
    expect(workflowSessionActions("active", "running")).toEqual(["workflow.interrupt", "session.delete"])
    expect(workflowSessionActions("active", "running", { stepTurnEnd: interrupted })).toEqual(["workflow.interrupt", "workflow.resume", "session.delete"])
    expect(workflowSessionActions("active", "running", { toolCall: { read: true } })).toEqual(["workflow.interrupt", "background.terminate", "session.delete"])
    // A step whose continuation already committed is a turn in progress.
    expect(workflowSessionActions("active", "running", { stepTurnEnd: { end: { reason: "crash" }, recorded: false } })).toEqual(["workflow.interrupt", "session.delete"])
  })

  test("a completed workflow admits no step control", () => {
    expect(workflowSessionActions("active", "completed", { stepTurnEnd: interrupted, toolCall: { read: true } })).toEqual(["session.delete"])
    expect(workflowSessionActions("active", "completed")).toEqual(["session.delete"])
  })

  test("an inactive workflow admits Resume while its control is not terminal, and Stop while its parent's call waits", () => {
    expect(workflowSessionActions("inactive", "paused", { toolCall: { read: true } })).toEqual(["workflow.resume", "background.terminate", "session.delete"])
    // An unexpected exit leaves the workflow inactive with its control running.
    expect(workflowSessionActions("inactive", "running", { message: true, toolCall: { read: true } })).toEqual(["session.send", "workflow.resume", "background.terminate", "session.delete"])
    expect(workflowSessionActions("inactive", "paused", { toolCall: { read: true, settled: true } })).toEqual(["workflow.resume", "session.delete"])
    expect(workflowSessionActions("inactive", "paused")).toEqual(["workflow.resume", "session.delete"])
    expect(workflowSessionActions("inactive", "failed", { toolCall: { read: true } })).toEqual(["session.delete"])
    expect(workflowSessionActions("inactive", "completed", { toolCall: { read: true } })).toEqual(["session.delete"])
  })

  test("a run that a failed step ended admits Resume, which runs its failed steps again, and takes no message", () => {
    expect(workflowSessionActions("inactive", "failed", { message: false, retriesFailedAgents: true, toolCall: { read: true, settled: true } })).toEqual(["workflow.resume", "session.delete"])
    // A refusal or an older build ended it, or its row is listed without its detail.
    expect(workflowSessionActions("inactive", "failed", { message: false, toolCall: { read: true, settled: true } })).toEqual(["session.delete"])
    expect(workflowSessionActions("inactive", "failed", { retriesFailedAgents: true, toolCall: { read: false } })).toEqual(["session.delete"])
    expect(workflowSessionActions("inactive", "failed", { message: false, retriesFailedAgents: true, executable: false })).toEqual(["session.delete"])
  })

  test("a workflow whose saved progress cannot execute admits Restart only while its recorded request can run again", () => {
    expect(workflowSessionActions("inactive", "paused", { message: true, executable: false, restartable: true, toolCall: { read: true } })).toEqual(["session.send", "workflow.restart", "background.terminate", "session.delete"])
    expect(workflowSessionActions("inactive", "paused", { message: true, executable: false, toolCall: { read: true } })).toEqual(["session.send", "background.terminate", "session.delete"])
    // Control that executes needs no Restart, whatever the assessment says.
    expect(workflowSessionActions("inactive", "paused", { message: true, restartable: true, toolCall: { read: true } })).toEqual(["session.send", "workflow.resume", "background.terminate", "session.delete"])
  })

  test("a workflow a Stop ended admits nothing but deletion, running or not", () => {
    expect(workflowSessionActions("active", "running", { stepTurnEnd: interrupted, toolCall: { read: true, stoppedBy: "person" } })).toEqual(["session.delete"])
    expect(workflowSessionActions("inactive", "paused", { toolCall: { read: true, stoppedBy: "agent" } })).toEqual(["session.delete"])
  })

  test("a listed workflow cannot tell whether a Stop ended it, so it admits no Resume until its detail is read", () => {
    expect(workflowSessionActions("inactive", "paused", { toolCall: { read: false } })).toEqual(["session.delete"])
    expect(workflowSessionActions("inactive", "paused", { toolCall: { read: true } })).toEqual(["workflow.resume", "background.terminate", "session.delete"])
    expect(workflowSessionActions("inactive", "paused")).toEqual(["workflow.resume", "session.delete"])
  })

  test("the tool-call evidence reads absent, unread, waiting, stopped, and settled", () => {
    expect(workflowToolCall(undefined, { stoppedBy: "person" })).toBeUndefined()
    expect(workflowToolCall("call", undefined)).toEqual({ read: false })
    expect(workflowToolCall("call", {})).toEqual({ read: true })
    expect(workflowToolCall("call", { stoppedBy: "agent" })).toEqual({ read: true, stoppedBy: "agent" })
    expect(workflowToolCall("call", { settled: true })).toEqual({ read: true, settled: true })
  })

  test("a running workflow whose call holds another result admits no Stop, because a Stop can only be the call's first result", () => {
    expect(workflowSessionActions("active", "running", { toolCall: { read: true, settled: true } })).toEqual(["workflow.interrupt", "session.delete"])
  })
})

describe("chat turn-end read", () => {
  const tmp = temporaryDirectories()

  test("detail tail reads stay bounded as repeated runtime cuts accumulate", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmp("runtime-cut-read-count-")))
    const reader = asAsyncEventReadSurface(store)
    const tree = await createConversationTree({ conversationId: "wait", sessionId: "chat", store: reader, writer: asAsyncEventWriter(store) })
    try {
      await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "wait", name: "process", input: { action: "wait", soft_timeout: 60 } }] })
      await tree.appendMessage({ kind: "toolResult", toolUseId: "wait", content: [{ type: "text", text: "Wait acknowledged." }] })
      const counter = countStateRequests(reader)
      const costs: number[] = []
      for (let cut = 0; cut < 20; cut += 1) {
        const end = interruptedTurnEnd("replacement")
        await tree.appendMessage({ kind: "user", origin: "system", content: interruptedTurnMessage(end.pausedBy, false) }, turnEndEntryId(end, String(cut)))
        expect((await readChatTurnEnd(counter.reader, "wait"))?.end).toEqual(end)
        costs.push(counter.take().length)
      }
      // A process wait is a wait by its own input, so no read asks which
      // reply waits are open.
      expect(costs[0]).toBeLessThanOrEqual(3)
      expect(new Set(costs.slice(1))).toEqual(new Set([2]))
    } finally {
      tree.getStorage().dispose()
      store.close()
    }
  })

  test("a turn end reads the waiter's reply waits only when its tail asks which calls hold one", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmp("reply-wait-evidence-")))
    const reader = asAsyncEventReadSurface(store)
    const writer = asAsyncEventWriter(store)
    const tree = await createConversationTree({ conversationId: "asks", sessionId: "chat", store: reader, writer })
    try {
      const counter = countStateRequests(reader)
      const inFlightReads = () => counter.take().filter(({ method }) => method === "readInFlight").length
      await tree.appendMessage({ kind: "user", origin: "human", content: "Ask the peer." })
      await tree.appendMessage({ kind: "user", origin: "system", content: interruptedTurnMessage("person", false) }, turnEndEntryId({ reason: "paused", pausedBy: "person" }, "person"))
      expect(await readChatTurnEnd(counter.reader, "asks")).toEqual(interrupted)
      expect(inFlightReads()).toBe(0)

      // Only the open cell of its call tells a message_session call that waits from one that does not.
      await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "ask", name: "message_session", input: { to: "peer", wait: true } }] })
      await tree.appendMessage({ kind: "toolResult", toolUseId: "ask", content: [{ type: "text", text: "Waiting." }] })
      const end = interruptedTurnEnd("replacement")
      await tree.appendMessage({ kind: "user", origin: "system", content: interruptedTurnMessage(end.pausedBy, false) }, turnEndEntryId(end, "cut"))
      expect(await readChatTurnEnd(counter.reader, "asks")).toEqual({ end, recorded: true })
      expect(inFlightReads()).toBe(1)
      await holdReplyWait(writer, "chat", { addresseeSessionId: "peer", toolUseId: "ask", openedAtMs: 1 })
      expect(await readChatTurnEnd(counter.reader, "asks")).toEqual({ end, recorded: true, backgroundWait: true })
      expect(inFlightReads()).toBe(1)
    } finally {
      tree.getStorage().dispose()
      store.close()
    }
  })

  test("reads each pending concurrent attempt's actor and original timestamp after abort, excluding finished attempts", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmp("workflow-attempt-ends-")))
    try {
      const queue = flattenWorkflowView(interrupt(startNext(startNext(phaseControl(true)))), phaseBindings(true))
      // A launch writes its root before any queue fact, and the queue reads from the newest root.
      store.appendBatch([buildWorkflowControlInitializedFact(phaseControl(true)), ...queueFactsForState(null, queue)].map((fact) => ({ ...fact, aggregateId: "workflow:workflow", sessionId: "workflow", timestamp: 1 })))
      const reader = asAsyncEventReadSurface(store)
      const expected = []
      for (const [index, by] of (["agent", "person"] as const).entries()) {
        const step = queue.attempts[index]!
        const tree = await createConversationTree({ conversationId: step.lastConversationId!, sessionId: "workflow", store: reader, writer: asAsyncEventWriter(store) })
        await tree.appendMessage({ kind: "user", content: "Work", origin: "human" })
        const id = turnEndEntryId(interruptedTurnEnd(by), "cut")
        await tree.appendMessage({ kind: "user", content: "Interrupted", origin: "system" }, id)
        const entry = (await tree.getBranch()).find((candidate) => candidate.id === id)!
        await tree.appendMessage({ kind: "user", content: "Later notice", origin: "system" })
        tree.getStorage().dispose()
        expected.push({ attemptId: step.id, conversationId: step.lastConversationId, turnEnd: { recorded: true, end: { reason: "paused", pausedBy: by } }, timestamp: Date.parse(entry.timestamp) })
      }
      const evidence = await readWorkflowAgentTurnEnds(reader, "workflow")
      expect(evidence).toHaveLength(2)
      expect(evidence).toMatchObject(expected)
      expect(evidence.map(({ agent }) => agent.id)).toEqual(queue.attempts.slice(0, 2).map((row) => queue.tree.nodes.find((node) => node.kind === "agent" && node.currentAttemptId === row.id)!.id))
      expect(resumableAgentTurnEnd(evidence)?.end).toEqual({ reason: "paused", pausedBy: "agent" })
      const [first, ...rest] = queue.attempts
      const finished = {
        ...queue,
        attempts: [{ ...first!, status: "completed" as const }, ...rest],
        tree: { ...queue.tree, nodes: queue.tree.nodes.map((node) => node.kind === "agent" && node.currentAttemptId === first!.id ? { ...node, disposition: "completed" as const } : node) },
      }
      store.appendBatch(queueFactsForState(queue, finished).map((fact) => ({ ...fact, aggregateId: "workflow:workflow", sessionId: "workflow", timestamp: 2 })))
      expect(await readWorkflowAgentTurnEnds(reader, "workflow")).toMatchObject([expected[1]])
    } finally {
      store.close()
    }
  })

  test("the pending turn ends of many conversations read together answer as each conversation's own read does", async () => {
    const path = resolveEventStoreDbFile(tmp("flywheel-pending-turn-ends-"))
    const store = createSqliteEventStore(path)
    try {
      const reader = asAsyncEventReadSurface(store)
      const writer = asAsyncEventWriter(store)
      // What follows the agent's interrupt in each conversation, one batch each.
      const tailsAfterInterrupt = {
        "recorded": [], "queued-1": ["queued"], "queued-3": ["queued", "queued", "queued"], "answered": ["answer"],
        "corrupt-newest": ["queued"], "corrupt-record": ["queued", "queued", "queued"],
      } satisfies { readonly [id: string]: readonly ("queued" | "answer")[] }
      // Each conversation commits its history after the others, so the
      // newest rows of the store belong to the last conversations only.
      for (const [id, after] of Object.entries(tailsAfterInterrupt)) {
        const tree = await createConversationTree({ conversationId: id, sessionId: `session-${id}`, store: reader, writer })
        for (let i = 0; i < 30; i += 1) await tree.appendMessage({ kind: "user", content: `message ${i}`, origin: "human" })
        const end = interruptedTurnEnd("agent")
        await tree.appendMessage({ kind: "user", content: interruptedTurnMessage(end.pausedBy, false), origin: "system" }, turnEndEntryId(end, id))
        for (const entry of after) {
          await tree.appendMessage(entry === "queued" ? { kind: "user", content: "Also check the tests.", origin: "human" } : { kind: "assistant", content: [{ type: "text", text: "Done." }] })
        }
        tree.getStorage().dispose()
      }
      const short = await createConversationTree({ conversationId: "short", sessionId: "session-short", store: reader, writer })
      await short.appendMessage({ kind: "user", content: "Do the work.", origin: "human" })
      short.getStorage().dispose()
      const batches = (id: string) => store.read({ aggregateId: `conversation:${id}`, types: ["chat.entries.appended"], order: "desc" })
      const db = new Database(path)
      try {
        db.query("update event set payload = '{bad json' where position = ?").run(batches("corrupt-newest")[0]!.position)
        db.query("update event set payload = '{bad json' where position = ?").run(batches("corrupt-record")[3]!.position)
      } finally {
        db.close()
      }
      const ids = [...Object.keys(tailsAfterInterrupt), "short", "missing"]
      const alone = new Map(await Promise.all(ids.map(async (id) => [id, await readPendingTurnEnd(reader, id)] as const)))
      expect(alone).toEqual(new Map([
        ["recorded", { reason: "paused", pausedBy: "agent" }], ["queued-1", { reason: "paused", pausedBy: "agent" }],
        ["queued-3", { reason: "paused", pausedBy: "agent" }], ["answered", undefined], ["corrupt-newest", undefined],
        ["corrupt-record", undefined], ["short", undefined], ["missing", undefined],
      ]))
      expect(await readPendingTurnEnds(reader, ids)).toEqual(alone)
    } finally {
      store.close()
    }
  })

  /** A store whose conversation's last turn ended by a person's interrupt,
   *  with `notices` system notices committed after it, one batch each. */
  async function withInterruptedConversation(use: (reader: AsyncEventStateReadSurface, conversationId: string) => Promise<void>, notices = 0): Promise<void> {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmp("flywheel-turn-end-read-")))
    try {
      const conversationId = "conversation-turn-end"
      const reader = asAsyncEventReadSurface(store)
      const tree = await createConversationTree({ conversationId, sessionId: "chat-turn-end", store: reader, writer: asAsyncEventWriter(store) })
      await tree.appendMessage({ kind: "user", content: "Do the work.", origin: "human" })
      const end = interruptedTurnEnd("person")
      await tree.appendMessage({ kind: "user", content: interruptedTurnMessage(end.pausedBy, false), origin: "system" }, turnEndEntryId(end, "key"))
      for (let notice = 0; notice < notices; notice += 1) await tree.appendMessage({ kind: "user", content: `Notice ${notice}.`, origin: "system" })
      tree.getStorage().dispose()
      await use(reader, conversationId)
    } finally {
      store.close()
    }
  }

  test("a state read the state Worker refuses rejects, so no caller decides from a turn end it never read", async () => {
    await withInterruptedConversation(async (base, conversationId) => {
      const reader: AsyncEventStateReadSurface = { ...base, readSlice: async () => { throw new StateRequestNotServedError("refused") } }
      expect(await readChatTurnEnd(base, conversationId)).toEqual({ end: { reason: "paused", pausedBy: "person" }, recorded: true })
      await expect(readChatTurnEnd(reader, conversationId)).rejects.toBeInstanceOf(StateRequestNotServedError)
    })
  })

  test("the tail pages back one batch at a time, so batches that pass the response budget together still answer", async () => {
    // Each batch fits the state Worker's response budget alone, and no two
    // fit it together, as when the person's message holds large images.
    // Notices behind the turn end make the read go past the newest batch.
    for (const notices of [0, 2]) {
      await withInterruptedConversation(async (base, conversationId) => {
        const reader: AsyncEventStateReadSurface = {
          ...base,
          readSlice: async (query, tolerant) => {
            const slice = await base.readSlice(query, tolerant)
            if (slice.facts.length > 1) throw new StateRequestNotServedError("oversize")
            return slice
          },
        }
        expect(await readChatTurnEnd(reader, conversationId)).toEqual({ end: { reason: "paused", pausedBy: "person" }, recorded: true })
      }, notices)
    }
  })

  test("the tail pages back past every message other sessions sent after the interrupt, as the whole-branch read does", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmp("flywheel-turn-end-read-")))
    try {
      const conversationId = "conversation-held-message"
      const reader = asAsyncEventReadSurface(store)
      const tree = await createConversationTree({ conversationId, sessionId: "chat-held-message", store: reader, writer: asAsyncEventWriter(store) })
      await tree.appendMessage({ kind: "user", content: "Do the work.", origin: "human" })
      const end = interruptedTurnEnd("person")
      await tree.appendMessage({ kind: "user", content: interruptedTurnMessage(end.pausedBy, false), origin: "system" }, turnEndEntryId(end, "key"))
      // Each held message commits its own batch, as when the three children
      // of an interrupted chat each ask it a question.
      for (const child of ["child-1", "child-2", "child-3"]) {
        await tree.appendMessage({ kind: "user", content: "PING", producer: { kind: "session", sessionId: child, conversationId: `${child}-conversation`, toolUseId: "call-1", hop: 0, envelope: { name: child, relation: "child", waits: true } } }, `msg:${child}:call-1`)
      }
      const branch = await tree.getBranch()
      tree.getStorage().dispose()
      expect(chatTurnEndOf(branch)).toEqual(interrupted)
      expect(await readChatTurnEnd(reader, conversationId)).toEqual(interrupted)
    } finally {
      store.close()
    }
  })

  test("the pending record names the parent's interrupt past a person's message queued behind it, which the turn-end read sees as unanswered", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmp("flywheel-turn-end-read-")))
    try {
      const conversationId = "conversation-queued-behind-agent"
      const reader = asAsyncEventReadSurface(store)
      const tree = await createConversationTree({ conversationId, sessionId: "child-queued", store: reader, writer: asAsyncEventWriter(store) })
      await tree.appendMessage({ kind: "user", content: "Do the work.", origin: "human" })
      const end = interruptedTurnEnd("agent")
      await tree.appendMessage({ kind: "user", content: interruptedTurnMessage(end.pausedBy, false), origin: "system" }, turnEndEntryId(end, "key"))
      expect(await readPendingTurnEnd(reader, conversationId)).toEqual({ reason: "paused", pausedBy: "agent" })
      // Each queued message commits its own batch, so the read pages back
      // past both to the record.
      await tree.appendMessage({ kind: "user", content: "Also check the tests.", origin: "human" })
      await tree.appendMessage({ kind: "user", content: "Notice.", origin: "system" })
      expect(await readChatTurnEnd(reader, conversationId)).toEqual({ end: { reason: "crash" }, recorded: false })
      expect(await readPendingTurnEnd(reader, conversationId)).toEqual({ reason: "paused", pausedBy: "agent" })
      // An answer after the record ran a model step, so no cut is pending.
      await tree.appendMessage({ kind: "assistant", content: [{ type: "text", text: "Done." }] })
      tree.getStorage().dispose()
      expect(await readPendingTurnEnd(reader, conversationId)).toBeUndefined()
    } finally {
      store.close()
    }
  })

  test("the tail pages back past a settled record to the tool result that still waits for the model's answer", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmp("flywheel-turn-end-read-")))
    try {
      const conversationId = "conversation-settled-mid-turn"
      const reader = asAsyncEventReadSurface(store)
      const tree = await createConversationTree({ conversationId, sessionId: "chat-settled-mid-turn", store: reader, writer: asAsyncEventWriter(store) })
      await tree.appendMessage({ kind: "user", content: "Do the work.", origin: "human" })
      await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "call-1", name: "search", input: {} }] })
      await tree.appendMessage({ kind: "toolResult", toolUseId: "call-1", content: [{ type: "text", text: "found" }] })
      await tree.appendMessage({ kind: "user", content: "The qa workflow could not start: required skills are missing", origin: "system" }, turnEndEntryId({ reason: "settled" }, "operation-1"))
      tree.getStorage().dispose()
      expect(await readChatTurnEnd(reader, conversationId)).toEqual({ end: { reason: "crash" }, recorded: false })
    } finally {
      store.close()
    }
  })

  test("a corrupt batch in the tail makes the turn end unreadable, so an older batch never answers for it", async () => {
    await withInterruptedConversation(async (base, conversationId) => {
      const corrupt = new CorruptEventRowError({ aggregateId: `conversation:${conversationId}`, seq: 99, type: "chat.entries.appended", version: 3, timestamp: 0, actor: "flywheel", sessionId: "chat-turn-end", eventId: "corrupt", position: 99, rawPayload: "{" }, "unparseable payload")
      const reader: AsyncEventStateReadSurface = {
        ...base,
        readSlice: async (query, tolerant) => {
          // A strict read meets the corrupt row as the store does: it throws.
          if (!tolerant) throw corrupt
          const slice = await base.readSlice(query, tolerant)
          return { ...slice, facts: [corrupt, ...slice.facts] }
        },
      }
      expect(await readChatTurnEnd(reader, conversationId)).toBeUndefined()
    })
  })
})

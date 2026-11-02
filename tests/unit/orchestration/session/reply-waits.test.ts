import { afterEach, describe, expect, test } from "bun:test"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work"
import { readUnreadMessages } from "../../../../src/orchestration/session/conversation/queued-user-inputs"
import { notifyLiveWorkChanged, registerLiveSessionControl, registerLiveWorkflowControl, type LiveRecipientState } from "../../../../src/orchestration/session/live-session-control"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"
import { settleUnreadMessages, wakeAfterSettlement } from "../../../../src/orchestration/session/session-input-delivery"
import { buildSubagentCompleted, buildSubagentPaused } from "../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { interruptedTurnEnd, interruptedTurnMessage, turnEndEntryId } from "../../../../src/orchestration/session/conversation/turn-end-record"
import { readReplyWaitViews } from "../../../../src/orchestration/session/reply-waits"
import { registerTestChildRun } from "../../../helpers/live-child-run"
import { publishTestSubagent } from "./_session-manager-fixtures"
import { unregisters, settle, project, deleteSession, live, runChild, message, read, conversationOf, cleanupReplyWaitTest, childWorkflow } from "./_reply-wait-fixtures"
import { ChatTurnMailbox } from "../../../../src/orchestration/chat/turn-mailbox"
import { runAgentLoop } from "../../../../src/orchestration/agent-runtime/agent-loop"
import { createBackgroundExecutionOwner } from "../../../../src/orchestration/agent-runtime/background-execution-owner"
import { createMessageSessionTool } from "../../../../src/orchestration/agent-runtime/tools/message-session"
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers"
import { RequestToolMap } from "../../../helpers/request-tool-surface"
import { makeCaptureClient } from "../agent-runtime/context/_loop-fixtures"
import { readHeldAddressedMessages } from "../../../../src/orchestration/session/conversation/addressed-workflow-messages"

afterEach(cleanupReplyWaitTest)

describe("the end rules", () => {
  test("rule 1: a message from the addressee ends the wait with no notice and retires its cell", async () => {
    const here = project()
    const waiter = await here.manager.createChat({ name: "Waiter" })
    const addressee = await childWorkflow(here, waiter, "Addressee")
    const w = live(here, waiter)
    live(here, addressee)

    const mailbox = new ChatTurnMailbox()
    const parked = Promise.withResolvers<void>()
    let scheduled = 0
    const { client, capturedMessages } = makeCaptureClient([
      { events: [{ kind: "tool_use", toolCall: { id: "ask-1", name: "message_session", input: { target: "session", to: addressee, text: "Which file?", wait: true } } }, { kind: "done", stopReason: "tool_use" }] },
      { events: [{ kind: "text_delta", text: "I have the file.", blockKey: "answer" }, { kind: "done", stopReason: "end_turn" }] },
    ])
    const run = runAgentLoop({
      client, tools: new RequestToolMap([["message_session", createMessageSessionTool(here.messaging, w.tasks)]]),
      systemPrompt: stableSystemPrompt("test"), instruction: "ask the child", executionCwd: here.root, userDataRoot: `${here.root}/.test-account`, projectRoot: here.root,
      providerSessionKey: waiter, promptCacheKey: waiter, artifactScopeId: waiter, retrievalSessionId: waiter, sessionId: waiter, conversationId: `${waiter}-conversation`,
      seed: { kind: "fresh" }, persistence: { history: { append: () => {} } },
      inputSource: mailbox, background: createBackgroundExecutionOwner(w.tasks), completeOnIdle: {},
      lifecycle: { onTurnParked: () => { parked.resolve() } },
      scheduleWaitExpiry: () => { scheduled++; return () => {} }, onEvent: () => {},
    })
    await parked.promise
    expect(capturedMessages).toHaveLength(1)
    expect(w.tasks.holdsWait("ask-1")).toBe(true)
    expect(here.replyWaitCells(waiter)).toHaveLength(1)

    await message(here.messaging, { id: addressee }, "answer-1", { to: waiter, text: "main.ts" })
    mailbox.enqueueNextTurn(w.received[0]!)
    await expect(run).resolves.toEqual({ kind: "completed" })
    expect(capturedMessages).toHaveLength(2)
    expect(JSON.stringify(capturedMessages[1])).toContain("main.ts")
    expect(scheduled).toBe(0)
    expect(w.tasks.holdsWait("ask-1")).toBe(false)
    expect(w.tasks.activeTaskCount()).toBe(0)
    expect(w.notices).toEqual([])
    // The reply is durable in the waiter's cell, so the wait it ended needs no cell.
    expect(here.replyWaitCells(waiter)).toEqual([])
    expect((await readUnreadMessages(here.reader, waiter)).map((cell) => cell.text)).toEqual(["main.ts"])
  })

  test("rule 2: a yield after the addressee read the message ends the wait with its last words, and the notice's commit retires the cell", async () => {
    const here = project()
    const waiter = await here.manager.createChat({ name: "Waiter" })
    const addressee = await childWorkflow(here, waiter, "Addressee")
    const w = live(here, waiter)
    live(here, addressee)
    const run = await here.messaging.observeRun({ sessionId: addressee })

    await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-1", { to: addressee, text: "Which file?", wait: true })
    // A yield before the addressee read the message is no answer to it.
    await run.yielded({ lastText: "Earlier work is done.", waitRequested: false })
    await settle()
    expect(w.tasks.holdsWait("ask-1")).toBe(true)

    await read(here, addressee, waiter, "ask-1")
    await run.yielded({ lastText: "I asked the person; I will reply when they answer.", waitRequested: false })
    await settle()
    expect(w.tasks.holdsWait("ask-1")).toBe(false)
    expect(w.notices).toHaveLength(1)
    expect(w.notices[0]?.text).toContain('<status>no_reply</status>')
    // An end without a reply is a runtime notice, which a hosted waiter may read in its open tool call.
    expect(w.notices[0]?.runtimeNotice).toBe(true)
    expect(w.notices[0]?.text).toContain("I asked the person; I will reply when they answer.")
    // A parent never waits on its own child again, even on a promise.
    expect(w.notices[0]?.text).toContain("Do not wait on it again.")
    expect(w.notices[0]?.text).not.toContain("wait true")

    const conversation = await conversationOf(here, waiter)
    try {
      await conversation.commitBackgroundNotification({ key: w.notices[0]!.key!, text: w.notices[0]!.text })
    } finally {
      await conversation.dispose()
    }
    expect(here.replyWaitCells(waiter)).toEqual([])
  })

  test("rule 2: a wait on an agent ends at its first yield after it reads the private message", async () => {
    const here = project()
    const waiter = await here.manager.createChat({ name: "Waiter" })
    const addressee = await childWorkflow(here, waiter, "Addressee")
    const w = live(here, waiter)
    live(here, addressee)
    const run = await here.messaging.observeRun({ sessionId: addressee })

    await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-1", { to: addressee, text: "Which file?", wait: true })
    await run.yielded({ lastText: "Earlier work is done.", waitRequested: false })
    await settle()
    expect(w.tasks.holdsWait("ask-1")).toBe(true)

    await read(here, addressee, waiter, "ask-1")
    expect(await readHeldAddressedMessages(here.reader, addressee)).toHaveLength(0)
    await run.yielded({ lastText: "main.ts", waitRequested: false })
    await settle()
    expect(w.tasks.holdsWait("ask-1")).toBe(false)
    expect(w.notices[0]?.text).toContain("main.ts")
  })

  test("the end of an older wait never retires a newer wait on the same addressee", async () => {
    const here = project()
    const waiter = await here.manager.createChat({ name: "Waiter" })
    const addressee = await childWorkflow(here, waiter, "Addressee")
    const w = live(here, waiter)
    live(here, addressee)
    const run = await here.messaging.observeRun({ sessionId: addressee })
    const conversation = await conversationOf(here, waiter)
    try {
      // The rule 2 notice of the first wait is queued, and the waiter asks
      // again in the same turn before that notice commits.
      await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-1", { to: addressee, text: "Which file?", wait: true })
      await read(here, addressee, waiter, "ask-1")
      await run.yielded({ lastText: "Still looking.", waitRequested: false })
      await settle()
      await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-2", { to: addressee, text: "Any news?", wait: true })
      await conversation.commitBackgroundNotification({ key: w.notices[0]!.key!, text: w.notices[0]!.text })
      expect(w.tasks.holdsWait("ask-2")).toBe(true)
      expect(here.replyWaitCells(waiter)).toHaveLength(1)

      // A reply to the second wait is queued, and the waiter asks a third time
      // before that reply commits.
      await read(here, addressee, waiter, "ask-2")
      await message(here.messaging, { id: addressee }, "answer-2", { to: waiter, text: "main.ts" })
      await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-3", { to: addressee, text: "And the test?", wait: true })
      const [reply] = await readUnreadMessages(here.reader, waiter)
      expect(await conversation.commitQueuedUserInput(reply!)).toBe("committed")
      expect(w.tasks.holdsWait("ask-3")).toBe(true)
      expect(here.replyWaitCells(waiter)).toHaveLength(1)
    } finally {
      await conversation.dispose()
    }

    // The cell that remains restores the third wait in the next run.
    await w.tasks.terminateAll()
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} })
    await here.messaging.observeRun({ sessionId: waiter, tasks })
    expect(tasks.holdsWait("ask-3")).toBe(true)
  })

  for (const by of ["person", "agent", "runtime"] as const) test(`rule 3: a workflow child's ${by} interrupt ${by === "person" ? "pauses" : "ends"} its parent's reply wait`, async () => {
    const here = project()
    const waiter = await here.manager.createChat({ name: "Waiter" })
    const addressee = await childWorkflow(here, waiter, "Addressee")
    const w = live(here, waiter)
    const a = live(here, addressee)
    const run = await here.messaging.observeRun({ sessionId: addressee })
    await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-1", { to: addressee, text: "Which file?", wait: true })
    expect(w.tasks.holdsWait("ask-1")).toBe(true)

    const member = await here.messaging.identity(addressee)
    if (!member?.conversationId) throw new Error("Expected a member conversation")
    const tree = await tryOpenConversationTree({ conversationId: member.conversationId, sessionId: addressee, store: here.reader, writer: here.writer })
    if (!tree) throw new Error("Expected the published member conversation")
    const end = interruptedTurnEnd(by)
    await tree.appendMessage({ kind: "user", content: interruptedTurnMessage(end.pausedBy, false), origin: "system" }, turnEndEntryId(end, by))
    tree.getStorage().dispose()
    a.state = "interrupted"
    await run.changed()
    await settle()
    if (by === "person") {
      expect(w.tasks.holdsWait("ask-1")).toBe(true)
      expect(here.replyWaitCells(waiter)).toHaveLength(1)
      await run.yielded({ lastText: "Interrupted.", waitRequested: false })
      expect(w.tasks.holdsWait("ask-1")).toBe(true)
      const bare = await message(here.messaging, { id: waiter, tasks: w.tasks }, "wait-1", { to: addressee, wait: true })
      expect(bare.content).toContain("Waiting on")
      a.state = "running"
      await message(here.messaging, { id: addressee }, "answer-1", { to: waiter, text: "main.ts" })
      expect(w.tasks.holdsWait("wait-1")).toBe(false)
      expect(here.replyWaitCells(waiter)).toEqual([])
      expect(w.notices).toEqual([])
      return
    }
    expect(w.tasks.holdsWait("ask-1")).toBe(false)
    expect(here.replyWaitCells(waiter)).toEqual([])

    // A message to the interrupted child waits for its Resume, and no wait
    // parks on it.
    const held = await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-2", { to: addressee, text: "And the test?", wait: true })
    expect(held.content).toStartWith(`Held for ${addressee}`)
    expect(held.content).not.toContain("Waiting on")
    const bare = await message(here.messaging, { id: waiter, tasks: w.tasks }, "wait-1", { to: addressee, wait: true })
    expect(bare.content).not.toContain("Waiting on")
    expect(w.tasks.activeTaskCount()).toBe(0)
    expect(here.replyWaitCells(waiter)).toEqual([])
    expect(w.notices).toEqual([])
  })

  for (const by of ["person", "agent", "runtime"] as const) test(`a restored wait on a subagent that ${by} interrupted ${by === "person" ? "stays open" : "ends with no notice"}`, async () => {
    const here = project()
    const waiter = await here.manager.createChat({ name: "Waiter" })
    const child = await publishTestSubagent(here.manager, here.root, "child", waiter)
    const w = live(here, waiter)
    const unregisterChild = registerLiveSessionControl(here.reader, {
      sessionId: child,
      state: async () => "running",
      child: { runId: `${child}-run`, parentSessionId: waiter, parentConversationId: `${waiter}-conversation`, parentToolCallId: `${child}-tool`, modules: async () => undefined, backgroundTasks: createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} }), stop: () => {}, interrupt: async () => {}, progress: () => ({ toolUses: 0, totalTokens: 0, startedAtMs: 0 }) },
      deliver: async (_input, decide) => decide("running"),
      notify: async () => false,
    })
    await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-1", { to: child, text: "Which file?", wait: true })
    expect(w.tasks.holdsWait("ask-1")).toBe(true)
    // The waiter's runtime closes with the wait open, so its cell stays.
    await w.tasks.terminateAll()
    expect(here.replyWaitCells(waiter)).toHaveLength(1)

    // The turn end names the actor, while `subagent.paused` v1 saves the
    // parent agent as a person.
    unregisterChild()
    const tree = await tryOpenConversationTree({ conversationId: `${child}-conversation`, sessionId: child, store: here.reader, writer: here.writer })
    if (!tree) throw new Error("The child requires its conversation")
    const end = interruptedTurnEnd(by)
    await tree.appendMessage({ kind: "user", content: interruptedTurnMessage(end.pausedBy, false), origin: "system" }, turnEndEntryId(end, "key"))
    tree.getStorage().dispose()
    const writer = createSessionFactWriter({ sessionId: child, writer: here.writer })
    await writer.record(buildSubagentPaused({ childRunId: `${child}-run`, pausedBy: by === "agent" ? "person" : by }))
    writer.dispose()

    const notices: string[] = []
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => { notices.push(text) } })
    await here.messaging.observeRun({ sessionId: waiter, tasks })
    await settle()
    expect(tasks.holdsWait("ask-1")).toBe(by === "person")
    expect(notices).toEqual([])
    expect(here.replyWaitCells(waiter)).toHaveLength(by === "person" ? 1 : 0)
  })

  test("rule 3: a stop, a settle, a release, and a delete of the addressee each end the wait as unavailable", async () => {
    const here = project()
    const waiter = await here.manager.createChat({ name: "Waiter" })
    const w = live(here, waiter)

    // A person stops a running child while the wait holds.
    const stopped = await publishTestSubagent(here.manager, here.root, "stopped", waiter)
    const stoppedWriter = createSessionFactWriter({ sessionId: stopped, writer: here.writer })
    unregisters.push(registerLiveSessionControl(here.reader, {
      sessionId: stopped,
      state: async () => "running",
      child: { runId: `${stopped}-run`, parentSessionId: waiter, parentConversationId: `${waiter}-conversation`, parentToolCallId: `${stopped}-tool`, modules: async () => undefined, backgroundTasks: createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} }), stop: () => {}, interrupt: async () => {}, progress: () => ({ toolUses: 0, totalTokens: 0, startedAtMs: 0 }) },
      deliver: async (_input, decide) => decide("running"),
      notify: async () => false,
    }))
    await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-1", { to: stopped, text: "one", wait: true })
    expect(w.tasks.holdsWait("ask-1")).toBe(true)
    const outcome = await settleUnreadMessages({ reader: here.reader, writer: here.writer }, {
      recipientSessionId: stopped,
      reason: "settled",
      end: async () => {
        await stoppedWriter.record(buildSubagentCompleted({ childRunId: `${stopped}-run`, status: "stopped", isError: true, content: "stopped", durationMs: 0 }))
        return true
      },
      commitHeld: async () => {},
    })
    if (outcome.stored) await wakeAfterSettlement(here.reader, stopped, outcome.returned)
    stoppedWriter.dispose()
    await settle()
    expect(w.tasks.holdsWait("ask-1")).toBe(false)

    // A running child completes and leaves the registry.
    const settled = await publishTestSubagent(here.manager, here.root, "settled", waiter)
    unregisters.push(registerLiveSessionControl(here.reader, {
      sessionId: settled,
      state: async () => "running",
      child: { runId: `${settled}-run`, parentSessionId: waiter, parentConversationId: `${waiter}-conversation`, parentToolCallId: `${settled}-tool`, modules: async () => undefined, backgroundTasks: createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} }), stop: () => {}, interrupt: async () => {}, progress: () => ({ toolUses: 0, totalTokens: 0, startedAtMs: 0 }) },
      deliver: async (_input, decide) => decide("running"),
      notify: async () => false,
    }))
    await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-2", { to: settled, text: "two", wait: true })
    const settledWriter = createSessionFactWriter({ sessionId: settled, writer: here.writer })
    await settledWriter.record(buildSubagentCompleted({ childRunId: `${settled}-run`, status: "completed", isError: false, content: "done", durationMs: 0 }))
    settledWriter.dispose()
    unregisters.pop()!()
    await settle()
    expect(w.tasks.holdsWait("ask-2")).toBe(false)

    const released = await publishTestSubagent(here.manager, here.root, "released", waiter)
    unregisters.push(registerLiveSessionControl(here.reader, {
      sessionId: released,
      state: async () => "running",
      child: { runId: `${released}-run`, parentSessionId: waiter, parentConversationId: `${waiter}-conversation`, parentToolCallId: `${released}-tool`, modules: async () => undefined, backgroundTasks: createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} }), stop: () => {}, interrupt: async () => {}, progress: () => ({ toolUses: 0, totalTokens: 0, startedAtMs: 0 }) },
      deliver: async (_input, decide) => decide("running"),
      notify: async () => false,
    }))
    await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-3", { to: released, text: "three", wait: true })
    // A released run leaves the registry; nothing runs the child now.
    unregisters.pop()!()
    await settle()
    expect(w.tasks.holdsWait("ask-3")).toBe(false)

    const deleted = await childWorkflow(here, waiter, "Deleted")
    live(here, deleted)
    await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-4", { to: deleted, text: "four", wait: true })
    await deleteSession(here, deleted)
    await settle()
    expect(w.tasks.holdsWait("ask-4")).toBe(false)

    expect(w.notices.map((notice) => notice.text.match(/<status>(\w+)<\/status>/)?.[1])).toEqual(["unavailable", "unavailable", "unavailable", "unavailable"])
    // An addressee that can no longer answer is not a runtime notice, so its end dispatches a hosted waiter.
    expect(w.notices.some((notice) => notice.runtimeNotice)).toBe(false)
    expect(w.notices.map((notice) => notice.text.match(/ended: ([^.]*)\./)?.[1])).toEqual(["it has ended", "it has ended", expect.stringContaining("nothing runs it now"), "it was deleted"])
    // The stop and the delete return each unread message to its sender at once.
    expect(w.notified.map((notice) => notice.key)).toEqual([expect.stringMatching(new RegExp(`^returned:${stopped}:`)), expect.stringMatching(new RegExp(`^returned:${deleted}:`))])
  })

  test("a message from another session wakes the waiter and keeps the wait open", async () => {
    const here = project()
    const waiter = await here.manager.createChat({ name: "Waiter" })
    const addressee = await childWorkflow(here, waiter, "Addressee")
    const other = await here.manager.createChat({ name: "Other" })
    const w = live(here, waiter)
    live(here, addressee)
    live(here, other)

    await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-1", { to: addressee, text: "Which file?", wait: true })
    await message(here.messaging, { id: other }, "note-1", { to: waiter, text: "FYI: tests are green" })
    expect(w.received.map((input) => input.text)).toEqual(["FYI: tests are green"])
    expect(w.tasks.holdsWait("ask-1")).toBe(true)
    expect(w.notices).toEqual([])
  })

  test("a wait: true message to an interrupted parent is held and opens a wait that a reply after Resume ends", async () => {
    const here = project()
    const addressee = await here.manager.createChat({ name: "Addressee" })
    const waiter = await publishTestSubagent(here.manager, here.root, "Waiter", addressee)
    const w = live(here, waiter)
    const a = live(here, addressee)
    a.state = "interrupted"
    const run = await here.messaging.observeRun({ sessionId: addressee })

    const result = await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-1", { to: addressee, text: "Which file?", wait: true })
    expect(result.content).toStartWith(`Held for ${addressee}`)
    expect(result.content).toContain("Waiting on")
    expect(w.tasks.holdsWait("ask-1")).toBe(true)
    expect(here.replyWaitCells(waiter)).toHaveLength(1)
    // A yield before Resume, such as the interrupt's own end, is no answer.
    await run.yielded({ lastText: "Interrupted.", waitRequested: false })
    await settle()
    expect(w.tasks.holdsWait("ask-1")).toBe(true)

    a.state = "running"
    await read(here, addressee, waiter, "ask-1")
    await message(here.messaging, { id: addressee }, "answer-1", { to: waiter, text: "main.ts" })
    expect(w.tasks.holdsWait("ask-1")).toBe(false)
    expect(w.notices).toEqual([])
    expect(here.replyWaitCells(waiter)).toEqual([])
  })

  test("a wait with no text on an interrupted parent opens, and the first yield after Resume ends it", async () => {
    const here = project()
    const addressee = await here.manager.createChat({ name: "Addressee" })
    const waiter = await publishTestSubagent(here.manager, here.root, "Waiter", addressee)
    const w = live(here, waiter)
    const a = live(here, addressee)
    a.state = "interrupted"
    const run = await here.messaging.observeRun({ sessionId: addressee })

    const result = await message(here.messaging, { id: waiter, tasks: w.tasks }, "wait-1", { to: addressee, wait: true })
    expect(result.content).toStartWith(`Waiting on ${addressee}`)
    expect(w.tasks.holdsWait("wait-1")).toBe(true)

    a.state = "running"
    await run.yielded({ lastText: "I will answer after the build.", waitRequested: false })
    await settle()
    expect(w.tasks.holdsWait("wait-1")).toBe(false)
    expect(w.notices[0]?.text).toContain("I will answer after the build.")
  })

  test("a message held with no reader or refused opens no wait", async () => {
    const here = project()
    const waiter = await here.manager.createChat({ name: "Waiter" })
    // No run of this child is live in this process, so nothing runs it.
    const closed = await publishTestSubagent(here.manager, here.root, "closed", waiter)
    const w = live(here, waiter)

    expect((await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-1", { to: closed, text: "hello", wait: true })).content).toBe(`Held for ${closed}: nothing runs it now. It reads the message when it runs again. Do not send the message again or send a reminder. Continue your own work.`)
    expect((await message(here.messaging, { id: waiter, tasks: w.tasks }, "wait-1", { to: closed, wait: true })).content).toBe(`Not waiting on ${closed}: it cannot answer now (no_reader). It reads a message only when it runs again. Do not wait for it or send it a reminder. Continue your own work on your own judgment.`)
    expect((await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-2", { to: "missing", text: "hello", wait: true })).content).toStartWith("Not delivered")
    expect(w.tasks.activeTaskCount()).toBe(0)
    expect(here.replyWaitCells(waiter)).toEqual([])
    expect(w.notices).toEqual([])
  })
})

describe("children and parents", () => {
  for (const independent of ["none", "command", "own-command", "nested-command", "sibling", "frontier"] as const) test(`workflow progress (${independent}) keeps only work independent of the asking conversation`, async () => {
    const here = project()
    const parent = await here.manager.createChat({ name: "Root" })
    const workflow = await childWorkflow(here, parent, "Review")
    const identity = await here.messaging.identity(workflow)
    if (!identity?.workflowMembership) throw new Error("Expected workflow membership")
    const workflowId = identity.workflowMembership.workflowId
    const child = await publishTestSubagent(here.manager, here.root, "nested", workflow)
    const p = live(here, parent)
    const c = live(here, child)
    const agentTasks = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} })
    const siblingTasks = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} })
    const command = Promise.withResolvers<{ status: "completed"; content: string }>()
    let siblingState: LiveRecipientState = independent === "sibling" ? "running" : "waiting_on_work"
    let runnable = independent === "frontier"
    if (independent === "command") siblingTasks.track({ done: command.promise, meta: { id: "check", type: "background_command", description: "Check" } })
    if (independent === "own-command") agentTasks.track({ done: command.promise, meta: { id: "check", type: "background_command", description: "Check" } })
    if (independent === "nested-command") c.tasks.track({ done: command.promise, meta: { id: "check", type: "background_command", description: "Check" } })
    runChild(agentTasks, child)
    p.tasks.track({ done: new Promise(() => {}), meta: { id: workflowId, type: "workflow", description: "Review" } })
    live(here, workflow).state = "waiting_on_work"
    unregisters.push(registerLiveWorkflowControl(here.reader, {
      workflowId, kind: "workflow",
      handBackMember: async (continueMember) => continueMember(), memberHost: async () => undefined,
      state: async () => "waiting_on_work",
      workProgress: async () => ({
        runnable,
        members: [
          { sessionId: workflow, conversationId: identity.conversationId, state: "waiting_on_work", tasks: agentTasks },
          { sessionId: "sibling-member", conversationId: "sibling-conversation", state: siblingState, tasks: siblingTasks },
        ],
      }),
      deliver: async (_input, decide) => decide("waiting_on_work"),
      notify: async () => false,
    }))
    // The nested child asks the workflow agent, which waits on its own work.
    const workflowRun = await here.messaging.observeRun({ sessionId: workflow, tasks: agentTasks })
    await message(here.messaging, { id: child, tasks: c.tasks }, "ask-nested", { to: workflow, text: "Keep the API?", wait: true })
    await read(here, workflow, child, "ask-nested")
    // The workflow agent asks the chat for that decision instead.
    await message(here.messaging, { id: workflow, tasks: agentTasks }, "ask-parent", { to: parent, text: "Keep the API?", wait: true })
    await read(here, parent, workflow, "ask-parent")
    const parentRun = await here.messaging.observeRun({ sessionId: parent, tasks: p.tasks })
    await parentRun.yielded({ lastText: "I wait for the workflow.", waitRequested: true })
    await settle()
    expect(agentTasks.holdsWait("ask-parent")).toBe(independent !== "none")
    if (independent === "sibling") parentRun.resumed()
    siblingState = "interrupted"
    runnable = false
    command.resolve({ status: "completed", content: "Checked" })
    if (independent === "none" || independent === "sibling" || independent === "frontier") notifyLiveWorkChanged(here.reader)
    await settle()
    if (independent === "sibling") {
      expect(agentTasks.holdsWait("ask-parent")).toBe(true)
      await parentRun.yielded({ lastText: "I wait again.", waitRequested: true })
    }
    expect(agentTasks.holdsWait("ask-parent")).toBe(false)
    expect(p.tasks.processRecords().map(({ id, kind }) => ({ id, kind }))).toEqual([{ id: workflowId, kind: "workflow" }])
    await workflowRun.yielded({ lastText: "The chat did not decide.", waitRequested: false })
    expect(c.tasks.holdsWait("ask-nested")).toBe(false)
  })

  test("a parent that reads the question and then waits on another running child keeps the child's wait, and the end of its turn without a reply ends it", async () => {
    const here = project()
    const parent = await here.manager.createChat({ name: "Root" })
    const child = await publishTestSubagent(here.manager, here.root, "child", parent)
    const reviewerChild = await publishTestSubagent(here.manager, here.root, "reviewer-child", parent)
    const p = live(here, parent)
    const c = live(here, child)
    runChild(p.tasks, child)
    runChild(p.tasks, reviewerChild)
    const parentRun = await here.messaging.observeRun({ sessionId: parent, tasks: p.tasks })

    await message(here.messaging, { id: child, tasks: c.tasks }, "ask-1", { to: parent, text: "Keep the old API?", wait: true })
    expect(await readReplyWaitViews(here.reader, here.manager.read, child)).toMatchObject([{ sessionId: parent, isParent: true }])
    await read(here, parent, child, "ask-1")
    // A `sleep` or a `process` wait on its running children keeps the turn.
    await parentRun.yielded({ lastText: "The reviewer child runs, so I wait for it.", waitRequested: true })
    await settle()
    expect(c.tasks.holdsWait("ask-1")).toBe(true)
    expect(c.notices).toEqual([])

    await parentRun.yielded({ lastText: "Checking with the reviewer child first.", waitRequested: false })
    await settle()
    expect(c.tasks.holdsWait("ask-1")).toBe(false)
    expect(c.notices[0]?.text).toContain("Checking with the reviewer child first.")
  })

  // The parent waits on work that cannot end while the child waits: the
  // asking child itself. Nothing else wakes the parent, so its park is a
  // yield.
  test("a parent that reads the question and then waits only on the asking child ends the child's wait", async () => {
    const here = project()
    const parent = await here.manager.createChat({ name: "Root" })
    const child = await publishTestSubagent(here.manager, here.root, "child", parent)
    const p = live(here, parent)
    const c = live(here, child)
    runChild(p.tasks, child)
    const parentRun = await here.messaging.observeRun({ sessionId: parent, tasks: p.tasks })

    await message(here.messaging, { id: child, tasks: c.tasks }, "ask-1", { to: parent, text: "Keep the old API?", wait: true })
    await read(here, parent, child, "ask-1")
    await parentRun.yielded({ lastText: "I wait for my child.", waitRequested: true })
    await settle()
    expect(c.tasks.holdsWait("ask-1")).toBe(false)
    expect(c.notices[0]?.text).toContain("I wait for my child.")
  })

  test("a parent that reads the question and then starts to wait for a reply of its own ends the child's wait", async () => {
    const here = project()
    const parent = await here.manager.createChat({ name: "Root" })
    const child = await publishTestSubagent(here.manager, here.root, "child", parent)
    const reviewer = await childWorkflow(here, parent, "Reviewer")
    const p = live(here, parent)
    const c = live(here, child)
    live(here, reviewer)
    const parentRun = await here.messaging.observeRun({ sessionId: parent })

    await message(here.messaging, { id: child, tasks: c.tasks }, "ask-1", { to: parent, text: "Keep the old API?", wait: true })
    await read(here, parent, child, "ask-1")
    await message(here.messaging, { id: parent, tasks: p.tasks }, "forward-1", { to: reviewer, text: "Does anything still call the old API?", wait: true })
    await parentRun.yielded({ lastText: "I asked the reviewer.", waitRequested: true })
    await settle()
    expect(c.tasks.holdsWait("ask-1")).toBe(false)
    expect(c.notices[0]?.text).toContain("I asked the reviewer.")
    expect(p.tasks.holdsWait("forward-1")).toBe(true)
  })

  test("the prose-question case: the child waits again with no text, and the later reply ends that wait", async () => {
    const here = project()
    const parent = await here.manager.createChat({ name: "Root" })
    const child = await publishTestSubagent(here.manager, here.root, "child", parent)
    const p = live(here, parent)
    const c = live(here, child)
    const parentRun = await here.messaging.observeRun({ sessionId: parent })

    await message(here.messaging, { id: child, tasks: c.tasks }, "ask-1", { to: parent, text: "Keep the old API?", wait: true })
    await read(here, parent, child, "ask-1")
    // The parent asks the person in prose and ends its turn.
    p.state = "idle"
    await parentRun.yielded({ lastText: "Do you want to keep the old API? I will tell the child.", waitRequested: false })
    await settle()
    expect(c.notices[0]?.text).toContain("I will tell the child.")
    // A child waits on its parent again when the parent said that it will reply.
    expect(c.notices[0]?.text).toContain(`If it says that it will reply, wait again: call message_session with to "${parent}", wait true, and no text.`)

    expect((await message(here.messaging, { id: child, tasks: c.tasks }, "wait-2", { to: parent, wait: true })).content).toStartWith(`Waiting on ${parent}`)
    // Nothing was sent: the wait holds no message for the parent to read.
    expect(await readUnreadMessages(here.reader, parent)).toEqual([])
    p.state = "running"
    await message(here.messaging, { id: parent }, "answer-1", { to: child, text: "Keep it." })
    expect(c.tasks.holdsWait("wait-2")).toBe(false)
    expect(c.notices).toHaveLength(1)
  })
})

describe("the cycle check", () => {
  test("a wait with no text on a parent parked on its running children opens, and the parent's later reply ends it once", async () => {
    const here = project()
    const parent = await here.manager.createChat({ name: "Root" })
    const child = await publishTestSubagent(here.manager, here.root, "child", parent)
    live(here, parent)
    unregisters.push(registerTestChildRun(here.reader, { sessionId: child, runId: "child-run", parentSessionId: parent, parentConversationId: `${parent}-conversation`, parentToolCallId: "child-tool" }))
    const notices: string[] = []
    const tasks = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: (text) => { notices.push(text) } })
    // The parent asked the person in prose and parked on its running child.
    await (await here.messaging.observeRun({ sessionId: parent })).yielded({ waitRequested: false })

    // A park on children ends on any input, so it closes no cycle.
    expect((await message(here.messaging, { id: child, tasks }, "wait-1", { to: parent, wait: true })).content).toStartWith(`Waiting on ${parent}`)
    expect(tasks.holdsWait("wait-1")).toBe(true)

    await message(here.messaging, { id: parent }, "answer-1", { to: child, text: "Keep it." })
    expect(tasks.holdsWait("wait-1")).toBe(false)
    expect(tasks.activeTaskCount()).toBe(0)
    expect(notices).toEqual([])
    expect(await readReplyWaitViews(here.reader, here.manager.read, child)).toEqual([])
  })

  test("a wait with no text on a session that waits on the waiter for a reply is refused", async () => {
    const here = project()
    const a = await here.manager.createChat({ name: "A" })
    const b = await childWorkflow(here, a, "B")
    const sa = { id: a, ...live(here, a) }
    const sb = { id: b, ...live(here, b) }
    await message(here.messaging, sa, "a-waits", { to: b, text: "need B", wait: true })

    const closing = await message(here.messaging, sb, "b-waits", { to: a, wait: true })
    expect(closing.content).toContain("it already waits on you")
    expect(sb.tasks.activeTaskCount()).toBe(0)
  })

  test("a three-session cycle of waits cannot form", async () => {
    const here = project()
    const a = await here.manager.createChat({ name: "A" })
    const b = await childWorkflow(here, a, "B")
    const c = await publishTestSubagent(here.manager, here.root, "c", b)
    const sa = { id: a, ...live(here, a) }
    const sb = { id: b, ...live(here, b) }
    const sc = { id: c, tasks: createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} }) }
    unregisters.push(registerLiveSessionControl(here.reader, {
      sessionId: c,
      state: async () => "running",
      child: { runId: `${c}-run`, parentSessionId: b, parentConversationId: `${b}-conversation`, parentToolCallId: `${c}-tool`, modules: async () => undefined, backgroundTasks: sc.tasks, stop: () => {}, interrupt: async () => {}, progress: () => ({ toolUses: 0, totalTokens: 0, startedAtMs: 0 }) },
      deliver: async (_input, decide) => decide("running"),
      notify: async () => false,
    }))
    await message(here.messaging, sa, "a-waits", { to: b, text: "need B", wait: true })
    await message(here.messaging, sb, "b-waits", { to: c, text: "need C", wait: true })
    expect(sb.tasks.holdsWait("b-waits")).toBe(true)

    // Only a parent and its own child wait on each other, so the edge that
    // would close the cycle is refused.
    const closing = await message(here.messaging, sc, "c-waits", { to: a, wait: true })
    expect(closing.content).toContain("you can wait only on your parent or on your own child")
    expect(sc.tasks.activeTaskCount()).toBe(0)
  })
})

import { expect, spyOn, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { readOutcomeRecord, writeOutcomeRecord } from "../../../../../src/infra/command-handover.js"
import { createEmit, EventBus } from "../../../../../src/infra/event-bus.js"
import type { BackgroundCommandRecord } from "../../../../../src/infra/runtime-fact-types.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js"
import type { ActiveBackgroundCommandDescriptor, BackgroundWorkResult } from "../../../../../src/orchestration/agent-runtime/background-work.js"
import { createChildBackgroundExecution } from "../../../../../src/orchestration/modules/subagents/execution/child-background.js"
import { createConversationTreeWriterController } from "../../../../../src/orchestration/chat/tree-writer.js"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND, decodeQueuedBackgroundNotification } from "../../../../../src/orchestration/session/conversation/queued-background-notifications.js"
import { commandHandoversOfAsync, writeCommandHandover } from "../../../../../src/orchestration/session/command-handover.js"
import { subscribeSessionRuntimeFacts } from "../../../../../src/orchestration/session/create-session-infra.js"
import { createSessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js"
import { WorkflowInjectionQueue } from "../../../../../src/orchestration/workflow-host/injection-queue.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"
import { handedOverRow, handoverAuthority } from "../../agent-runtime/_command-handover-fixtures.js"

const temporaryDirectory = temporaryDirectories()

// The child's status names the commands its own session entry states, and
// the background index of its session lists the commands it records, so the
// child run states and records them each time they change, as a chat runner does.
test("a child run states and records the background commands it runs each time they change", async () => {
  const seen: string[][] = []
  const recorded: BackgroundCommandRecord[] = []
  const emptied = Promise.withResolvers<void>()
  const background = createChildBackgroundExecution({
    conversation: { holdBackgroundNotification: async () => undefined, waitForBackgroundNotification: async () => {}, commitBackgroundNotification: async () => null },
    queue: new WorkflowInjectionQueue(),
    abort: () => {},
    onChildEvent: (event) => { if (event.type === "tool.background_command.recorded") recorded.push(event.data) },
    awaitDurableFacts: async () => {},
    onCommandsChanged: (commands: readonly ActiveBackgroundCommandDescriptor[]) => {
      seen.push(commands.map((command) => command.id))
      if (commands.length === 0) emptied.resolve()
    },
  })
  const done = Promise.withResolvers<BackgroundWorkResult>()
  background.owner.tasks.track({ done: done.promise, meta: { id: "bash-bg-1", type: "background_command", description: "python3 reshape.py", toolUseId: "toolu_reshape" }, kill: { run: () => {} }, startedAtMs: 1 })
  done.resolve({ status: "completed", content: "done", exit: { code: 0 } })
  await emptied.promise
  expect(seen).toEqual([["bash-bg-1"], []])
  expect(recorded.map((record) => [record.toolUseId, record.state, record.state === "settled" ? record.status : undefined]))
    .toEqual([["toolu_reshape", "running", undefined], ["toolu_reshape", "settled", "completed"]])
  await background.close()
})

test.each(["closing", "closed"] as const)("a command that settles while its host is %s survives in its conversation's keyed hold", async (phase) => {
  const projectRoot = temporaryDirectory("child-command-close-")
  const store = createSqliteEventStore(join(projectRoot, "facts.sqlite"))
  const reader = asAsyncEventReadSurface(store)
  const writer = asAsyncEventWriter(store)
  const deps = { conversationId: "conversation", sessionId: "child", projectRoot, store: reader, projectionReader: reader, writer }
  const conversation = createConversationTreeWriterController(deps)
  const attempts = spyOn(conversation, "holdBackgroundNotification")
  const background = createChildBackgroundExecution({
    conversation, queue: new WorkflowInjectionQueue(), abort: () => {},
    onChildEvent: () => {}, awaitDurableFacts: async () => {}, onCommandsChanged: () => {},
    notificationRetryMs: 1,
  })
  const done = Promise.withResolvers<BackgroundWorkResult>()
  const track = () => background.owner.tasks.track({
    done: done.promise,
    meta: { id: "command", type: "background_command", description: "command", toolUseId: "bash", notificationKey: "command:command" },
    kill: { run: () => { done.resolve({ status: "failed", content: "terminated", exit: { code: 1 } }) } },
  })
  try {
    if (phase === "closing") track()
    else await background.close()
    background.owner.tasks.stopAdmission()
    if (phase === "closed") track()
    await background.close()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const held = await reader.readInFlight("child", QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)
    expect(held).toHaveLength(1)
    const notification = held[0] && decodeQueuedBackgroundNotification(held[0], "conversation")
    if (!notification) throw new Error("missing command completion")
    expect(notification.text).toContain("terminated")
    await conversation.dispose()
    const closedAttempts = attempts.mock.calls.length
    await new Promise<void>((resolve) => setTimeout(resolve, 15))
    expect(attempts.mock.calls.length).toBe(closedAttempts)
    const resumed = createConversationTreeWriterController(deps)
    try {
      await resumed.commitBackgroundNotification(notification)
      await resumed.commitBackgroundNotification(notification)
      expect((await resumed.getState()).entriesById["command:command"]).toBeDefined()
      expect(await reader.readInFlight("child", QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([])
    } finally { await resumed.dispose() }
  } finally {
    await background.close()
    await conversation.dispose()
    store.close()
  }
})

test("closing a child cancels an already scheduled delivery retry and leaves recovery to the next conversation", async () => {
  const projectRoot = temporaryDirectory("child-notification-retry-close-")
  const store = createSqliteEventStore(join(projectRoot, "facts.sqlite"))
  const reader = asAsyncEventReadSurface(store), writer = asAsyncEventWriter(store)
  const deps = { conversationId: "conversation", sessionId: "child", projectRoot, store: reader, projectionReader: reader, writer }
  const conversation = createConversationTreeWriterController(deps)
  const hold = conversation.holdBackgroundNotification.bind(conversation)
  const admitted = Promise.withResolvers<void>()
  let attempts = 0
  spyOn(conversation, "holdBackgroundNotification").mockImplementation(async (...args) => {
    attempts += 1
    await hold(...args)
    admitted.resolve()
    throw new Error("delivery rejected after durable admission")
  })
  const background = createChildBackgroundExecution({
    conversation, queue: new WorkflowInjectionQueue(), abort: () => {}, notificationRetryMs: 1,
    onChildEvent: () => {}, awaitDurableFacts: async () => {}, onCommandsChanged: () => {},
  })
  try {
    background.owner.tasks.track({
      done: Promise.resolve({ status: "completed", content: "done" }),
      meta: { id: "command", type: "background_command", description: "command", notificationKey: "command:command" },
    })
    await admitted.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    await expect(background.close()).rejects.toThrow("delivery rejected after durable admission")
    await conversation.dispose()
    const closedAttempts = attempts
    await new Promise<void>((resolve) => setTimeout(resolve, 15))
    expect(attempts).toBe(closedAttempts)
    const held = await reader.readInFlight("child", QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)
    const notification = held[0] && decodeQueuedBackgroundNotification(held[0], "conversation")
    if (!notification) throw new Error("missing completion hold")
    const resumed = createConversationTreeWriterController(deps)
    try {
      await resumed.commitBackgroundNotification(notification)
      expect((await resumed.getState()).entriesById["command:command"]).toBeDefined()
      expect(await reader.readInFlight("child", QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([])
    } finally { await resumed.dispose() }
  } finally {
    await background.close().catch(() => {})
    await conversation.dispose()
    store.close()
  }
})

test("a child preserves ended-command recovery evidence when final-output persistence rejects and settles it on the next recovery", async () => {
  const dir = temporaryDirectory("child-command-recovery-")
  const store = createSqliteEventStore(join(dir, "facts.sqlite"))
  const reader = asAsyncEventReadSurface(store)
  const writer = asAsyncEventWriter(store)
  const scope = { sessionId: "child", conversationId: "child-conversation" }
  const row = handedOverRow(dir, scope)
  writeFileSync(row.logPath, "recoverable final tail\n")
  writeOutcomeRecord(row.recordPath, {
    version: 1, handedOverAtMs: 1,
    outcome: { code: 0, signal: null, deadlineExpired: false, endedAtMs: Date.now() },
  })
  const evidence = readFileSync(row.recordPath, "utf8")
  const authority = handoverAuthority({ reader: store, writer, adopt: () => ({ kind: "ended", record: readOutcomeRecord(row.recordPath) }) })
  let delivered = 0
  let refused = 0
  try {
    await writeCommandHandover({ reader, writer, row })
    const recover = async (rejectOutput: boolean) => {
      const bus = new EventBus()
      const emit = createEmit(bus)
      const facts = createSessionFactWriter({
        sessionId: scope.sessionId,
        writer: { ...writer, append: (event) => {
          if (rejectOutput && event.type === "tool.execution_output.recorded") {
            refused++
            return Promise.reject(new Error("final output refused"))
          }
          return writer.append(event)
        } },
      })
      const subscription = subscribeSessionRuntimeFacts(bus, { sessionId: scope.sessionId, sessionEventWriter: facts, requireWriterBarrier: false })
      const child = createChildBackgroundExecution({
        conversation: { holdBackgroundNotification: async () => undefined, waitForBackgroundNotification: async () => {}, commitBackgroundNotification: async () => { delivered++; return null } },
        queue: new WorkflowInjectionQueue(), abort: () => {}, onCommandsChanged: () => {},
        onChildEvent: (event) => { emit(event.type, { sessionId: scope.sessionId, data: event.data }) },
        awaitDurableFacts: () => subscription.awaitDurableFacts(),
        handover: { authority, ...scope },
      })
      try {
        await child.adoptHandedOver()
        await subscription.awaitDurableFacts().catch(() => {})
        if (rejectOutput) {
          expect(refused).toBe(1)
          expect(subscription.getPersistenceFailure()?.message).toBe("final output refused")
          expect(await commandHandoversOfAsync(reader, scope.sessionId, scope.conversationId)).toHaveLength(1)
          expect(readFileSync(row.recordPath, "utf8")).toBe(evidence)
          expect(readFileSync(row.logPath, "utf8")).toBe("recoverable final tail\n")
          expect(delivered).toBe(0)
          expect(store.read({ sessionId: scope.sessionId, types: ["tool.execution_output.recorded"] })).toEqual([])
        } else {
          expect(subscription.getPersistenceFailure()).toBeNull()
          expect(await commandHandoversOfAsync(reader, scope.sessionId, scope.conversationId)).toEqual([])
          expect(existsSync(row.recordPath)).toBe(false)
          expect(delivered).toBe(1)
          expect(store.read({ sessionId: scope.sessionId, types: ["tool.execution_output.recorded"] })).toHaveLength(1)
        }
      } finally {
        await child.close()
        subscription.unsubscribe()
        await bus.dispose()
        facts.dispose()
      }
    }
    await recover(true)
    await recover(false)
  } finally {
    store.close()
  }
})

import { describe, expect, test } from "bun:test"

import { asAsyncEventReadSurface, asAsyncEventWriter, requireGuardedEventAppender, type EventStoreReadSurface } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { createBackgroundNotificationDelivery as createSessionBackgroundNotificationDelivery } from "../../../../src/orchestration/app-service/session-background-notifications"
import { createConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer"
import { createBackgroundNotificationDelivery } from "../../../../src/orchestration/runner/background-notification-delivery"
import { readReconciledBranch } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { holdQueuedBackgroundNotification, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-background-notifications"
import { WorkflowInjectionQueue } from "../../../../src/orchestration/workflow-host/injection-queue"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work"
import { temporaryDirectories } from "../../../helpers/directories"
import { chatEntry } from "../app-service/_frontend-projection-fixtures"
import { mockRunner } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { createWorkflowMemberInputs } from "../../../../src/orchestration/workflow-host/member-inputs"

const temporary = temporaryDirectories()

describe("workflow background notification delivery", () => {
  test("member adoption leaves a notice the agent's own live input holds to that input, which commits it once, and still recovers a notice nobody holds", async () => {
    const projectRoot = temporary("member-notices-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const read = asAsyncEventReadSurface(store)
    const writer = asAsyncEventWriter(store)
    const sessionId = "member"
    const conversationId = "member-notices"
    const tree = createConversationTreeWriterController({ sessionId, conversationId, projectRoot, store: read, projectionReader: read, writer })
    const queue = new WorkflowInjectionQueue()
    const notifications = createBackgroundNotificationDelivery({ conversation: tree, queue, abort() { throw new Error("notice delivery failed") } })
    const inputs = createWorkflowMemberInputs({ sessionId, conversationId, reader: read, writer, tree, deactivate: async () => {}, queue, notifications })
    try {
      const live = await tree.holdBackgroundNotification("live command finished", "notice-live")
      if (!live) throw new Error("the live notice was not held")
      await holdQueuedBackgroundNotification(writer, sessionId, conversationId, "orphan command finished", "notice-orphan")
      expect(await inputs.adopt()).toBe(true)
      tree.beginTurn()
      await tree.recordCanonicalMessage({ kind: "user", content: live.text, origin: "system", backgroundNotificationIds: ["notice-live"] })
      await tree.flushSavePoint()
      await tree.endTurn()
      const branch = await readReconciledBranch({ sessionId, conversationId, store: read, writer, projectRoot })
      expect(branch?.map((entry) => entry.id).sort()).toEqual(["notice-live", "notice-orphan"])
      expect(store.readInFlight(sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([])
    } finally {
      await tree.dispose()
      store.close()
    }
  })

  test("handoff during a notice hold refuses queue admission without aborting or acknowledging its durable delivery", async () => {
    const projectRoot = temporary("background-notification-handoff-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const conversation = createConversationTreeWriterController({ conversationId: "handoff", sessionId: "parent", projectRoot, store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    const held = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const queue = new WorkflowInjectionQueue()
    let aborted = false
    const hold = conversation.holdBackgroundNotification.bind(conversation)
    const delivery = createBackgroundNotificationDelivery({
      conversation: { ...conversation, async holdBackgroundNotification(...args) { const value = await hold(...args); held.resolve(); await release.promise; return value } },
      queue, abort() { aborted = true },
    })
    try {
      const receipt = delivery.enqueue("finished result", "command:late")
      void receipt.catch(() => {})
      await held.promise
      queue.handoffStarted()
      release.resolve()
      await expect(receipt).rejects.toThrow("after handoff")
      expect(aborted).toBe(false)
      expect(queue.drainPending()).toBeNull()
      expect(store.readInFlight("parent", QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND).map(({ key }) => key)).toEqual(["command:late"])
    } finally {
      await conversation.dispose()
      store.close()
    }
  })

  test("holds a command completion under its key before it reaches the queue, and a repeat of one its conversation committed reaches the queue no more", async () => {
    const projectRoot = temporary("background-notification-delivery-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const writer = asAsyncEventWriter(store)
    const conversation = createConversationTreeWriterController({ conversationId: "step-conversation", sessionId: "flow", projectRoot, store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer })
    const queue = new WorkflowInjectionQueue()
    const heldAtEnqueue: string[][] = []
    const enqueue = queue.enqueue.bind(queue)
    queue.enqueue = (text, options) => {
      heldAtEnqueue.push(store.readInFlight("flow", QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND).map((row) => row.key))
      return enqueue(text, options)
    }
    const delivery = createBackgroundNotificationDelivery({ conversation, queue, abort: () => { throw new Error("the delivery failed") } })
    const text = "<background_command_notification>exited with code 0</background_command_notification>"

    let committed = false
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (content, key, runtimeNotice) => delivery.enqueue(content, key, runtimeNotice).then(() => { committed = true }) })
    registry.track({
      done: Promise.resolve({ status: "completed", content: "exited with code 0" }),
      meta: { id: "bash-bg-1", type: "background_command", description: "command", notificationKey: "command:bash-bg-1" },
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await delivery.settle()
    expect(committed).toBe(false)
    expect(registry.assertHandoffReady()).not.toBeNull()
    expect(heldAtEnqueue).toEqual([["command:bash-bg-1"]])
    const delivered = queue.drain()
    expect(delivered).toMatchObject({ origin: "silent-system", backgroundNotificationIds: ["command:bash-bg-1"] })
    // A command's completion is no runtime notice, so a hosted agent that reads it dispatches.
    expect(delivered?.runtimeNotice).toBeUndefined()
    // The step's turn commits what it read, which retires the hold.
    conversation.beginTurn()
    await conversation.recordCanonicalMessage({ kind: "user", content: delivered?.message ?? "", backgroundNotificationIds: ["command:bash-bg-1"], origin: "system" })
    expect(committed).toBe(false)
    await conversation.flushSavePoint()
    expect(committed).toBe(true)
    // A model request that carries this result can hand off immediately.
    expect(registry.assertHandoffReady()).toBeNull()
    expect(store.readInFlight("flow", QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([])

    delivery.enqueue(text, "command:bash-bg-1")
    await delivery.settle()

    expect(queue.drain()).toBeNull()
    expect(store.readInFlight("flow", QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([])

    // A notice that the registry labels, such as a child's completion, reaches the queue as a runtime notice.
    void delivery.enqueue("<subagent_notifications/>", "subagent-completions:child", true)
    await delivery.settle()
    expect(queue.drain()).toMatchObject({ origin: "silent-system", backgroundNotificationIds: ["subagent-completions:child"], runtimeNotice: true })
    await conversation.dispose()
    store.close()
  })

  test.each(["flush", "suspend", "dispose"] as const)("rejects uncommitted delivery on %s failure and retains its durable hold", async (failure) => {
    const projectRoot = temporary("background-notification-failure-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const base = asAsyncEventWriter(store)
    const guarded = requireGuardedEventAppender(base, "notification test requires guarded writes")
    let refused = false
    const writer = { ...base, appendBatchGuarded: async (...args: Parameters<typeof guarded.appendBatchGuarded>) => {
      if (refused) throw new Error("injected notification commit failure")
      return guarded.appendBatchGuarded(...args)
    } }
    const conversation = createConversationTreeWriterController({ conversationId: "conversation", sessionId: "parent", projectRoot, store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer })
    let aborted = false
    const queue = new WorkflowInjectionQueue()
    const delivery = createBackgroundNotificationDelivery({ conversation, queue, abort: () => { aborted = true } })
    try {
      const acknowledgement = delivery.enqueue("completed", "command:failed")
      void acknowledgement.catch(() => {})
      await delivery.settle()
      if (failure !== "dispose") {
        conversation.beginTurn()
        await conversation.recordCanonicalMessage({ kind: "user", content: "completed", backgroundNotificationIds: ["command:failed"], origin: "system" })
        if (failure === "suspend") conversation.suspendPending()
        else {
          refused = true
          await expect(conversation.flushSavePoint()).rejects.toThrow("injected notification commit failure")
        }
      } else {
        await conversation.dispose()
      }
      await expect(acknowledgement).rejects.toThrow()
      expect(store.readInFlight("parent", QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND).map((row) => row.key)).toEqual(["command:failed"])
      expect(aborted).toBe(false)
    } finally {
      refused = false
      await conversation.dispose()
      store.close()
    }
  })

  test("drains held session notifications in persisted order through the async state reader", async () => {
    const projectRoot = temporary("session-background-notification-delivery-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const writer = asAsyncEventWriter(store)
    const sessionId = "chat"
    const conversationId = "conversation"
    const conversation = createConversationTreeWriterController({ conversationId, sessionId, projectRoot, store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer })
    try {
      await writer.putInFlight?.(sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND, "first", { conversationId, text: "first" })
      await writer.putInFlight?.(sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND, "second", { conversationId, text: "second" })
      const syncInFlightForbidden: EventStoreReadSurface = {
        ...store,
        readInFlight() {
          throw new Error("notification recovery used the synchronous state reader")
        },
      }
      let admitted = true
      const read = Promise.withResolvers<void>()
      const releaseRead = Promise.withResolvers<void>()
      let delaysRead = false
      const reader = asAsyncEventReadSurface(store)
      const delivery = createSessionBackgroundNotificationDelivery({
        sessionId,
        projectRoot,
        eventStore: asAsyncEventReadSurface(syncInFlightForbidden),
        projectionReader: { ...reader, readInFlight: async (...args) => {
          if (delaysRead) { read.resolve(); await releaseRead.promise }
          return reader.readInFlight(...args)
        } },
        eventWriter: writer,
        admitsDelivery: () => admitted,
        sweepAfterCommit: () => {},
      })

      await delivery.drainHeld(chatEntry({ conversationId, runner: null }))

      const branch = await readReconciledBranch({
        conversationId,
        sessionId,
        store: asAsyncEventReadSurface(store),
        writer,
        projectRoot,
      })
      expect((branch ?? []).flatMap((entry) =>
        entry.kind === "message" && entry.message.kind === "user" && typeof entry.message.content === "string"
          ? [entry.message.content]
          : [],
      )).toEqual(["first", "second"])
      expect(store.readInFlight(sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([])
      await writer.putInFlight?.(sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND, "late", { conversationId, text: "held during stop" })
      let liveDeliveries = 0
      const closing = chatEntry({ conversationId, runner: mockRunner(sessionId, {
        deliverBackgroundNotification: async () => { liveDeliveries += 1; return true },
      }) })
      delaysRead = true
      const draining = delivery.drainHeld(closing)
      await read.promise
      admitted = false
      releaseRead.resolve()
      await draining
      expect(liveDeliveries).toBe(0)
      expect(await delivery.deliver(closing, { key: "late", text: "held during stop" })).toBe(false)
      expect(store.readInFlight(sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toHaveLength(1)
    } finally {
      await conversation.dispose()
      store.close()
    }
  })
})

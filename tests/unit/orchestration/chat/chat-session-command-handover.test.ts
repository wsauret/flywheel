import { afterEach, describe, expect, it } from "bun:test"

import { EventBus } from "../../../../src/infra/event-bus"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import type { ConversationMessage, StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types"
import type { BackgroundExecutionOwner } from "../../../../src/orchestration/agent-runtime/background-execution-owner"
import type { ChatRunner } from "../../../../src/orchestration/chat/runner-types"
import { createChatSession } from "../../../../src/orchestration/chat/session"
import { createConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer"
import { CONTINUATION_MESSAGES } from "../../../../src/orchestration/agent-runtime/continuation-messages"
import { COMMAND_HANDOVER_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/command-handover"
import { createConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-background-notifications"
import { interruptedTurnEnd, interruptedTurnMessage, turnEndEntryId } from "../../../../src/orchestration/session/conversation/turn-end-record"
import { newTestRunner } from "../../../helpers/agent-runner.js"
import { temporaryDirectories } from "../../../helpers/directories"
import { fakeContainer, handedOverRow, handoverAuthority } from "../agent-runtime/_command-handover-fixtures"
import { asModelClient } from "../agent-runtime/_model-client"
import { createTestChatSessionDeps } from "./_chat-session-agent-runtime-fixtures"

const temporary = temporaryDirectories()

describe("a chat host built with a command handover", () => {
  let session: ChatRunner | null = null

  afterEach(async () => {
    await session?.dispose()
    session = null
  })

  it("adopts the command handed to its conversation before its first request, and publishes that command's completion once", async () => {
    const dir = temporary("chat-command-handover-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
    const sessionId = "chat-handover"
    const conversationId = `conversation-${sessionId}`
    const events: string[] = []
    const container = fakeContainer(events)
    const row = handedOverRow(dir, { sessionId, conversationId })
    await Bun.write(row.logPath, "compiled 12 modules\nfixture-command-finished\n")
    store.putInFlight(sessionId, COMMAND_HANDOVER_IN_FLIGHT_KIND, row.processId, row)
    const authority = handoverAuthority({
      reader: store,
      writer: asAsyncEventWriter(store),
      heard: false,
      adopt: () => { events.push("adopt"); return { kind: "adopted", owned: container.owned } },
    })
    const calls: ConversationMessage[][] = []
    const runningAtRequest: string[][] = []
    let background: BackgroundExecutionOwner | undefined
    const parks: PromiseWithResolvers<void>[] = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const eventBus = new EventBus()
    eventBus.subscribeToType("agent.turn.parked", () => { parks[calls.length - 1]?.resolve() })
    const createClient = async () => asModelClient({
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools(options: StreamOptions) {
        calls.push([...options.messages])
        events.push(`request ${calls.length}`)
        runningAtRequest.push(background?.tasks.activeBackgroundCommands().map((command) => command.id) ?? [])
        yield { kind: "text_delta", text: "answer", blockKey: "b0" } as const
        if ((background?.tasks.awaitedTaskCount() ?? 0) > 0) {
          expect(options.tools.some((tool) => tool.name === "process")).toBe(true)
          yield { kind: "tool_use", toolCall: { id: `wait-${calls.length}`, name: "process", input: { action: "wait", soft_timeout: 7200 } } } as const
          yield { kind: "done", stopReason: "tool_use" } as const
        } else {
          yield { kind: "done", stopReason: "end_turn" } as const
        }
      },
    })
    const deps = createTestChatSessionDeps({
      sessionId,
      conversationId,
      eventBus,
      commandHandover: authority,
      createAgent: (options) => {
        background = options.runtimeSurfaces?.background
        return newTestRunner(options, createClient)
      },
    })

    session = createChatSession({ onError: () => {}, onEnded: () => {} }, deps)
    expect(await session.send("keep the dev server running")).toBe("accepted")
    await parks[0]?.promise

    // The command was this chat's before its first request, which parked on it.
    expect(events).toEqual(["adopt", "request 1"])
    expect(runningAtRequest[0]).toEqual([row.processId])
    expect(store.readInFlight(sessionId, COMMAND_HANDOVER_IN_FLIGHT_KIND)).toEqual([])

    container.end(0)
    await parks[1]?.promise

    expect(calls).toHaveLength(2)
    const delivered = JSON.stringify(calls[1]).split("fixture-command-finished").length - 1
    expect(delivered).toBe(1)
    expect(JSON.stringify(calls[1])).toContain("exited with code 0")
    store.close()
  })

  // A command's completion is keyed, so a second delivery of one the
  // conversation committed, from a stray hold or a repeat, adds nothing.
  it("commits a command's completion once: a repeat of one its conversation committed retires its hold and starts no turn", async () => {
    const dir = temporary("chat-command-repeat-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
    const writer = asAsyncEventWriter(store)
    const sessionId = "chat-repeat"
    const conversationId = `conversation-${sessionId}`
    let requests = 0
    const parked = Promise.withResolvers<void>()
    const eventBus = new EventBus()
    eventBus.subscribeToType("agent.turn.parked", () => { parked.resolve() })
    const createClient = async () => asModelClient({
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools() {
        requests += 1
        yield { kind: "text_delta", text: "The build finished.", blockKey: "b0" } as const
        yield { kind: "done", stopReason: "end_turn" } as const
      },
    })
    const base = createTestChatSessionDeps({ sessionId, createAgent: (options) => newTestRunner(options, createClient) })
    session = createChatSession({ onError: () => {}, onEnded: () => {} }, {
      ...base,
      conversationId,
      eventBus,
      infra: { ...base.infra, eventStore: asAsyncEventReadSurface(store) },
      treeWriter: createConversationTreeWriterController({ conversationId, sessionId, projectRoot: dir, store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer }),
    })
    const completion = { key: "command:bash-bg-1", text: "<background_command_notification>exited with code 0</background_command_notification>" }

    expect(await session.deliverBackgroundNotification(completion)).toBe(true)
    await parked.promise
    expect(requests).toBe(1)

    // A stray hold of the same completion, as a second publisher would leave.
    store.putInFlight(sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND, completion.key, { conversationId, text: completion.text })
    expect(await session.deliverBackgroundNotification(completion)).toBe(true)
    await Bun.sleep(20)

    expect(requests).toBe(1)
    expect(store.readInFlight(sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([])
    expect(store.read({ aggregateId: `conversation:${conversationId}`, types: ["chat.entries.appended"] })
      .flatMap((fact) => (Array.isArray(fact.payload.entries) ? fact.payload.entries : []))
      .filter((entry) => typeof entry === "object" && entry !== null && "id" in entry && entry.id === completion.key)).toHaveLength(1)
    store.close()
  })

  // The successor attaches the chat and adopts its command before it resumes
  // the turn the replacement cut, so the command can end, and its completion
  // commit, just as the Resume arrives.
  it("runs the turn a Resume authorizes that arrives while a command's completion commits to the turn the replacement cut", async () => {
    const dir = temporary("chat-command-resume-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
    const writer = asAsyncEventWriter(store)
    const sessionId = "chat-resume"
    const conversationId = `conversation-${sessionId}`
    const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer })
    await tree.appendMessage({ kind: "user", content: "keep the dev server running", origin: "human" })
    const cut = interruptedTurnEnd("replacement")
    await tree.appendMessage({ kind: "user", content: interruptedTurnMessage(cut.pausedBy, false), origin: "system" }, turnEndEntryId(cut, crypto.randomUUID()))
    tree.getStorage().dispose()
    const calls: ConversationMessage[][] = []
    const createClient = async () => asModelClient({
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools(options: StreamOptions) {
        calls.push([...options.messages])
        yield { kind: "text_delta", text: "The server is up.", blockKey: "b0" } as const
        yield { kind: "done", stopReason: "end_turn" } as const
      },
    })
    const treeWriter = createConversationTreeWriterController({ conversationId, sessionId, projectRoot: dir, store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer })
    const committing = Promise.withResolvers<void>()
    const commit = Promise.withResolvers<void>()
    const base = createTestChatSessionDeps({ sessionId, createAgent: (options) => newTestRunner(options, createClient) })
    session = createChatSession({ onError: () => {}, onEnded: () => {} }, {
      ...base,
      conversationId,
      infra: { ...base.infra, eventStore: asAsyncEventReadSurface(store) },
      treeWriter: {
        ...treeWriter,
        async commitBackgroundNotification(notification) {
          committing.resolve()
          await commit.promise
          return await treeWriter.commitBackgroundNotification(notification)
        },
      },
    })
    const completion = { key: "command:bash-bg-1", text: "<background_command_notification>fixture-command-finished, exited with code 0</background_command_notification>" }

    const delivered = session.deliverBackgroundNotification(completion)
    await committing.promise
    expect(session.resume({ announce: false })).toBe(true)
    commit.resolve()
    expect(await delivered).toBe(true)
    for (let wait = 0; wait < 50 && calls.length === 0; wait += 1) await Bun.sleep(10)

    // One request continues the cut turn and reads the completion once.
    expect(calls).toHaveLength(1)
    expect(JSON.stringify(calls[0]).split("fixture-command-finished").length - 1).toBe(1)
    expect(JSON.stringify(calls[0])).toContain(CONTINUATION_MESSAGES.resumed)
    store.close()
  })

  // On the successor, the adopted command's own completion and the drain of
  // held notices that the continuation runs can both deliver one completion.
  // The second delivery arrives while the first commits to the cut turn.
  it("commits a command's completion once when a second delivery arrives while the first commits", async () => {
    const dir = temporary("chat-command-concurrent-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
    const writer = asAsyncEventWriter(store)
    const sessionId = "chat-concurrent"
    const conversationId = `conversation-${sessionId}`
    const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer })
    await tree.appendMessage({ kind: "user", content: "keep the dev server running", origin: "human" })
    const cut = interruptedTurnEnd("replacement")
    await tree.appendMessage({ kind: "user", content: interruptedTurnMessage(cut.pausedBy, false), origin: "system" }, turnEndEntryId(cut, crypto.randomUUID()))
    tree.getStorage().dispose()
    const calls: ConversationMessage[][] = []
    const createClient = async () => asModelClient({
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools(options: StreamOptions) {
        calls.push([...options.messages])
        yield { kind: "text_delta", text: "The server is up.", blockKey: "b0" } as const
        yield { kind: "done", stopReason: "end_turn" } as const
      },
    })
    const treeWriter = createConversationTreeWriterController({ conversationId, sessionId, projectRoot: dir, store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer })
    const committing = Promise.withResolvers<void>()
    const commit = Promise.withResolvers<void>()
    const base = createTestChatSessionDeps({ sessionId, createAgent: (options) => newTestRunner(options, createClient) })
    session = createChatSession({ onError: () => {}, onEnded: () => {} }, {
      ...base,
      conversationId,
      infra: { ...base.infra, eventStore: asAsyncEventReadSurface(store) },
      treeWriter: {
        ...treeWriter,
        async commitBackgroundNotification(notification) {
          committing.resolve()
          await commit.promise
          return await treeWriter.commitBackgroundNotification(notification)
        },
      },
    })
    const completion = { key: "command:bash-bg-1", text: "<background_command_notification>fixture-command-finished, exited with code 0</background_command_notification>" }

    const first = session.deliverBackgroundNotification(completion)
    await committing.promise
    const second = session.deliverBackgroundNotification(completion)
    commit.resolve()
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(session.resume({ announce: false })).toBe(true)
    for (let wait = 0; wait < 50 && calls.length === 0; wait += 1) await Bun.sleep(10)
    await Bun.sleep(50)

    // One request continues the cut turn, reads the completion once, and the
    // conversation holds one entry for it.
    expect(calls).toHaveLength(1)
    expect(JSON.stringify(calls[0]).split("fixture-command-finished").length - 1).toBe(1)
    expect(store.read({ aggregateId: `conversation:${conversationId}`, types: ["chat.entries.appended"] })
      .flatMap((fact) => (Array.isArray(fact.payload.entries) ? fact.payload.entries : []))
      .filter((entry) => JSON.stringify(entry).includes("fixture-command-finished"))).toHaveLength(1)
    store.close()
  })
})

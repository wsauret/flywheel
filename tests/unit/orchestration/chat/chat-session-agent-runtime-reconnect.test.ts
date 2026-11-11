import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { AnyBlock } from "../../../../src/infra/output-blocks"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { asAsyncEventReadSurface, asAsyncEventWriter, PersistenceWriteRefused } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createChatSession } from "../../../../src/orchestration/chat/session"
import type { ChatRunner } from "../../../../src/orchestration/chat/runner-types"
import type { ChatCallbacks } from "../../../../src/orchestration/chat/types"
import type { LiveAgent } from "../../../../src/orchestration/agent-runtime/runner"
import { newTestRunner } from "../../../helpers/agent-runner.js"
import type { AgentRunResult, Agent, AgentOptions } from "../../../../src/orchestration/agent-runtime/types"
import type { BackgroundExecutionOwner } from "../../../../src/orchestration/agent-runtime/background-execution-owner"
import { FUNCTION_TOOL_PRESENTATION, type LLMClient, type StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types"
import { chain, fakeAvailability } from "../agent-runtime/llm/_provider-chain-harness"
import { LlmStreamError, StreamIdleTimeoutError } from "../../../../src/orchestration/agent-runtime/llm/errors"
import { normalizeProviderAttemptFailure } from "../../../../src/orchestration/agent-runtime/llm/provider-failure"
import { CONTINUATION_MESSAGES } from "../../../../src/orchestration/agent-runtime/continuation-messages"
import { createConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer"
import { ConversationTreeStorage } from "../../../../src/orchestration/session/conversation/conversation-tree-storage"
import { forkConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-fork"
import { applySessionNoticeOperation, type SessionNotice } from "../../../../src/infra/session-notice"
import { EventBus } from "../../../../src/infra/event-bus"
import { captureBlocks, createTestChatSessionDeps } from "./_chat-session-agent-runtime-fixtures"
import { ownHistoryTarget } from "../agent-runtime/_model-client.js";

describe("chat session with agent runtime request-owned recovery", () => {
  let session: ChatRunner | null = null

  afterEach(async () => {
    await session?.dispose()
    session = null
  })

  it.each(["terminal", "teardown"] as const)("keeps one local persistence transcript record when %s meets a failed durability end", async (source) => {
    const error = new PersistenceWriteRefused(129, 128, "final-result")
    const detached = Promise.withResolvers<void>()
    let launched = false
    const view = captureBlocks((patch) => {
      if (launched && patch.runnerState === "absent") detached.resolve()
    })
    const deps = createTestChatSessionDeps({
      sessionId: "local-refusal",
      createAgent: () => {
        launched = true
        return { send() {}, abort() {}, end() {}, done: Promise.resolve({ servedRequests: 0,
          durationMs: 0,
          terminal: source === "terminal" ? { kind: "local_persistence_error", error } : { kind: "completed" },
        }) }
      },
      updateEntry: view.updateEntry,
    })
    const endTurn = deps.treeWriter.endTurn
    deps.treeWriter.endTurn = async () => { throw error }
    try {
      session = createChatSession({ onError() {}, onEnded() {} }, deps)
      await session.send("work")
      await detached.promise
      expect(view.blocks().filter((block) => block.kind === "system").map((block) => block.message)).toEqual([
        "Local persistence limit exceeded. Flywheel could not save this operation: its encoded request is 129 bytes; the limit is 128 bytes. The file changes already settled. Their final tool result could not be saved.",
      ])
    } finally {
      deps.treeWriter.endTurn = endTurn
    }
  })

  it("commits a fork's command goal once before its first request and keeps request context private after reconnect", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-chat-fork-command-"))
    const database = resolveEventStoreDbFile(tmpDir)
    let store = createSqliteEventStore(database)
    const source = createConversationTreeWriterController({
      projectRoot: tmpDir, sessionId: "source", conversationId: "source", store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store),
    })
    const privateContext = "Private loop instructions for this request only."
    const goal = { text: "Start the experiment loop.", invocation: { label: "/experiment start" } }
    const requests: Array<{ messages: StreamOptions["messages"]; durable: StreamOptions["messages"] }> = []
    const firstRequest = Promise.withResolvers<void>()
    const secondRequest = Promise.withResolvers<void>()
    const startupFailure = Promise.withResolvers<void>()
    const createTree = () => createConversationTreeWriterController({
      projectRoot: tmpDir, sessionId: "fork", conversationId: "fork", store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store),
    })
    const reader = createTree()
    const createClient = async () => {
      const adapter: LLMClient = { historyTarget: ownHistoryTarget,
        accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test",
        contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false,
        toolPresentation: FUNCTION_TOOL_PRESENTATION,
        priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
        async *streamWithTools(options) {
          const durableReader = createTree()
          try {
            requests.push({
              messages: structuredClone(options.messages),
              durable: await durableReader.captureCommittedForkMessages(),
            })
          } finally {
            await durableReader.dispose()
          }
          if (requests.length === 1) firstRequest.resolve()
          else secondRequest.resolve()
          yield { kind: "text_delta", text: "Charter response.", blockKey: "b0" } as const
          yield { kind: "done", stopReason: "end_turn" } as const
        },
      }
      return chain({ availability: fakeAvailability({}).availability, build: async () => adapter })
    }
    const openSession = () => {
      const treeWriter = createTree()
      const buildContext = treeWriter.buildContext
      treeWriter.buildContext = async (options) => {
        try { return await buildContext(options) }
        catch (error) { startupFailure.resolve(); throw error }
      }
      return createChatSession({ onError() {}, onEnded() {} }, createTestChatSessionDeps({
        sessionId: "fork", conversationId: "fork", projectRoot: tmpDir, executionCwd: tmpDir, hasPriorBlocks: true,
        treeWriter, createAgent: (options) => newTestRunner(options, createClient),
      }))
    }
    try {
      await source.commitUserTurn("parent request")
      source.beginTurn()
      await source.recordCanonicalMessage({ kind: "assistant", content: [{ type: "text", text: "parent settled reply" }] })
      await source.endTurn()
      const storage = await ConversationTreeStorage.open({
        sessionId: "source", conversationId: "source", store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store),
      })
      const branch = await storage.captureCommittedActiveBranch()
      storage.dispose()
      await forkConversationTree({ source: branch, destinationSessionId: "fork", destinationConversationId: "fork", store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
      const prefix = await reader.captureCommittedForkMessages()
      session = openSession()
      expect(session.requestWithContext(goal, privateContext)).toBe(true)
      await Promise.race([firstRequest.promise, startupFailure.promise])
      expect(requests).toHaveLength(1)
      await session.awaitLogicalTurnDurability()
      expect(requests[0]?.messages.slice(0, 2)).toEqual(prefix)
      expect(requests[0]?.durable).toEqual([
        ...prefix,
        { kind: "user", content: goal.text, invocation: goal.invocation, origin: "human" },
      ])
      expect(requests[0]?.messages.filter((message) => message.kind === "user" && message.invocation)).toHaveLength(1)
      expect(JSON.stringify(requests[0]?.messages)).toContain(privateContext)
      expect(JSON.stringify(requests[0]?.durable)).not.toContain(privateContext)
      await session.dispose()
      session = null
      await reader.dispose()
      await source.dispose()
      store.close()
      store = createSqliteEventStore(database)

      session = openSession()
      await session.send("continue the loop")
      await secondRequest.promise
      await session.awaitLogicalTurnDurability()
      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.slice(0, 2)).toEqual(prefix)
      expect(requests[1]?.durable.filter((message) => message.kind === "user" && message.invocation)).toEqual([
        { kind: "user", content: goal.text, invocation: goal.invocation, origin: "human" },
      ])
      expect(JSON.stringify(requests[1]?.messages)).not.toContain(privateContext)
      expect(JSON.stringify(requests[1]?.durable)).not.toContain(privateContext)
    } finally {
      await session?.dispose()
      session = null
      await reader.dispose()
      await source.dispose()
      store.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("keeps request-owned provider fallback inside one runner", async () => {
    const streamCalls: number[] = []
    const connectionStates: string[] = []
    const noticeTitles: string[] = []
    const noticeSnapshots: string[][] = []
    let notices: readonly SessionNotice[] = []
    let runner: LiveAgent | null = null
    let runnerCount = 0
    let releaseSecondStream = (): void => {}
    const secondStreamRelease = new Promise<void>((resolve) => { releaseSecondStream = resolve })
    const fallbackStreamEntered = Promise.withResolvers<void>()
    const fallbackRendered = Promise.withResolvers<void>()
    const fallbackParked = Promise.withResolvers<void>()
    const eventBus = new EventBus()
    eventBus.subscribeToType("agent.turn.parked", () => { fallbackParked.resolve() })

    const createClient = async () => {
      const adapter: LLMClient = { historyTarget: ownHistoryTarget,
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      toolPresentation: FUNCTION_TOOL_PRESENTATION,
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools(_: StreamOptions) {
        const idx = streamCalls.length
        streamCalls.push(idx)
        if (idx === 1) fallbackStreamEntered.resolve()
        if (idx === 0) {
          // The first provider attempt fails inside the admitted request.
          throw normalizeProviderAttemptFailure(new LlmStreamError("idle timeout", "transient"))
        }
        // The fallback attempt completes inside the same runner.
        yield { kind: "text_delta", text: "back online", blockKey: "b0" } as const
        await secondStreamRelease
        yield { kind: "done", stopReason: "end_turn" } as const
      },
      }
      return chain({ availability: fakeAvailability({}).availability, build: async () => adapter })
    }

    const createAgent = (options: AgentOptions): Agent => {
        runnerCount++
        runner = newTestRunner(options, createClient)
        return runner
    }

    const callbacks: ChatCallbacks = {
      onError: () => {},
      onEnded: () => {},
    }

    const blockView = captureBlocks((patch) => {
      if (patch.outputBlocks?.some((block) => block.kind === "text" && block.content.includes("back online"))) {
        fallbackRendered.resolve()
      }
      if (patch.connectionState) connectionStates.push(patch.connectionState)
      if (patch.noticeOperation) {
        // Mirror the store patcher's fold: the adapter forwards operations,
        // the entry owner materializes the notice list.
        notices = applySessionNoticeOperation(notices, patch.noticeOperation.operation, patch.noticeOperation.timestamp)
        const titles = notices.map((notice) => notice.title)
        noticeTitles.push(...titles)
        noticeSnapshots.push(titles)
      }
    })
    session = await createChatSession(callbacks, createTestChatSessionDeps({
      sessionId: "chat-reconnect-test",
      createAgent,
      eventBus,
      updateEntry: blockView.updateEntry,
    }))

    void session.send("kick off")

    await fallbackStreamEntered.promise
    expect(runnerCount).toBe(1)

    await fallbackRendered.promise

    // The first provider attempt failed; the fallback attempt succeeded.
    expect(streamCalls).toEqual([0, 1])

    // Request-owned fallback does not change the session connection state.
    expect(connectionStates).not.toContain("reconnecting")
    expect(noticeSnapshots).toContainEqual([])
    releaseSecondStream()
    await fallbackParked.promise

    // Provider fallback adds no session reconnect notice or transcript row.
    expect(noticeTitles).not.toContain("Connection lost")
    const blocks = blockView.blocks()
    const reconnectMsg = blocks.find(
      (b): b is Extract<AnyBlock, { kind: "system" }> =>
        b.kind === "system" && b.message.includes("Connection lost"),
    )
    expect(reconnectMsg).toBeUndefined()

    void runner
  })

  it("replays the stable user turn without exposing an incomplete stream fragment", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-chat-retry-tree-"))
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const requestMessages: StreamOptions["messages"][] = []
    const treeFailures: unknown[] = []
    const replayStreamEntered = Promise.withResolvers<void>()

    const createClient = async () => {
      const adapter: LLMClient = { historyTarget: ownHistoryTarget,
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      toolPresentation: FUNCTION_TOOL_PRESENTATION,
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools(options: StreamOptions) {
        // Snapshot: the loop owns and mutates this array across turns.
        requestMessages.push([...options.messages])
        if (requestMessages.length === 2) replayStreamEntered.resolve()
        if (requestMessages.length === 1) {
          yield { kind: "text_delta", text: "partial", blockKey: "b0" } as const
          yield { kind: "tool_use", toolCall: { id: "tool_a", name: "search", input: { pattern: "alpha" } } } as const
          throw normalizeProviderAttemptFailure(new LlmStreamError("overloaded", "overload"))
        }
        yield { kind: "text_delta", text: "resumed", blockKey: "b0" } as const
        yield { kind: "done", stopReason: "end_turn" } as const
      },
      }
      return chain({ availability: fakeAvailability({}).availability, build: async () => adapter })
    }

    try {
      session = await createChatSession({ onError: () => {}, onEnded: () => {} }, createTestChatSessionDeps({
        sessionId: "chat-retry-tree-context-test",
        createAgent: (options) => newTestRunner(options, createClient),
        projectRoot: tmpDir,
        executionCwd: tmpDir,
        treeWriter: createConversationTreeWriterController({
          conversationId: "conv-chat-retry-tree-context-test",
          sessionId: "chat-retry-tree-context-test",
          projectRoot: tmpDir,
          store: asAsyncEventReadSurface(store),
          projectionReader: asAsyncEventReadSurface(store),
          writer: asAsyncEventWriter(store),
        }),
        onTreeFailure: (err) => { treeFailures.push(err) },
      }))

      void session.send("start")
      await replayStreamEntered.promise

      expect(treeFailures).toEqual([])
      expect(requestMessages.length).toBeGreaterThanOrEqual(2)
      const retryMessages = requestMessages[1]!
      expect(retryMessages.map((message) => message.kind)).toEqual(["user", "assistant", "toolResult"])
      expect(JSON.stringify(retryMessages)).not.toContain("previous response")
      expect(JSON.stringify(retryMessages)).not.toContain("conversationHistoryGap")
      const partial = retryMessages[1]
      expect(partial?.kind).toBe("assistant")
      if (partial?.kind !== "assistant") throw new Error("expected partial assistant message")
      expect(partial.incomplete).toBe(true)
      expect(Array.isArray(partial.content)).toBe(true)
      if (!Array.isArray(partial.content)) throw new Error("expected partial assistant blocks")
      expect(partial.content.map((block) => block.type)).toEqual(["text", "tool_use"])
      expect(retryMessages[2]).toMatchObject({ kind: "toolResult", toolUseId: "tool_a" })
    } finally {
      await session?.dispose()
      session = null
      store.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("guides only the retry generation after a request-owned stall", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-chat-stall-recovery-"))
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const requestMessages: StreamOptions["messages"][] = []
    const recoveryStreamEntered = Promise.withResolvers<void>()
    const recoveryRendered = Promise.withResolvers<void>()
    const recoveryDirective = CONTINUATION_MESSAGES.stream_stalled
    const treeWriter = createConversationTreeWriterController({
      conversationId: "conv-chat-stall-recovery-test",
      sessionId: "chat-stall-recovery-test",
      projectRoot: tmpDir,
      store: asAsyncEventReadSurface(store),
      projectionReader: asAsyncEventReadSurface(store),
      writer: asAsyncEventWriter(store),
    })
    const connectionStates: string[] = []
    let notices: readonly SessionNotice[] = []
    const blockView = captureBlocks((patch) => {
      if (patch.outputBlocks?.some((block) => block.kind === "text" && block.content.includes("recovered"))) {
        recoveryRendered.resolve()
      }
      if (patch.connectionState) connectionStates.push(patch.connectionState)
      if (patch.noticeOperation) {
        notices = applySessionNoticeOperation(notices, patch.noticeOperation.operation, patch.noticeOperation.timestamp)
      }
    })
    const createClient = async () => {
      const adapter: LLMClient = { historyTarget: ownHistoryTarget,
      accessProvider: "chatgpt",
      modelFamily: "openai",
      model: "test",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      toolPresentation: FUNCTION_TOOL_PRESENTATION,
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools(options: StreamOptions) {
        requestMessages.push([...options.messages])
        const request = requestMessages.length
        if (request === 4) recoveryStreamEntered.resolve()
        if (request === 1) {
          yield { kind: "text_delta", text: "planning a large batch", blockKey: "b0" } as const
          throw normalizeProviderAttemptFailure(new StreamIdleTimeoutError("OpenAI stream idle timeout", "idle"))
        }
        if (request === 2) {
          yield { kind: "text_delta", text: "still planning a large batch", blockKey: "b0" } as const
          throw normalizeProviderAttemptFailure(new StreamIdleTimeoutError("OpenAI stream idle timeout", "idle"))
        }
        if (request === 3) {
          yield { kind: "tool_use", toolCall: { id: "tool_chunk", name: "search", input: { pattern: "split", path: tmpDir } } } as const
          yield { kind: "done", stopReason: "tool_use" } as const
          return
        }
        yield { kind: "text_delta", text: request === 4 ? "recovered" : "later work", blockKey: "b0" } as const
        yield { kind: "done", stopReason: "end_turn" } as const
      },
      }
      return chain({ availability: fakeAvailability({}).availability, build: async () => adapter })
    }

    try {
      session = await createChatSession({ onError: () => {}, onEnded: () => {} }, createTestChatSessionDeps({
        sessionId: "chat-stall-recovery-test",
        createAgent: (options) => newTestRunner(options, createClient),
        projectRoot: tmpDir,
        executionCwd: tmpDir,
        treeWriter,
        updateEntry: blockView.updateEntry,
      }))

      void session.send("start")
      await recoveryStreamEntered.promise
      await recoveryRendered.promise

      expect(requestMessages).toHaveLength(4)
      expect(JSON.stringify(requestMessages[0])).not.toContain(recoveryDirective)
      expect(JSON.stringify(requestMessages[1])).toContain(recoveryDirective)
      expect(JSON.stringify(requestMessages[2])).toContain(recoveryDirective)
      expect(JSON.stringify(requestMessages[2])).toContain("Produce one small sequential batch in this response")
      expect(JSON.stringify(requestMessages[3])).not.toContain(recoveryDirective)
      expect(notices).toEqual([])
      expect(connectionStates).not.toContain("reconnecting")
      const durableContext = await treeWriter.buildContext({ allowAssistantTail: true })
      expect(JSON.stringify(durableContext.messages)).not.toContain(recoveryDirective)

    } finally {
      await session?.dispose()
      session = null
      store.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("requires a user retry after a terminal stall without carrying recovery context", async () => {
    const optionsSeen: AgentOptions[] = []
    let runnerDetached = false
    let background: BackgroundExecutionOwner | undefined
    const blockView = captureBlocks((patch) => {
      if (patch.runnerState === "absent") runnerDetached = true
    })
    const createAgent = (options: AgentOptions): Agent => {
      const index = optionsSeen.length
      optionsSeen.push(options)
      background = options.runtimeSurfaces?.background
      return {
        done: Promise.resolve(index === 0
          ? { servedRequests: 0, durationMs: 1, terminal: { kind: "stream_stalled", message: "idle timeout", attribution: { kind: "unattributed" } } }
          : { servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } }),
        send() {},
        abort() {},
        end() {},
      }
    }

    const backgroundTurns: string[] = []
    const deps = createTestChatSessionDeps({
      sessionId: "chat-stall-terminal-test",
      createAgent,
      updateEntry: blockView.updateEntry,
    })
    const commitBackgroundNotification = deps.treeWriter.commitBackgroundNotification
    deps.treeWriter.commitBackgroundNotification = async (notification) => {
      backgroundTurns.push(notification.text)
      return commitBackgroundNotification(notification)
    }

    try {
      session = await createChatSession({ onError: () => {}, onEnded: () => {} }, deps)

      void session.send("start")
      const stalledDeadline = Date.now() + 3000
      while (Date.now() < stalledDeadline) {
        const surfaced = blockView.blocks().some(
          (block) => block.kind === "system" && block.message.includes("Model response stalled"),
        )
        if (surfaced && runnerDetached) break
        await Bun.sleep(10)
      }
      expect(blockView.blocks()).toContainEqual(expect.objectContaining({
        kind: "system",
        message: expect.stringContaining("Model response stalled"),
      }))
      expect(runnerDetached).toBe(true)

      if (!background) throw new Error("expected session background owner")
      background.tasks.track({
        done: Promise.resolve({ status: "completed", content: "background result" }),
        meta: { id: "task-after-stall", type: "subagent", description: "Late background work" },
      })
      const backgroundDeadline = Date.now() + 3000
      while (backgroundTurns.length < 1 && Date.now() < backgroundDeadline) await Bun.sleep(10)
      expect(backgroundTurns).toHaveLength(1)
      expect(optionsSeen).toHaveLength(1)

      void session.send("retry")
      const resumedDeadline = Date.now() + 3000
      while (optionsSeen.length < 2 && Date.now() < resumedDeadline) await Bun.sleep(10)
      expect(optionsSeen).toHaveLength(2)
      expect(optionsSeen[1]?.requestContext).toBeUndefined()
    } finally {
      await session?.dispose()
      session = null
    }
  })

  it("does not trigger reconnect when a clean runner exit follows a user interrupt + queued send", async () => {
    const callbacks: ChatCallbacks = {
      onError: () => {},
      onEnded: () => {},
    }
    const connectionStates: string[] = []
    const runners: Array<Agent & {
      options: AgentOptions
      resolve: (result: AgentRunResult) => void
      sends: string[]
      interruptCalls: number
    }> = []

    const createAgent = (options: AgentOptions): Agent => {
      const { promise, resolve } = Promise.withResolvers<AgentRunResult>()
      const sends: string[] = []
      const runner = {
        options,
        resolve,
        sends,
        interruptCalls: 0,
        done: promise,
        send(text: string) { sends.push(text) },
        interruptGeneration() { this.interruptCalls++; return true },
        abort() { resolve({ servedRequests: 0, durationMs: 1, providerSessionKey: "agent-test", terminal: { kind: "aborted" } }) },
        end() {},
      }
      runners.push(runner)
      return runner
    }

    const blockView = captureBlocks((patch) => {
      if (patch.connectionState) connectionStates.push(patch.connectionState)
    })
    session = await createChatSession(callbacks, createTestChatSessionDeps({
      sessionId: "chat-interrupt-queued-send-test",
      createAgent,
      initialProviderConversationId: "agent-test",
      updateEntry: blockView.updateEntry,
    }))

    void session.send("hello")
    const spawnDeadline = Date.now() + 200
    while (runners.length < 1 && Date.now() < spawnDeadline) {
      await Bun.sleep(5)
    }
    expect(runners).toHaveLength(1)

    // User interrupts mid-turn, then types a new message before the runner has wound down.
    expect(session.interrupt()).toBe(true)
    expect(runners[0]!.interruptCalls).toBe(1)
    void session.send("no thats terrible.")

    // Runner finishes cleanly with a typed completed terminal — under the old
    // contract this exit was synthesized into transient_disconnect, triggering
    // a spurious reconnect; the typed terminal makes it a finished turn.
    runners[0]!.resolve({ servedRequests: 0, durationMs: 1, providerSessionKey: "agent-test", terminal: { kind: "completed" } })
    await Bun.sleep(20)

    expect(connectionStates).not.toContain("reconnecting")
    // The queued send parked in the mailbox after the loop stopped draining;
    // the teardown respawn consumes it with a fresh runner (no reconnect
    // machinery involved) instead of stranding it.
    expect(runners).toHaveLength(2)
    const reconnectMsg = blockView.blocks().find(
      (b): b is Extract<AnyBlock, { kind: "system" }> =>
        b.kind === "system" && b.message.includes("Connection lost"),
    )
    expect(reconnectMsg).toBeUndefined()
  })
})

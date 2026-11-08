import { afterEach, describe, expect, it } from "bun:test"
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types"
import type { AnyBlock } from "../../../../src/infra/output-blocks"
import { EventBus } from "../../../../src/infra/event-bus"
import { createChatSession } from "../../../../src/orchestration/chat/session"
import type { ChatRunner } from "../../../../src/orchestration/chat/runner-types"
import type { ChatCallbacks } from "../../../../src/orchestration/chat/types"
import type { LiveAgent } from "../../../../src/orchestration/agent-runtime/runner"
import { newTestRunner } from "../../../helpers/agent-runner.js"
import type { ConversationMessage, StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types"
import { asModelClient } from "../agent-runtime/_model-client"
import type { ResolvedRoles } from "../../../../src/orchestration/config/roles"
import type { WorkflowsMode } from "../../../../src/protocol/module-protocol-types.js"
import { captureBlocks, createStoredChatSession, createTestChatSessionDeps } from "./_chat-session-agent-runtime-fixtures"
import { renderSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventWriter } from "../../../../src/infra/event-store-types"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { QUEUED_USER_INPUT_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-user-inputs"
import { temporaryDirectories } from "../../../helpers/directories"
describe("chat session with agent runtime — queued message delivery", () => {
  let session: ChatRunner | null = null

  afterEach(async () => {
    await session?.dispose()
    session = null
  })

  it("delivers a queued chat message after the current tool turn", async () => {
    const calls: ConversationMessage[][] = []
    const events: RuntimeEvent[] = []
    const errors: string[] = []
    // The live view the TUI renders is the SessionStore output mirror (what the
    // output-projection observes and publishes). Capture it straight from the
    // updateEntry mirror -- the same blocks the observer would mint a delta from.
    const liveViews: { blocks: AnyBlock[] }[] = []
    let turnIndex = 0
    let runner: LiveAgent | null = null

    // Gate turn 1's completion on the test enqueuing the follow-up. Without
    // this anchor, turn 1 races to completion before the in-turn `send` can
    // commit + enqueue, and the steering poll between turns misses the
    // queued message.
    let queueFollowUp!: () => void
    const followUpReady = new Promise<void>((resolve) => { queueFollowUp = resolve })

    const createClient = async () => asModelClient({
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      promptNotes: { progress: "", modelNotes: "" },
      priceFor() { return { status: "unavailable" as const, reason: "missing-rate-card" as const } },
      async *streamWithTools(options: StreamOptions) {
        calls.push([...options.messages])
        if (turnIndex++ === 0) {
          await followUpReady
          yield {
            kind: "tool_use",
            toolCall: { id: "noop-1", name: "noop_tool", input: {} },
          } as const
          yield { kind: "done", stopReason: "tool_use" } as const
          return
        }

        yield { kind: "text_delta", text: "handled follow up", blockKey: "b0" } as const
        yield { kind: "done", stopReason: "end_turn" } as const
      },
    })

    const eventBus = new EventBus()
    eventBus.subscribeToType("model.assistant_message.recorded", (event) => {
      events.push({ type: event.type, data: event.data })
    })
    eventBus.subscribeToType("model.user_message.recorded", (event) => {
      events.push({ type: event.type, data: event.data })
    })

    const callbacks: ChatCallbacks = {
      onError: (message) => { errors.push(message) },
      onEnded: () => {},
    }

    // The queued send publishes the pending follow-up asynchronously, so the
    // test waits for the patch that carries it rather than for a wall-clock
    // duration that a stalled runner can outlast.
    const pendingFollowUpShown = Promise.withResolvers<Extract<AnyBlock, { kind: "userMessage" }>>()
    const blockView = captureBlocks((patch) => {
      if (!patch.outputBlocks) return
      liveViews.push({ blocks: [...patch.outputBlocks] })
      const pendingFollowUp = patch.outputBlocks.find(
        (block): block is Extract<AnyBlock, { kind: "userMessage" }> =>
          block.kind === "userMessage" && block.content === "follow up" && block.pending,
      )
      if (pendingFollowUp) pendingFollowUpShown.resolve(pendingFollowUp)
    })
    session = await createChatSession(callbacks, createTestChatSessionDeps({
      sessionId: "chat-agent-test",
      createAgent: (options) => {
        runner = newTestRunner(options, createClient)
        return runner
      },
      eventBus,
      updateEntry: blockView.updateEntry,
    }))

    // First send drives the worker spawn now that creation is deferred.
    void session.send("initial instruction")

    // Wait until the first stream call has been recorded — turn 1 is now
    // blocked on `followUpReady`, so we can safely commit + enqueue the
    // follow-up and know it will land before the steering poll.
    const streamDeadline = Date.now() + 500
    while (calls.length === 0 && Date.now() < streamDeadline) {
      await Bun.sleep(2)
    }

    const liveRunner = runner
    expect(liveRunner).not.toBeNull()

    const liveViewCountBeforeFollowUp = liveViews.length
    void session.send("follow up")

    const pendingLiveBlock = await pendingFollowUpShown.promise
    expect(pendingLiveBlock).toMatchObject({ pending: true, injected: false })
    expect(liveViews.length).toBeGreaterThan(liveViewCountBeforeFollowUp)
    await session.send("second follow up")

    // Wait one event-loop tick so `commitUserTurn` and `enqueueInput` have
    // both run before we release turn 1's mock stream.
    await Bun.sleep(5)
    queueFollowUp()

    const deadline = Date.now() + 500
    while (Date.now() < deadline) {
      const handledFollowUp = blockView.blocks().some(
        (block) => block.kind === "text" && block.content.includes("handled follow up"),
      )
      if (calls.length >= 2 && handledFollowUp) break
      await Bun.sleep(5)
    }
    await Promise.resolve()
    expect(errors).toEqual([])
    expect(calls).toHaveLength(2)
    // Steering poll picks up the queued follow-up before the tool turn stream.
    // The follow-up appears as a user message in the second stream call alongside
    // the original instruction (both before the tool results).
    const followUpMsg = calls[1]!.find(m => m.kind === "user" && m.content === "follow up")
    expect(followUpMsg).toBeDefined()
    expect(calls[1]?.filter(message => message.kind === "user" && typeof message.content === "string").map(message => message.content))
      .toEqual(["initial instruction", "follow up", "second follow up"])

    const echoedUser = events.find((event) => {
      if (event.type !== "model.user_message.recorded") return false
      const content = event.data.message?.content
      return Array.isArray(content) && content.some((item) => item.type === "text" && item.text === "follow up")
    })
    expect(echoedUser).toBeDefined()

    const blocks = blockView.blocks()
    const userBlock = blocks.find(
      (block): block is Extract<AnyBlock, { kind: "userMessage" }> =>
        block.kind === "userMessage" && block.content === "follow up",
    )
    expect(userBlock).toBeDefined()
    expect(userBlock!.pending).toBe(false)

    const textBlock = blocks.find(
      (block): block is Extract<AnyBlock, { kind: "text" }> =>
        block.kind === "text" && block.content.includes("handled follow up"),
    )
    expect(textBlock).toBeDefined()
  })

  it("shows active compact requests as queued", async () => {
    const calls: ConversationMessage[][] = []
    let releaseTurn!: () => void
    const turnReleased = new Promise<void>((resolve) => { releaseTurn = resolve })

    const createClient = async () => asModelClient({
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      promptNotes: { progress: "", modelNotes: "" },
      priceFor() { return { status: "unavailable" as const, reason: "missing-rate-card" as const } },
      async *streamWithTools(options: StreamOptions) {
        calls.push([...options.messages])
        await turnReleased
        if (options.signal?.aborted) return
        yield { kind: "text_delta", text: "done", blockKey: "b0" } as const
        yield { kind: "done", stopReason: "end_turn" } as const
      },
    })

    const callbacks: ChatCallbacks = {
      onError: () => {},
      onEnded: () => {},
    }

    const blockView = captureBlocks()
    session = await createChatSession(callbacks, createTestChatSessionDeps({
      sessionId: "chat-active-compact-visible",
      createAgent: (options) => newTestRunner(options, createClient),
      updateEntry: blockView.updateEntry,
    }))

    void session.send("initial instruction")

    const deadline = Date.now() + 500
    while (calls.length === 0 && Date.now() < deadline) {
      await Bun.sleep(2)
    }

    expect(await session.compact()).toBe(true)

    const queuedMarker = blockView.blocks().find(
      (block): block is Extract<AnyBlock, { kind: "system" }> =>
        block.kind === "system" && block.message.includes("Queued /compact"),
    )
    expect(queuedMarker).toBeDefined()
    const compactUserBlock = blockView.blocks().find(
      (block): block is Extract<AnyBlock, { kind: "userMessage" }> =>
        block.kind === "userMessage" && block.content.includes("/compact"),
    )
    expect(compactUserBlock).toBeUndefined()

    releaseTurn()
  })

  it("starts idle compaction through the normal runner host", async () => {
    let runnerStarts = 0
    const treeWriter = createTestChatSessionDeps({
      sessionId: "unused",
      createAgent: () => { throw new Error("unused") },
    }).treeWriter
    await treeWriter.commitUserTurn("completed request")
    treeWriter.beginTurn()
    treeWriter.recordCanonicalMessage({ kind: "assistant", content: "completed response" })
    await treeWriter.endTurn()

    const createClient = async () => asModelClient({
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      promptNotes: { progress: "", modelNotes: "" },
      priceFor() { return { status: "unavailable" as const, reason: "missing-rate-card" as const } },
      async *streamWithTools() {
        yield { kind: "text_delta", text: "checkpoint", blockKey: "b0" } as const
        yield { kind: "done", stopReason: "end_turn" } as const
      },
    })

    session = await createChatSession({ onError: () => {}, onEnded: () => {} }, createTestChatSessionDeps({
      sessionId: "chat-idle-compact-normal-host",
      treeWriter,
      hasPriorBlocks: true,
      createAgent: (options) => {
        runnerStarts += 1
        return newTestRunner(options, createClient)
      },
    }))

    expect(await session.compact()).toBe(true)
    const deadline = Date.now() + 500
    while (Date.now() < deadline) {
      if (runnerStarts > 0) break
      await Bun.sleep(2)
    }
    expect(runnerStarts).toBe(1)
  })

  it("starts compaction immediately without a queued marker when the runner is parked", async () => {
    // Regression: compact() used `state.runner !== null` as "mid-turn", but a
    // parked runner (waiting for the next user message) also keeps the runner
    // attached. enqueueCompact wakes the parked loop immediately, so the
    // "Queued /compact" message was a lie in that case.
    const createClient = async () => asModelClient({
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      promptNotes: { progress: "", modelNotes: "" },
      priceFor() { return { status: "unavailable" as const, reason: "missing-rate-card" as const } },
      async *streamWithTools(options: StreamOptions) {
        if (options.signal?.aborted) return
        yield { kind: "text_delta", text: "done", blockKey: "b0" } as const
        yield { kind: "done", stopReason: "end_turn" } as const
      },
    })

    const callbacks: ChatCallbacks = {
      onError: () => {},
      onEnded: () => {},
    }

    const eventBus = new EventBus()
    const parked = Promise.withResolvers<void>()
    const compactionStarted = Promise.withResolvers<void>()
    eventBus.subscribeToType("agent.turn.parked", () => { parked.resolve() })
    eventBus.subscribeToType("agent.compaction.started", (event) => {
      if (event.type === "agent.compaction.started") compactionStarted.resolve()
    })

    const blockView = captureBlocks()
    session = await createChatSession(callbacks, createTestChatSessionDeps({
      sessionId: "chat-parked-compact-immediate",
      createAgent: (options) => newTestRunner(options, createClient),
      eventBus,
      updateEntry: blockView.updateEntry,
    }))

    void session.send("initial instruction")

    // agent.turn.parked fires right before the loop parks; the mailbox waiter
    // installs synchronously in the same frame, so once the event is observed
    // the mailbox is already parked.
    await parked.promise

    expect(await session.compact()).toBe(true)

    const queuedMarker = blockView.blocks().find(
      (block): block is Extract<AnyBlock, { kind: "system" }> =>
        block.kind === "system" && block.message.includes("Queued /compact"),
    )
    expect(queuedMarker).toBeUndefined()

    // The parked loop woke and began compaction without waiting for input.
    await compactionStarted.promise
  })

  it("uses a changed assignment on the next request without replacing the runner", async () => {
    const calls: Array<{ model: string; messages: ConversationMessage[]; effort: string | undefined }> = []
    const runnerModels: Array<string | undefined> = []
    const secondStreamEntered = Promise.withResolvers<void>()
    const rolesFor = (model: string): ResolvedRoles => new Map([
      ["chat", { roleId: "chat", model, effort: "high" }],
    ])
    let roleModel = "model-a"
    let roles = rolesFor(roleModel)

    const createClient = (model: string) => asModelClient({
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model,
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: true,
      promptNotes: { progress: "", modelNotes: "" },
      priceFor() { return { status: "unavailable" as const, reason: "missing-rate-card" as const } },
      async *streamWithTools(options: StreamOptions) {
        calls.push({ model, messages: [...options.messages], effort: options.reasoningEffort })
        if (calls.length === 2) secondStreamEntered.resolve()
        if (options.signal?.aborted) return
        yield { kind: "text_delta", text: `answer from ${model}`, blockKey: "b0" } as const
        yield { kind: "done", stopReason: "end_turn" } as const
      },
    })

    const eventBus = new EventBus()
    let parkedCount = 0
    const firstParked = Promise.withResolvers<void>()
    eventBus.subscribeToType("agent.turn.parked", () => {
      parkedCount += 1
      if (parkedCount === 1) firstParked.resolve()
    })

    const callbacks: ChatCallbacks = {
      onError: () => {},
      onEnded: () => {},
    }

    session = await createChatSession(callbacks, createTestChatSessionDeps({
      sessionId: "chat-model-switch-retained",
      eventBus,
      resolveRoles: async () => roles,
      createAgent: (options) => {
        runnerModels.push(options.model)
        return newTestRunner(options, async (model) => createClient(model))
      },
    }))

    void session.send("first")
    await firstParked.promise
    expect(parkedCount).toBeGreaterThan(0)

    roleModel = "model-b"
    roles = rolesFor(roleModel)
    void session.send("second")
    await secondStreamEntered.promise

    expect(runnerModels).toEqual(["model-a"])
    const secondCall = calls.at(1)
    expect(secondCall?.model).toBe("model-b")
    expect(secondCall?.effort).toBe("high")
    expect(secondCall?.messages.some((m) => m.kind === "user" && m.content === "second")).toBe(true)
  })

  it("delivers the first user message exactly once on a fresh-runner turn", async () => {
    // Regression: submit used to call mailbox.enqueueNextTurn AND startTurn
    // when no runner existed. The runner's buildContext already contained the
    // committed user turn from chat-controls.send, so the loop's first
    // drainPending re-pushed the same text — the model saw the first message
    // twice. Branch-not-both: when no runner, startTurn alone delivers via
    // priorMessages; when a runner is parked, enqueue alone delivers via
    // drainPending. The mailbox and tree never both carry the same turn.
    const calls: ConversationMessage[][] = []

    const createClient = async () => asModelClient({
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      promptNotes: { progress: "", modelNotes: "" },
      priceFor() { return { status: "unavailable" as const, reason: "missing-rate-card" as const } },
      async *streamWithTools(options: StreamOptions) {
        calls.push([...options.messages])
        yield { kind: "text_delta", text: "answer", blockKey: "b0" } as const
        yield { kind: "done", stopReason: "end_turn" } as const
      },
    })

    const callbacks: ChatCallbacks = {
      onError: () => {},
      onEnded: () => {},
    }

    session = await createChatSession(callbacks, createTestChatSessionDeps({
      sessionId: "chat-first-turn-single-delivery",
      createAgent: (options) => newTestRunner(options, createClient),
    }))

    void session.send("hello world")

    const deadline = Date.now() + 500
    while (calls.length === 0 && Date.now() < deadline) {
      await Bun.sleep(2)
    }
    expect(calls).toHaveLength(1)

    const firstCall = calls[0]!
    const userOccurrences = firstCall.filter(
      (m) => m.kind === "user" && String(m.content ?? "").includes("hello world"),
    )
    expect(userOccurrences).toHaveLength(1)
  })
})

describe("chat session queued message recall", () => {
  const temporary = temporaryDirectories()

  it("a recall whose cell retirement fails keeps the message queued, and a recall that succeeds returns the words only after the cell is gone", async () => {
    const projectRoot = temporary("chat-recall-retirement-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const sessionId = "chat-recall"
    const cells = () => store.readInFlight(sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND)
    // The store refuses the retirement, as a spent lock retry budget does.
    let failDrops = true
    const storeWriter = asAsyncEventWriter(store)
    const writer: AsyncEventWriter = {
      ...storeWriter,
      dropInFlight: async (...args) => {
        if (failDrops) throw new Error("database is locked")
        await storeWriter.dropInFlight!(...args)
      },
    }
    const calls: ConversationMessage[][] = []
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const createClient = async () => asModelClient({
      accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test", contextLimit: 100_000, outputLimit: 8_000,
      supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" },
      priceFor() { return { status: "unavailable" as const, reason: "missing-rate-card" as const } },
      async *streamWithTools(options: StreamOptions) {
        calls.push([...options.messages])
        // The first request of each person's turn holds the turn open.
        if (calls.length === 1) await gates[0]!.promise
        if (calls.length === 3) await gates[1]!.promise
        yield { kind: "text_delta", text: "answer", blockKey: "b0" } as const
        yield { kind: "done", stopReason: "end_turn" } as const
      },
    })
    const requests = async (count: number): Promise<void> => {
      const deadline = Date.now() + 3000
      while (calls.length < count && Date.now() < deadline) await Bun.sleep(2)
      expect(calls).toHaveLength(count)
    }
    const mentions = (call: readonly ConversationMessage[] | undefined, text: string): number =>
      (call ?? []).filter((message) => message.kind === "user" && JSON.stringify(message.content).includes(text)).length
    const { chat, parked } = await createStoredChatSession({
      sessionId, conversationId: "conversation-recall", projectRoot,
      reader: asAsyncEventReadSurface(store), writer, seed: async () => {},
      overrides: { createAgent: (options) => newTestRunner(options, createClient) },
    })
    try {
      await chat.send("first request")
      await requests(1)
      expect(await chat.send({ text: "words I take back", submissionIds: ["sub-1"] })).toBe("accepted")
      expect(cells()).toHaveLength(1)

      await expect(Promise.resolve(chat.recallQueuedMessage())).rejects.toThrow("database is locked")
      expect(cells()).toHaveLength(1)
      failDrops = false
      gates[0]!.resolve()
      await parked(1)
      expect(mentions(calls[1], "words I take back")).toBe(1)
      expect(cells()).toEqual([])

      await chat.send("second request")
      await requests(3)
      expect(await chat.send({ text: "take this back too", submissionIds: ["sub-2"] })).toBe("accepted")
      expect(cells()).toHaveLength(1)
      const recalled = await Promise.resolve(chat.recallQueuedMessage()).then((input) => ({ input, cells: cells() }))
      expect(recalled).toEqual({ input: { text: "take this back too", submissionIds: ["sub-2"] }, cells: [] })
      gates[1]!.resolve()
      await parked(2)

      await chat.send("my next message")
      await parked(3)
      expect(mentions(calls.at(-1), "my next message")).toBe(1)
      expect(calls.map((call) => mentions(call, "take this back too"))).toEqual(calls.map(() => 0))
    } finally {
      for (const gate of gates) gate.resolve()
      await chat.dispose()
      store.close()
    }
  })
})

describe("chat session workflow confirmation prompt", () => {
  it("updates the next request on the same active runner", async () => {
    const systemPrompts: string[] = []
    const releases: Array<() => void> = []
    let workflowMode: WorkflowsMode = "ask"
    const createClient = async () => asModelClient({
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      promptNotes: { progress: "", modelNotes: "" },
      priceFor() { return { status: "unavailable" as const, reason: "missing-rate-card" as const } },
      async *streamWithTools(options: StreamOptions) {
        systemPrompts.push(renderSystemPrompt(options.systemPrompt))
        await new Promise<void>((resolve) => { releases.push(resolve) })
        yield { kind: "text_delta", text: "done", blockKey: "b0" } as const
        yield { kind: "done", stopReason: "end_turn" } as const
      },
    })
    const session = await createChatSession({ onError: () => {}, onEnded: () => {} }, createTestChatSessionDeps({
      sessionId: "chat-live-workflow-confirmation",
      workflowMode: () => workflowMode,
      startWorkflow: async () => ({ error: "unused in this test" }),
      createAgent: (options) => newTestRunner(options, createClient),
    }))
    const waitForRequests = async (count: number): Promise<void> => {
      const deadline = Date.now() + 500
      while (systemPrompts.length < count && Date.now() < deadline) await Bun.sleep(2)
      expect(systemPrompts).toHaveLength(count)
    }

    try {
      void session.send("first")
      await waitForRequests(1)
      expect(systemPrompts[0]).toContain("Workflows needs the user's typed approval for every launch you start")

      workflowMode = "on"
      void session.send("second")
      releases[0]?.()
      await waitForRequests(2)
      expect(systemPrompts[1]).not.toContain("Workflows needs the user's typed approval for every launch you start")

      workflowMode = "ask"
      void session.send("third")
      releases[1]?.()
      await waitForRequests(3)
      expect(systemPrompts[2]).toContain("Workflows needs the user's typed approval for every launch you start")
      releases[2]?.()
    } finally {
      for (const release of releases) release()
      await session.dispose()
    }
  })
})

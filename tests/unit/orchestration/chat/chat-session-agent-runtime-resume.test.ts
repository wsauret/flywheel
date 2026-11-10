import { afterEach, describe, expect, it } from "bun:test"
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types"
import type { AnyBlock } from "../../../../src/infra/output-blocks"
import { EventBus } from "../../../../src/infra/event-bus"
import { createChatSession } from "../../../../src/orchestration/chat/session"
import type { ChatRunner } from "../../../../src/orchestration/chat/runner-types"
import type { ChatCallbacks } from "../../../../src/orchestration/chat/types"
import type { LiveAgent } from "../../../../src/orchestration/agent-runtime/runner"
import { newTestRunner } from "../../../helpers/agent-runner.js"
import type { AgentRunResult, Agent, AgentOptions } from "../../../../src/orchestration/agent-runtime/types"
import type { ConversationMessage, StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types"
import { asModelClient } from "../agent-runtime/_model-client"
import type { SessionEntryBasePatch } from "../../../../src/orchestration/session-store/types"
import { appendTurnEnd, captureBlocks, createStoredChatSession, createTestChatSessionDeps, makeMemoryTreeWriter } from "./_chat-session-agent-runtime-fixtures"
import { messageDisposition, type LiveRecipientState } from "../../../../src/orchestration/session/live-session-control"
import type { SessionInputProducer } from "../../../../src/infra/chat-input"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { CONTINUATION_MESSAGES } from "../../../../src/orchestration/agent-runtime/continuation-messages"
import { interruptedTurnEnd, type TurnEnd } from "../../../../src/orchestration/session/conversation/turn-end-record"
import { chatSessionActions, readChatTurnEnd } from "../../../../src/orchestration/session/chat-session-run-evidence"
import { temporaryDirectories } from "../../../helpers/directories"
import type { SessionMessaging } from "../../../../src/orchestration/session/session-messaging"
import type { SessionYield } from "../../../../src/orchestration/session/reply-waits"
import { unusedChildSessionControl } from "../../../helpers/child-session-control.js"

const temporary = temporaryDirectories()

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  const observed = promise.then((value) => ({ settled: true, value }) as const)
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const outcome = await Promise.race([
      observed,
      Bun.sleep(30).then(() => ({ settled: false }) as const),
    ])
    if (outcome.settled) return outcome.value
  }
  throw new Error(message)
}

describe("chat session with agent runtime — interrupt + resume", () => {
  let session: ChatRunner | null = null
  // The stores of stored chats close after their sessions.
  const stores: { close(): void }[] = []
  afterEach(async () => {
    await session?.dispose()
    session = null
    for (const store of stores.splice(0)) store.close()
  })
  it("auto-sends queued message on interrupt and resumes the conversation", async () => {
    const calls: ConversationMessage[][] = []
    const events: RuntimeEvent[] = []
    const errors: string[] = []
    const activityHistory: Array<string | null> = []
    const patches: SessionEntryBasePatch[] = []
    let turnIndex = 0
    let runner: LiveAgent | null = null

    let resolveFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => { resolveFirstStarted = resolve })
    let resolveSecondStarted!: () => void
    const secondStarted = new Promise<void>((resolve) => { resolveSecondStarted = resolve })
    let releaseSecondResponse!: () => void
    const secondResponseReleased = new Promise<void>((resolve) => { releaseSecondResponse = resolve })
    let observePostInterruptWaiting = false
    let resolveWaitingPatch!: () => void
    const waitingPatch = new Promise<void>((resolve) => { resolveWaitingPatch = resolve })
    const responseRendered = Promise.withResolvers<void>()
    // The stream settles in a patch of its own, which can follow the patch that
    // renders the resumed text.
    const streamSettled = Promise.withResolvers<void>()
    let lastPublishedChars = 0
    let phaseSettled = false
    let resumedRendered = false
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
          yield { kind: "provider_response_started" } as const
          yield { kind: "text_delta", text: "thinking…", blockKey: "b0" } as const
          resolveFirstStarted()
          await new Promise<void>((_, reject) => {
            options.signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            )
          })
          return
        }
        yield { kind: "provider_response_started" } as const
        resolveSecondStarted()
        await secondResponseReleased
        yield { kind: "text_delta", text: "answering queued", blockKey: "b0" } as const
        yield { kind: "done", stopReason: "end_turn" } as const
      },
    })

    const eventBus = new EventBus()
    eventBus.subscribeToType("model.assistant_message.recorded", (event) => {
      events.push({ type: event.type, data: event.data })
    })

    const callbacks: ChatCallbacks = {
      onError: (message) => { errors.push(message) },
      onEnded: () => {},
    }

    const blockView = captureBlocks((patch) => {
      patches.push(patch)
      if (patch.streamPhase !== undefined) activityHistory.push(patch.streamPhase)
      if (observePostInterruptWaiting && patch.streamPhase === "waiting" && (patch.streamingOutputChars ?? 0) === 0) resolveWaitingPatch()
      if (patch.outputBlocks?.some((block) => block.kind === "text" && block.content.includes("answering queued"))) {
        responseRendered.resolve()
        resumedRendered = true
      }
      if (patch.streamingOutputChars !== undefined) lastPublishedChars = patch.streamingOutputChars
      if (resumedRendered && patch.streamPhase === null) phaseSettled = true
      if (phaseSettled && lastPublishedChars === 0) streamSettled.resolve()
    })
    session = await createChatSession(callbacks, createTestChatSessionDeps({
      sessionId: "chat-interrupt-resume-test",
      createAgent: (options) => {
        runner = newTestRunner(options, createClient)
        return runner
      },
      eventBus,
      updateEntry: blockView.updateEntry,
    }))

    void session.send("first message")
    await withTimeout(firstStarted, "first stream never started")

    // Queue a follow-up while the runner is mid-turn, then interrupt.
    void session.send("queued message")
    const activityBeforeInterrupt = activityHistory.length
    const patchCountBeforeInterrupt = patches.length
    observePostInterruptWaiting = true
    expect(session.interrupt()).toBe(true)

    // The agent loop should consume the queued text via prepareWaitForInput and
    // call the LLM again for the queued turn.
    await withTimeout(secondStarted, "second stream never started")
    expect(errors).toEqual([])
    expect(calls).toHaveLength(2)
    const queuedUser = calls[1]!.find(
      (m) => m.kind === "user" && m.content === "queued message",
    )
    expect(queuedUser).toBeDefined()
    await withTimeout(waitingPatch, "waiting phase never reached")
    // The count is omitted from a patch when unchanged since its last publication, so the latest published count is the reading.
    const publishedChars = () => patches.map((patch) => patch.streamingOutputChars).filter((chars) => chars !== undefined).at(-1) ?? 0
    expect(patches.slice(patchCountBeforeInterrupt)).toContainEqual(expect.objectContaining({ streamPhase: "waiting" }))
    expect(publishedChars()).toBe(0)

    releaseSecondResponse()
    await withTimeout(responseRendered.promise, "resumed response never rendered")
    await withTimeout(streamSettled.promise, "resumed stream never settled")
    const responseBlock = blockView.blocks().find(
      (b): b is Extract<AnyBlock, { kind: "text" }> =>
        b.kind === "text" && b.content.includes("answering queued"),
    )
    expect(responseBlock).toBeDefined()
    expect(patches.slice(patchCountBeforeInterrupt)).toContainEqual(expect.objectContaining({ streamPhase: null }))
    expect(publishedChars()).toBe(0)

    // Look at streamPhase patches that arrived AFTER the interrupt call.
    // The resumed turn should still emit phase updates to the entry.
    const postInterrupt = activityHistory.slice(activityBeforeInterrupt)
    const resumedActivity = postInterrupt.find((a) => a === "generating" || a === "thinking" || a === "waiting")
    expect(resumedActivity).toBeDefined()

    // The queued user block should be marked delivered, not pending.
    const queuedBlock = blockView.blocks().find(
      (b): b is Extract<AnyBlock, { kind: "userMessage" }> =>
        b.kind === "userMessage" && b.content === "queued message",
    )
    expect(queuedBlock).toBeDefined()
    expect(queuedBlock!.pending).toBe(false)

    void runner
  })

  it("delivers a message sent after an interrupt as a committed user turn", async () => {
    const calls: ConversationMessage[][] = []
    const firstStarted = Promise.withResolvers<void>()
    const replied = Promise.withResolvers<void>()
    const parks: boolean[] = []
    const treeWriter = makeMemoryTreeWriter()
    let turnIndex = 0
    const createClient = () => asModelClient({
      accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test", contextLimit: 100_000, outputLimit: 8_000,
      supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" },
      async *streamWithTools(options: StreamOptions) {
        calls.push([...options.messages])
        if (turnIndex++ === 0) {
          yield { kind: "provider_response_started" } as const
          yield { kind: "text_delta", text: "working", blockKey: "b0" } as const
          firstStarted.resolve()
          // A provider stream ends when its request is aborted.
          await new Promise<void>((resolve) => { options.signal?.addEventListener("abort", () => resolve(), { once: true }) })
          return
        }
        yield { kind: "text_delta", text: "answering the new message", blockKey: "b0" } as const
        yield { kind: "done", stopReason: "end_turn" } as const
      },
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
    })
    const eventBus = new EventBus()
    eventBus.subscribeToType("agent.turn.parked", (event) => { parks.push(event.data.userResumeRequired) })
    const blockView = captureBlocks((patch) => {
      if (patch.outputBlocks?.some((block) => block.kind === "text" && block.content.includes("answering the new message"))) replied.resolve()
    })
    session = await createChatSession({ onError: () => {}, onEnded: () => {} }, createTestChatSessionDeps({
      sessionId: "chat-send-after-interrupt",
      createAgent: (options) => newTestRunner(options, async () => createClient()),
      eventBus,
      treeWriter,
      updateEntry: blockView.updateEntry,
    }))

    void session.send("first message")
    await withTimeout(firstStarted.promise, "first stream never started")
    expect(session.interrupt()).toBe(true)
    const deadline = Date.now() + 3000
    while (!parks.includes(true) && Date.now() < deadline) await Bun.sleep(2)
    expect(parks).toContain(true)

    void session.send("after the interrupt")
    await withTimeout(replied.promise, "the message after the interrupt never started a turn")
    expect(calls).toHaveLength(2)
    expect(calls[1]!.some((message) => message.kind === "user" && message.content === "after the interrupt")).toBe(true)

    // The words are durable: the tree's own context holds them.
    const committed = (await treeWriter.buildContext()).messages
    expect(committed.some((message) => message.kind === "user" && message.content === "after the interrupt")).toBe(true)
    // And the transcript shows them once, delivered, after the interrupt.
    const userBlocks = blockView.blocks().filter((block): block is Extract<AnyBlock, { kind: "userMessage" }> => block.kind === "userMessage" && block.content === "after the interrupt")
    expect(userBlocks).toHaveLength(1)
    expect(userBlocks[0]!.pending).toBe(false)
  })

  it("a message from another session folds into history after an interrupt and waits for the person, wakes an idle chat as background work, and past the hop limit lands for the person's next turn", async () => {
    const calls: ConversationMessage[][] = []
    const streams = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const parks: boolean[] = []
    const origins: string[] = []
    const treeWriter = makeMemoryTreeWriter()
    const createClient = () => asModelClient({
      accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test", contextLimit: 100_000, outputLimit: 8_000,
      supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" },
      async *streamWithTools(options: StreamOptions) {
        const index = calls.length
        calls.push([...options.messages])
        yield { kind: "provider_response_started" } as const
        yield { kind: "text_delta", text: `answer ${index}`, blockKey: "b0" } as const
        streams[index]?.resolve()
        if (index === 0) {
          await new Promise<void>((resolve) => { options.signal?.addEventListener("abort", () => resolve(), { once: true }) })
          return
        }
        yield { kind: "done", stopReason: "end_turn" } as const
      },
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
    })
    const eventBus = new EventBus()
    eventBus.subscribeToType("agent.turn.parked", (event) => { parks.push(event.data.userResumeRequired) })
    eventBus.subscribeToType("agent.logical_turn.started", (event) => { origins.push(event.data.origin) })
    const blockView = captureBlocks()
    session = await createChatSession({ onError: () => {}, onEnded: () => {} }, createTestChatSessionDeps({
      sessionId: "chat-session-message",
      createAgent: (options) => newTestRunner(options, async () => createClient()),
      eventBus,
      treeWriter,
      updateEntry: blockView.updateEntry,
    }))
    const producer = { kind: "session" as const, sessionId: "parent", conversationId: "parent-conversation", toolUseId: "call-1", hop: 0 }
    const decide = (state: LiveRecipientState) => messageDisposition({ state, origin: "session", hop: 0, self: false })
    const waitForPark = async (count: number) => {
      const deadline = Date.now() + 3000
      while (parks.length < count && Date.now() < deadline) await Bun.sleep(2)
      expect(parks.length).toBeGreaterThanOrEqual(count)
    }

    // The person's turn is interrupted. A message from a session folds into
    // history, starts no request, and the loop still waits for the person.
    void session.send("the person's work")
    await withTimeout(streams[0]!.promise, "the person's turn never started")
    expect(session.interrupt()).toBe(true)
    await waitForPark(1)
    expect(parks).toEqual([true])
    expect(await session.deliverHeldMessage({ text: "while interrupted", producer, dispatchIds: ["msg:parent:call-1"] }, decide)).toEqual({ status: "held", reason: "interrupted" })
    await Bun.sleep(20)
    expect(calls).toHaveLength(1)
    // It parked again, still waiting for the person.
    expect(parks.every(Boolean)).toBe(true)

    // Only the person's next message restarts work, and that turn reads the held message.
    void session.send("go on")
    await withTimeout(streams[1]!.promise, "the person's message never restarted work")
    expect(JSON.stringify(calls[1])).toContain("while interrupted")
    expect(origins.at(-1)).toBe("user")
    const answered = Date.now() + 3000
    while (parks.at(-1) !== false && Date.now() < answered) await Bun.sleep(2)
    expect(parks.at(-1)).toBe(false)

    // Idle with an answered turn: the message wakes a turn that is
    // background work, not the person's.
    const before = origins.length
    expect(await session.deliverHeldMessage({ text: "from the parent", producer: { ...producer, toolUseId: "call-2" }, dispatchIds: ["msg:parent:call-2"] }, decide)).toEqual({ status: "delivered", startsTurn: true })
    await withTimeout(streams[2]!.promise, "the session message never woke the idle chat")
    expect(calls[2]!.at(-1)).toMatchObject({ kind: "user", content: "from the parent", producer: { ...producer, toolUseId: "call-2" } })
    expect(origins.slice(before)).toEqual(["background"])

    // Idle again with an answered turn, under the runner's held turn slot: a
    // message past the hop limit starts no turn, but it enters history and
    // shows, and the person's next turn reads it.
    const settledParks = parks.length
    const idleAgain = Date.now() + 3000
    while (parks.length === settledParks && Date.now() < idleAgain) await Bun.sleep(2)
    expect(parks.at(-1)).toBe(false)
    const limited = (state: LiveRecipientState) => messageDisposition({ state, origin: "session", hop: 5, self: false })
    expect(await session.deliverHeldMessage({ text: "at the hop limit", producer: { ...producer, toolUseId: "call-3", hop: 5 }, dispatchIds: ["msg:parent:call-3"] }, limited)).toEqual({ status: "held", reason: "wake_limit" })
    await Bun.sleep(20)
    expect(calls).toHaveLength(3)
    expect(blockView.blocks().filter((block) => block.kind === "userMessage" && block.content === "at the hop limit")).toEqual([expect.objectContaining({ pending: false })])
    void session.send("the person again")
    await withTimeout(streams[3]!.promise, "the person's next message never started a turn")
    expect(JSON.stringify(calls[3])).toContain("at the hop limit")
  })

  // Root chats that wait on their background work exchanged messages at hop
  // 0 for hours: no message woke them, so the wake limit never held one.
  it("a chat parked on its background work gives its loop a peer's message at the hop limit as held, and its own child's message to read", async () => {
    const parkedOnWork = { handoffWritten: false, turnCount: 1, activeBackgroundCount: 1, parkedOnBackgroundWork: true, waitRequested: false, userResumeRequired: false, park: "waiting_on_work" as const }
    const read: { readonly text: string; readonly held: boolean }[] = []
    const firstPark = Promise.withResolvers<void>()
    session = await createChatSession({ onError: () => {}, onEnded: () => {} }, createTestChatSessionDeps({
      sessionId: "chat-parked-on-work",
      createAgent: (options): Agent => {
        const runAbort = new AbortController()
        const done = Promise.withResolvers<AgentRunResult>()
        const park = async (): Promise<void> => {
          await options.lifecycle.onTurnEnded?.({ handoffWritten: false, turnCount: 1 })
          for (;;) {
            await options.lifecycle.onTurnParked?.(parkedOnWork)
            firstPark.resolve()
            const input = await options.lifecycle.inputSource?.prepareWaitForInput?.(runAbort.signal).commit()
            if (!input) return
            if (input.kind === "message") read.push({ text: input.text, held: input.held === true })
          }
        }
        return {
          done: done.promise,
          send() { void park().catch(() => {}) },
          end() {},
          abort() {
            runAbort.abort()
            done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } })
          },
        }
      },
    }))
    void session.send("start the build in the background")
    await withTimeout(firstPark.promise, "the turn never parked on its background work")
    expect(await session.messageState()).toBe("waiting_on_work")

    const peer: SessionInputProducer = { kind: "session", sessionId: "peer", conversationId: "peer-conversation", toolUseId: "call-1", hop: 5, envelope: { name: "Peer", relation: "other", waits: false } }
    const ownChild: SessionInputProducer = { ...peer, sessionId: "child", conversationId: "child-conversation", envelope: { name: "Child", relation: "child", waits: false } }
    const decideFor = (producer: SessionInputProducer) => (state: LiveRecipientState) => messageDisposition({ state, origin: "session", hop: producer.hop, self: false, ...(producer.envelope ? { relation: producer.envelope.relation } : {}) })
    expect(await session.deliverHeldMessage({ text: "is the build done?", producer: peer, dispatchIds: ["msg:peer:call-1"] }, decideFor(peer))).toEqual({ status: "held", reason: "wake_limit" })
    expect(await session.deliverHeldMessage({ text: "the tests pass", producer: ownChild, dispatchIds: ["msg:child:call-1"] }, decideFor(ownChild))).toEqual({ status: "delivered", startsTurn: false })
    for (let wait = 0; wait < 100 && read.length < 2; wait += 1) await Bun.sleep(2)
    expect(read).toEqual([{ text: "is the build done?", held: true }, { text: "the tests pass", held: false }])
  })

  /** A chat whose conversation the store holds with the entries `seed` appends. */
  async function storedChat(seed: Parameters<typeof createStoredChatSession>[0]["seed"], overrides?: Partial<Parameters<typeof createTestChatSessionDeps>[0]>) {
    const dir = temporary("chat-stored-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
    stores.push(store)
    const stored = await createStoredChatSession({ sessionId: "chat-stored", conversationId: "conversation-chat-stored", projectRoot: dir, reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), seed, ...(overrides ? { overrides } : {}) })
    session = stored.chat
    return { ...stored, reader: asAsyncEventReadSurface(store) }
  }

  const childQuestion = { kind: "session" as const, sessionId: "child", conversationId: "child-conversation", toolUseId: "ask-1", hop: 0 }
  const decideForChild = (state: LiveRecipientState) => messageDisposition({ state, origin: "session", hop: 0, self: false })

  // A child's resume holds its parent's runner before the parent runs again,
  // as a successor or a Resume after a crash does. The hold runs no turn, so
  // the parent's last turn still waits for its Resume.
  for (const [label, end] of [
    ["a planned replacement cut", interruptedTurnEnd("replacement")],
    ["an unexpected exit ended", { reason: "crash" }],
  ] as const satisfies readonly (readonly [string, TurnEnd])[]) {
    it(`a hold of a chat whose last turn ${label} waits for its Resume from its start: a planned replacement has nothing to cut, a message from another session meets it interrupted and folds into history, and Resume continues the turn that reads it`, async () => {
      const { chat, calls, parks, parked, turnEnds } = await storedChat(async (tree) => {
        await tree.appendMessage({ kind: "user", content: "delegate the letter to a child", origin: "human" })
        await appendTurnEnd(tree, end)
      })

      // Before the hold parks, it runs no turn either.
      const held = chat.hold()
      expect(chat.holdsRunningTurn()).toBe(false)
      expect(await chat.messageState()).toBe("interrupted")
      await held
      await parked(1)
      expect(await chat.messageState()).toBe("interrupted")
      expect(parks).toEqual([true])

      // A cut here would record the runtime's planned interrupt over the
      // turn end, and a successor would resume the chat without the person.
      expect(chat.holdsRunningTurn()).toBe(false)
      expect(await chat.interruptForReplacement()).toBe(false)
      expect(await turnEnds()).toEqual([end])

      expect(await chat.deliverHeldMessage({ text: "which letter should I write?", producer: childQuestion, dispatchIds: ["msg:child:ask-1"] }, decideForChild)).toEqual({ status: "held", reason: "interrupted" })
      await Bun.sleep(20)
      expect(calls).toHaveLength(0)
      expect(await chat.messageState()).toBe("interrupted")

      expect(chat.resume({ announce: false })).toBe(true)
      for (let wait = 0; wait < 100 && calls.length === 0; wait += 1) await Bun.sleep(10)
      expect(calls).toHaveLength(1)
      expect(JSON.stringify(calls[0])).toContain("which letter should I write?")
      expect(JSON.stringify(calls[0])).toContain(CONTINUATION_MESSAGES.resumed)
    })

    // A compaction runs no turn of the person's either. Its checkpoint and
    // reset follow the turn end, so the reset carries that record past
    // itself for every reader of the conversation's tail and for the model.
    it(`a compaction of a chat whose last turn ${label} keeps that turn end: the chat parks for its Resume, a reader with no runner still finds the turn end, and Resume reads it after the reset`, async () => {
      const { chat, calls, parks, parked, turnEnds, reader } = await storedChat(async (tree) => {
        await tree.appendMessage({ kind: "user", content: "delegate the letter to a child", origin: "human" })
        await appendTurnEnd(tree, end)
      })

      await chat.compact()
      await parked(1)
      expect(parks).toEqual([true])
      expect(calls).toHaveLength(1)
      expect(await chat.messageState()).toBe("interrupted")
      expect(await readChatTurnEnd(reader, "conversation-chat-stored")).toEqual({ end, recorded: true })
      // The recovery text that opens the fresh context is a settled record behind the copy.
      expect(await turnEnds()).toEqual([end, end, { reason: "settled" }])

      expect(chat.resume({ announce: false })).toBe(true)
      for (let wait = 0; wait < 100 && calls.length === 1; wait += 1) await Bun.sleep(10)
      expect(calls).toHaveLength(2)
      const resumed = JSON.stringify(calls[1])
      expect(resumed).not.toContain("delegate the letter to a child")
      expect(resumed).toContain(end.reason === "crash" ? "The process running this turn exited" : "The runtime interrupted this turn")
      expect(resumed).toContain(CONTINUATION_MESSAGES.resumed)
    })
  }

  // The tab stayed open after the person's interrupt, so the loop that the
  // interrupt cut still parks for the person. A /compact there runs at once,
  // as it does after a reopen, and the chat still waits for its Resume. A
  // second Escape that lands before the park (a double press, a lagging
  // status) is older than the /compact, so it cuts nothing.
  for (const escapes of [1, 2] as const) it(`a compaction of a chat that the person interrupted ${escapes === 1 ? "once" : "with a double Escape"} in an open tab runs at once and keeps the interrupt: the chat parks for its Resume, a reader with no runner still finds the turn end, and Resume reads it after the reset`, async () => {
    const firstStarted = Promise.withResolvers<void>()
    const requests: ConversationMessage[][] = []
    const client = async () => asModelClient({
      accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test", contextLimit: 100_000, outputLimit: 8_000,
      supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" },
      async *streamWithTools(options: StreamOptions) {
        const index = requests.length
        requests.push([...options.messages])
        yield { kind: "provider_response_started" } as const
        yield { kind: "text_delta", text: "working", blockKey: "b0" } as const
        if (index === 0) {
          firstStarted.resolve()
          // A provider stream ends when its request is aborted.
          await new Promise<void>((resolve) => { options.signal?.addEventListener("abort", () => resolve(), { once: true }) })
          return
        }
        if (index === 1) {
          yield { kind: "tool_use", toolCall: { id: "save", name: "checkpoint_replace", input: { section: "currentState", value: "working" } } } as const
          yield { kind: "done", stopReason: "tool_use" } as const
          return
        }
        yield { kind: "done", stopReason: "end_turn" } as const
      },
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
    })
    const { chat, parks, parked, turnEnds, reader } = await storedChat(async () => {}, { createAgent: (options) => newTestRunner(options, client) })
    const person = interruptedTurnEnd("person")

    void chat.send("write the letter")
    await withTimeout(firstStarted.promise, "the person's turn never started")
    expect(chat.interrupt()).toBe(true)
    if (escapes === 2) chat.interrupt()
    await parked(1)
    expect(parks).toEqual([true])

    await chat.compact()
    await parked(2)
    expect(parks).toEqual([true, true])
    expect(requests).toHaveLength(2)
    expect(await chat.messageState()).toBe("interrupted")
    expect(await readChatTurnEnd(reader, "conversation-chat-stored")).toEqual({ end: person, recorded: true })
    expect(await turnEnds()).toEqual([person, person, { reason: "settled" }])

    expect(chat.resume({ announce: false })).toBe(true)
    for (let wait = 0; wait < 100 && requests.length === 2; wait += 1) await Bun.sleep(10)
    expect(requests).toHaveLength(3)
    const resumed = JSON.stringify(requests[2])
    expect(resumed).not.toContain("write the letter")
    expect(resumed).toContain(CONTINUATION_MESSAGES.resumed)
  })

  // The reset's recovery text has no answer when the compaction parks, and
  // that is the plan, not a turn that died: once the runner lets go, every
  // reader with no runner still finds an answered chat.
  it("a compaction of an answered chat parks idle, and a reader with no runner finds no turn that waits for Resume", async () => {
    const { chat, calls, parks, parked, reader } = await storedChat(async (tree) => {
      await tree.appendMessage({ kind: "user", content: "write the letter", origin: "human" })
      await tree.appendMessage({ kind: "assistant", content: [{ type: "text", text: "The letter is Q." }] })
    })

    await chat.compact()
    await parked(1)
    expect(parks).toEqual([false])
    expect(calls).toHaveLength(1)
    expect(await chat.messageState()).toBe("idle")
    const turnEnd = await readChatTurnEnd(reader, "conversation-chat-stored")
    expect(turnEnd).toEqual({ end: { reason: "settled" }, recorded: true })
    expect(chatSessionActions("chat", "inactive", turnEnd)).toEqual(["session.delete"])

    // The person's next message reads the reset's recovery text.
    void chat.send("go on")
    for (let wait = 0; wait < 100 && calls.length === 1; wait += 1) await Bun.sleep(10)
    expect(JSON.stringify(calls[1])).toContain("A fresh context window has started")
  })

  // Rule 2 of a reply wait needs a turn of the addressee that ends: a hold
  // runs none, so its park tells no wait that the chat yielded.
  it("a hold of an answered chat parks idle and reports no yield; the park after the turn that a message wakes reports one", async () => {
    const yields: SessionYield[] = []
    const sessionMessaging: SessionMessaging = {
      children: unusedChildSessionControl(),
      send: async () => { throw new Error("no message is sent in this test") },
      observeRun: async () => ({ resumed: () => {}, yielded: async (input) => { yields.push(input) }, changed: async () => {} }),
      list: async () => [],
      identity: async () => undefined,
    }
    const { chat, parked } = await storedChat(async (tree) => {
      await tree.appendMessage({ kind: "user", content: "delegate the letter to a child", origin: "human" })
      await tree.appendMessage({ kind: "assistant", content: "The child is on it." })
    }, { sessionMessaging })

    await chat.hold()
    await parked(1)
    await Bun.sleep(10)
    expect(await chat.messageState()).toBe("idle")
    expect(yields).toEqual([])

    expect(await chat.deliverHeldMessage({ text: "which letter should I write?", producer: childQuestion, dispatchIds: ["msg:child:ask-1"] }, decideForChild)).toEqual({ status: "delivered", startsTurn: true })
    await parked(2)
    for (let wait = 0; wait < 50 && yields.length === 0; wait += 1) await Bun.sleep(2)
    expect(yields).toEqual([{ lastText: "The letter is Q.", waitRequested: false }])
  })

  it("rebuilds model-visible context from the session tree on resume", async () => {
    // The tree writer (production-shaped mock) holds the durable session
    // history. On the first send after restart, `buildContext()` is the
    // source the runner sees — no flat conversation file is consulted.
    const treeWriter = makeMemoryTreeWriter()
    // Pre-populate the tree with prior user/assistant history as if a
    // previous process had committed it.
    await treeWriter.commitUserTurn("prior user turn")
    // Simulate the in-turn save-point that wrote a prior assistant reply.
    treeWriter.beginTurn()
    // Skip enqueueMessage here — buildContext only needs the messages our
    // mock records, and we are emulating a tree where the prior turn
    // already flushed.
    const seenPriorMessages: ConversationMessage[][] = []
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
        seenPriorMessages.push([...options.messages])
        yield { kind: "text_delta", text: "resumed reply", blockKey: "b0" } as const
        yield { kind: "done", stopReason: "end_turn" } as const
      },
    })

    const callbacks: ChatCallbacks = {
      onError: () => {},
      onEnded: () => {},
    }

    let runner: LiveAgent | null = null
    session = await createChatSession(callbacks, createTestChatSessionDeps({
      sessionId: "chat-resume-test",
      createAgent: (options) => {
        runner = newTestRunner(options, createClient)
        return runner
      },
      treeWriter,
    }))

    void session.send("follow up after resume")

    const deadline = Date.now() + 500
    while (seenPriorMessages.length === 0 && Date.now() < deadline) {
      await Bun.sleep(2)
    }

    expect(runner).not.toBeNull()
    expect(seenPriorMessages).toHaveLength(1)

    // The model sees the prior user turn from the tree AND the new follow-up
    // committed in this process. No file-based history was consulted.
    const messages = seenPriorMessages[0]!
    const contents = messages.map((m) => ("content" in m && typeof m.content === "string" ? m.content : ""))
    expect(contents).toContain("prior user turn")
    expect(contents).toContain("follow up after resume")
  })

  it("commits an idle background notification before respawning the runner", async () => {
    const treeWriter = makeMemoryTreeWriter()
    const runnerOptions: AgentOptions[] = []
    const sends: string[] = []
    let background: NonNullable<AgentOptions["runtimeSurfaces"]>["background"]

    const createFakeRunner = (options: AgentOptions): Agent => {
      const index = runnerOptions.length
      runnerOptions.push(options)
      background = options.runtimeSurfaces?.background
      const done = Promise.withResolvers<AgentRunResult>()
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        done.resolve({ servedRequests: 0, durationMs: 1, providerSessionKey: "provider-conv", terminal: { kind: "completed" } })
      }
      return {
        done: done.promise,
        send(text: string) {
          sends.push(text)
          if (index === 0 && (options.conversation.kind === "durable-tree" || options.conversation.kind === "ephemeral")) {
            options.conversation.append({ kind: "assistant", content: "idle reply" })
          }
          options.lifecycle.onTurnEnded?.({ handoffWritten: false, turnCount: 1 })
          finish()
        },
        end() {},
        abort() { finish() },
      }
    }

    const callbacks: ChatCallbacks = {
      onError: () => {},
      onEnded: () => {},
    }

    session = await createChatSession(callbacks, createTestChatSessionDeps({
      sessionId: "chat-idle-background-notification-test",
      createAgent: createFakeRunner,
      treeWriter,
    }))

    void session.send("initial")
    const firstDoneDeadline = Date.now() + 500
    while (runnerOptions.length < 1 && Date.now() < firstDoneDeadline) {
      await Bun.sleep(2)
    }
    expect(runnerOptions).toHaveLength(1)

    background?.tasks.track({
      done: Promise.resolve({ status: "completed", content: "background result" }),
      meta: { id: "task-1", type: "subagent", description: "Background audit" },
    })

    const secondDeadline = Date.now() + 500
    while (runnerOptions.length < 2 && Date.now() < secondDeadline) {
      await Bun.sleep(2)
    }

    expect(runnerOptions).toHaveLength(2)
    expect(sends.at(-1)).toContain("<subagent_notifications>")
    const messages = runnerOptions[1]!.conversation.kind === "durable-tree" || runnerOptions[1]!.conversation.kind === "replay" ? runnerOptions[1]!.conversation.priorMessages : []
    const last = messages.at(-1)
    expect(last?.kind).toBe("user")
    expect(String(last?.content ?? "")).toContain("<subagent_notifications>")
    expect(String(last?.content ?? "")).toContain("background result")
  })
})

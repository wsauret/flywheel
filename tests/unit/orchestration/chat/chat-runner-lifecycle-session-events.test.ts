import { afterEach, describe, expect, it } from "bun:test"
import { EventBus } from "../../../../src/infra/event-bus"
import { PersistenceWriteRefused } from "../../../../src/infra/event-store-types"
import type { TurnParkState } from "../../../../src/infra/agent-loop-events"
import { createChatSession } from "../../../../src/orchestration/chat/session"
import type { ChatRunner, SessionEventKind } from "../../../../src/orchestration/chat/runner-types"
import type { AgentOptions } from "../../../../src/orchestration/agent-runtime/types"
import type { ConversationMessage, ProviderStreamEvent, StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types"
import { newTestRunner } from "../../../helpers/agent-runner.js"
import { asModelClient } from "../agent-runtime/_model-client"
import { captureBlocks, createTestChatSessionDeps, makeMemoryTreeWriter } from "./_chat-session-agent-runtime-fixtures"
import { flushMicrotasks, makeLifecycle } from "./_chat-runner-lifecycle-fixtures"

const NOTICE = "<session_event_notice>c asked</session_event_notice>"

type Background = NonNullable<AgentOptions["runtimeSurfaces"]>["background"]
type Reply = (request: number, options: StreamOptions, background: Background) => AsyncGenerator<ProviderStreamEvent>

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!predicate() && Date.now() < deadline) await Bun.sleep(2)
  if (!predicate()) throw new Error(`timed out waiting for ${what}`)
}

function untilAborted(options: StreamOptions): Promise<void> {
  return new Promise<void>((resolve) => { options.signal?.addEventListener("abort", () => resolve(), { once: true }) })
}

/** A chat over the real agent loop whose model answers each request as `reply` says. It records each request's
 *  messages, each park, each reported session event, and each system turn that the runner committed itself. */
async function scriptedChat(reply: Reply) {
  const calls: ConversationMessage[][] = []
  const parks: TurnParkState[] = []
  const events: SessionEventKind[] = []
  const committedSystemTurns: string[] = []
  let background: Background
  const createClient = async () => asModelClient({
    accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test", contextLimit: 100_000, outputLimit: 8_000,
    supportsReasoning: false,
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
    async *streamWithTools(options: StreamOptions) {
      calls.push([...options.messages])
      yield* reply(calls.length - 1, options, background)
    },
  })
  const eventBus = new EventBus()
  eventBus.subscribeToType("agent.turn.parked", (event) => { parks.push(event.data.park) }, { deliveryClass: "ui", label: "test-turn-parked" })
  const blocks = captureBlocks()
  const treeWriter = makeMemoryTreeWriter()
  const commitSystemTurn = treeWriter.commitSystemTurn
  treeWriter.commitSystemTurn = async (text, key) => {
    committedSystemTurns.push(text)
    return commitSystemTurn(text, key)
  }
  const session = createChatSession({ onError: () => {}, onEnded: () => {} }, createTestChatSessionDeps({
    sessionId: "watcher",
    createAgent: (options) => {
      background = options.runtimeSurfaces?.background
      return newTestRunner(options, createClient)
    },
    eventBus,
    treeWriter,
    updateEntry: blocks.updateEntry,
    onSessionEvent: (kind) => { events.push(kind) },
  }))
  return { session, calls, parks, events, committedSystemTurns, blocks: blocks.blocks, background: () => background, context: () => treeWriter.buildContext() }
}

async function* answers(text: string): AsyncGenerator<ProviderStreamEvent> {
  yield { kind: "text_delta", text, blockKey: "b0" }
  yield { kind: "done", stopReason: "end_turn" }
}

async function* saysNothing(): AsyncGenerator<ProviderStreamEvent> {
  yield { kind: "done", stopReason: "end_turn" }
}

function textOf(message: ConversationMessage | undefined): string {
  return typeof message?.content === "string" ? message.content : JSON.stringify(message?.content)
}

describe("a silent notice to a chat runner", () => {
  let session: ChatRunner | null = null
  afterEach(async () => {
    await session?.dispose()
    session = null
  })

  it("commits one system-origin entry and starts one turn on a runner with no live loop", async () => {
    const { lifecycle, deps, runnerOptions, state, resolvers } = makeLifecycle()
    try {
      expect(await lifecycle.deliverSilentNotice(NOTICE)).toBe("delivered")
      await flushMicrotasks()
      const { messages } = await deps.treeWriter.buildContext()
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ kind: "user", content: NOTICE, origin: "system" })
      expect(messages[0]).not.toHaveProperty("backgroundNotificationIds")
      expect(messages[0]).not.toHaveProperty("replyRequired")
      expect(runnerOptions).toHaveLength(1)
    } finally {
      state.end()
      resolvers.at(-1)?.({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } })
      await lifecycle.settle()
      await lifecycle.terminateBackgroundWorks()
    }
  })

  it("reports a provider failure once, and after it commits the notice and starts one turn", async () => {
    const events: SessionEventKind[] = []
    const { lifecycle, deps, runnerOptions, state, resolvers } = makeLifecycle(undefined, (prepared) => {
      prepared.onSessionEvent = (kind) => { events.push(kind) }
    })
    try {
      await lifecycle.enqueueInput("first")
      await flushMicrotasks()
      resolvers[0]?.({ servedRequests: 1, durationMs: 1, terminal: { kind: "api_error", message: "failed", recovery: { kind: "none" } } })
      await flushMicrotasks()
      expect(events).toEqual(["failed"])

      expect(await lifecycle.deliverSilentNotice(NOTICE)).toBe("delivered")
      await flushMicrotasks()
      const { messages } = await deps.treeWriter.buildContext()
      // The fake runner records nothing of its own turn, so the notice is the one entry.
      expect(messages).toEqual([expect.objectContaining({ content: NOTICE, origin: "system" })])
      expect(runnerOptions).toHaveLength(2)
    } finally {
      state.end()
      resolvers.at(-1)?.({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } })
      await lifecycle.settle()
      await lifecycle.terminateBackgroundWorks()
    }
  })

  it.each(["completed", "api_error"] as const)("reports a turn whose final save is refused once as failed, after a %s run", async (kind) => {
    const events: SessionEventKind[] = []
    const { lifecycle, state, resolvers } = makeLifecycle(undefined, (prepared) => {
      prepared.onSessionEvent = (event) => { events.push(event) }
      prepared.treeWriter.endTurn = async () => { throw new PersistenceWriteRefused(129, 128, "final-result") }
    })
    try {
      await lifecycle.enqueueInput("first")
      await flushMicrotasks()
      resolvers[0]?.({ servedRequests: 1, durationMs: 1, terminal: kind === "completed" ? { kind } : { kind, message: "failed", recovery: { kind: "none" } } })
      await flushMicrotasks()
      expect(events).toEqual(["failed"])
    } finally {
      state.end()
      await lifecycle.settle()
      await lifecycle.terminateBackgroundWorks()
    }
  })

  it("enters the silent channel of a loop parked idle, and a reply with no text ends that turn with no nudge and no block", async () => {
    const chat = await scriptedChat((request) => request === 0 ? answers("Done.") : saysNothing())
    session = chat.session
    expect(await session.send("hello")).toBe("accepted")
    await until(() => chat.parks.length === 1, "the first park")
    const blocksBefore = chat.blocks()

    expect(await session.deliverSilentNotice(NOTICE)).toBe("delivered")
    await until(() => chat.parks.length === 2, "the park after the notice")

    expect(chat.parks).toEqual(["idle", "idle"])
    // A reply nudge would be a third request before the park.
    expect(chat.calls).toHaveLength(2)
    expect(textOf(chat.calls[1]?.at(-1))).toBe(NOTICE)
    expect(chat.committedSystemTurns).toEqual([])
    expect(chat.blocks()).toEqual(blocksBefore)
  })

  it("starts a turn from the committed entry on a fresh runner, and a reply with no text ends it with no nudge and no block", async () => {
    const chat = await scriptedChat(() => saysNothing())
    session = chat.session

    expect(await session.deliverSilentNotice(NOTICE)).toBe("delivered")
    await until(() => chat.parks.length === 1, "the park after the notice")

    expect(chat.parks).toEqual(["idle"])
    expect(chat.calls).toHaveLength(1)
    expect(textOf(chat.calls[0]?.at(-1))).toBe(NOTICE)
    expect(chat.committedSystemTurns).toEqual([NOTICE])
    expect(chat.blocks()).toEqual([])
  })

  it("is held by a loop parked after an interrupt: nothing is committed or queued, and the cut is reported once", async () => {
    const chat = await scriptedChat(async function* (request, options) {
      if (request > 0) { yield* answers("Continued."); return }
      yield { kind: "text_delta", text: "Working.", blockKey: "b0" }
      await untilAborted(options)
    })
    session = chat.session
    void session.send("work")
    await until(() => chat.calls.length === 1, "the first request")
    expect(session.interrupt()).toBe(true)
    await until(() => chat.parks.includes("interrupted"), "the interrupted park")

    expect(await session.deliverSilentNotice(NOTICE)).toBe("held")
    expect(chat.committedSystemTurns).toEqual([])

    expect(session.resume({ announce: true })).toBe(true)
    await until(() => chat.parks.at(-1) === "idle", "the park after the resume")
    expect(chat.calls.flat().some((message) => textOf(message).includes(NOTICE))).toBe(false)
    expect(chat.events).toEqual(["cut", "turn_ended"])
  })
})

describe("the session events of a chat runner", () => {
  let session: ChatRunner | null = null
  afterEach(async () => {
    await session?.dispose()
    session = null
  })

  it("reports a question once when the turn starts to wait for the person", async () => {
    const chat = await scriptedChat(async function* () {
      yield { kind: "tool_use", toolCall: { id: "ask-1", name: "ask_user", input: { context: "One decision is needed.", question: "Proceed?", header: "Go", options: [{ label: "Yes" }, { label: "No" }] } } }
      yield { kind: "done", stopReason: "tool_use" }
    })
    session = chat.session
    void session.send("ask me")
    await until(() => chat.events.length > 0, "the question")
    await flushMicrotasks()
    expect(chat.events).toEqual(["asked"])
  })

  it("reports an answered turn when its loop parks idle, and nothing for a park that waits on background work", async () => {
    const task = Promise.withResolvers<{ status: "completed"; content: string }>()
    const chat = await scriptedChat(async function* (request, _options, background) {
      yield { kind: "text_delta", text: `answer ${request}`, blockKey: "b0" }
      if ((background?.tasks.awaitedTaskCount() ?? 0) > 0) {
        yield { kind: "tool_use", toolCall: { id: `wait-${request}`, name: "process", input: { action: "wait", soft_timeout: 7200 } } }
        yield { kind: "done", stopReason: "tool_use" }
        return
      }
      yield { kind: "done", stopReason: "end_turn" }
    })
    session = chat.session
    expect(await session.send("first")).toBe("accepted")
    await until(() => chat.parks.length === 1, "the first park")
    expect(chat.events).toEqual(["turn_ended"])

    chat.background()?.tasks.track({ done: task.promise, meta: { id: "task-1", type: "subagent", description: "Background work" } })
    expect(await session.send("wait for it")).toBe("accepted")
    await until(() => chat.parks.includes("waiting_on_work"), "the park on background work")
    expect(chat.events).toEqual(["turn_ended"])

    task.resolve({ status: "completed", content: "result" })
    await until(() => chat.parks.at(-1) === "idle" && chat.parks.length > 2, "the park after the result")
    expect(chat.events).toEqual(["turn_ended", "turn_ended"])
  })
})

import { afterEach, describe, expect, it } from "bun:test"
import { EventBus } from "../../../../src/infra/event-bus"
import { createChatSession } from "../../../../src/orchestration/chat/session"
import type { ChatRunner } from "../../../../src/orchestration/chat/runner-types"
import type { ChatCallbacks } from "../../../../src/orchestration/chat/types"
import { newTestRunner } from "../../../helpers/agent-runner.js"
import type { AgentOptions } from "../../../../src/orchestration/agent-runtime/types"
import { FUNCTION_TOOL_PRESENTATION, type StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types"
import type { ConversationMessage } from "../../../../src/infra/llm/conversation/conversation-message"
import { asModelClient } from "../agent-runtime/_model-client"
import { chain, fakeAvailability } from "../agent-runtime/llm/_provider-chain-harness"
import { chatInputText, type ChatInputLike } from "../../../../src/infra/chat-input"
import { appendTurnEnd, captureBlocks, createStoredChatSession, createTestChatSessionDeps } from "./_chat-session-agent-runtime-fixtures"
import { interruptedTurnEnd } from "../../../../src/orchestration/session/conversation/turn-end-record.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/store/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/store/sqlite-event-store.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { ownHistoryTarget } from "../agent-runtime/_model-client.js";
import { durableSubagentCompletionNotification } from "../../../../src/orchestration/session/control/background-work/background-work-notifications"
import type { BackgroundWorkResult } from "../../../../src/orchestration/session/control/background-work/background-work-types"
import type { BackgroundWorkRegistry, BackgroundWorkTracking } from "../../../../src/orchestration/session/control/background-work/background-work"

function isBackgroundWorkRegistry(tasks: BackgroundWorkTracking): tasks is BackgroundWorkRegistry {
  return "deliverWatchEvent" in tasks
}

describe("chat session with agent runtime — background-work notification (f06c00e9c8cd regression)", () => {
  let session: ChatRunner | null = null

  afterEach(async () => {
    await session?.dispose()
    session = null
  })

  it("delivers a background notification to a parked runner without respawning", async () => {
    // Regression: parent runner used to exit cleanly at end_turn; a subagent
    // completing later had no waiter on the mailbox and the session stuck.
    // Park-by-default keeps the runner attached at prepareWaitForInput; a
    // background-source submit wakes it on the same channel as user input,
    // and commitUserTurn is NOT re-invoked because the runner is present —
    // the agent loop persists the notification via the canonical-message
    // pipeline (recordCanonicalMessage), preserving one source of truth for
    // user-turn entries.
    const commitUserTurnCalls: string[] = []
    const calls: ConversationMessage[][] = []
    let runnerCreations = 0
    let parkedCount = 0
    let logicalTurnCount = 0
    let turnIndex = 0
    let waitingOnBackgroundWork = false
    let capturedBackground: NonNullable<AgentOptions["runtimeSurfaces"]>["background"]
    // A child's completion reaches its parent through reconciliation, which
    // delivers the durable notification after the child's run settles.
    const deliverWhenSettled = (childRunId: string, description: string, done: Promise<BackgroundWorkResult>) => {
      void done.then((result) => capturedBackground?.tasks.deliverDurableSubagentNotification(durableSubagentCompletionNotification([{ type: "subagent", childRunId, description, result }], 0)))
    }
    const streamEntries = Array.from({ length: 4 }, () => Promise.withResolvers<void>())
    let nextPark = Promise.withResolvers<void>()
    const waitingProjected = Promise.withResolvers<void>()

    const createClient = async () => chain({
      candidates: ["anthropic_api"],
      family: "anthropic",
      model: "test",
      availability: fakeAvailability({}).availability,
      build: async () => ({ historyTarget: ownHistoryTarget,
        accessProvider: "anthropic_api",
        modelFamily: "anthropic",
        model: "test",
        toolPresentation: FUNCTION_TOOL_PRESENTATION,
        contextLimit: 100_000,
        outputLimit: 8_000,
        supportsReasoning: false,
        priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
        async *streamWithTools(options: StreamOptions) {
          calls.push([...options.messages])
          streamEntries[calls.length - 1]?.resolve()
          turnIndex += 1
          yield { kind: "text_delta", text: turnIndex === 1 ? "first answer" : "second answer", blockKey: "b0" } as const
          if ((capturedBackground?.tasks.awaitedTaskCount() ?? 0) > 0) {
            expect(options.tools.some((tool) => tool.name === "process")).toBe(true)
            yield { kind: "tool_use", toolCall: { id: `wait-${turnIndex}`, name: "process", input: { action: "wait", soft_timeout: 7200 } } } as const
            yield { kind: "done", stopReason: "tool_use" } as const
          } else {
            yield { kind: "done", stopReason: "end_turn" } as const
          }
        },
      }),
    })

    const callbacks: ChatCallbacks = {
      onError: () => {},
      onEnded: () => {},
    }

    const eventBus = new EventBus()
    eventBus.subscribeToType("agent.turn.parked", () => {
      parkedCount += 1
      nextPark.resolve()
      nextPark = Promise.withResolvers<void>()
    })
    eventBus.subscribeToType("agent.logical_turn.started", () => { logicalTurnCount += 1 })
    const blockView = captureBlocks((patch) => {
      if (patch.waitingOnBackgroundWork !== undefined) {
        waitingOnBackgroundWork = patch.waitingOnBackgroundWork
        if (waitingOnBackgroundWork) waitingProjected.resolve()
      }
    })
    const deps = createTestChatSessionDeps({
      sessionId: "chat-f06c00e9c8cd-regression",
      eventBus,
      createAgent: (options) => {
        runnerCreations += 1
        capturedBackground = options.runtimeSurfaces?.background
        return newTestRunner(options, createClient)
      },
      updateEntry: blockView.updateEntry,
    })
    const baseCommitUserTurn = deps.treeWriter.commitUserTurn
    deps.treeWriter.commitUserTurn = async (input: ChatInputLike) => {
      commitUserTurnCalls.push(chatInputText(input))
      return baseCommitUserTurn(input)
    }
    const turnEnds: Parameters<typeof deps.treeWriter.commitTurnEnd>[0][] = []
    const baseCommitTurnEnd = deps.treeWriter.commitTurnEnd
    deps.treeWriter.commitTurnEnd = async (by) => {
      turnEnds.push(by)
      return baseCommitTurnEnd(by)
    }

    session = await createChatSession(callbacks, deps)

    // Drive the runner to end_turn with no tools, then wait for its exact park.
    const initialPark = nextPark.promise
    expect(await session.send("initial")).toBe("accepted")
    await streamEntries[0]!.promise
    await initialPark
    expect(calls).toHaveLength(1)
    expect(runnerCreations).toBe(1)
    expect(capturedBackground).toBeDefined()

    // f06c00e9c8cd: a background task completes long after end_turn.
    const backgroundPark = nextPark.promise
    const lateTask = Promise.resolve({ status: "failed", content: "generic subagent failed" } as const)
    capturedBackground?.tasks.track({
      done: lateTask,
      meta: { id: "task-late", type: "subagent", description: "Late background work" },
    })
    deliverWhenSettled("task-late", "Late background work", lateTask)

    await backgroundPark

    // (a) notification appears in the next-turn input — observable as the
    // trailing user message the model sees on turn 2.
    // (b) parked prepareWaitForInput reservation resolved (turn 2 happened).
    // (c) parent emitted the next turn.
    expect(calls).toHaveLength(2)
    const secondTurnUser = calls[1]!.at(-1)
    expect(secondTurnUser?.kind).toBe("user")
    expect(String(secondTurnUser?.content ?? "")).toContain("<subagent_notifications>")
    expect(String(secondTurnUser?.content ?? "")).toContain("generic subagent failed")

    // (d) runner remains parked — not respawned. One LiveAgent
    // services both turns.
    // (f) Only ONE startTurn across the scenario (the initial one).
    expect(runnerCreations).toBe(1)

    // (e) commitUserTurn ran exactly once — for the initial user text only.
    // The notification reached the tree via recordCanonicalMessage from the
    // agent loop's pushUser path, NOT via a second commitUserTurn from
    // submit. Single source of truth for user-turn entries.
    expect(commitUserTurnCalls).toEqual(["initial"])
    expect(parkedCount).toBeGreaterThanOrEqual(2)
    expect(logicalTurnCount).toBe(2)

    const interruptedTask = Promise.withResolvers<{ status: "completed"; content: string }>()
    capturedBackground?.tasks.track({
      done: interruptedTask.promise,
      meta: { id: "task-after-interrupt", type: "subagent", description: "Interrupted wait" },
    })
    deliverWhenSettled("task-after-interrupt", "Interrupted wait", interruptedTask.promise)
    expect(await session.send("continue after failed consultation")).toBe("accepted")
    await streamEntries[2]!.promise
    expect(runnerCreations).toBe(1)
    expect(logicalTurnCount).toBe(3)
    expect(JSON.stringify(calls[2])).toContain("continue after failed consultation")

    await waitingProjected.promise
    const interruptedPark = nextPark.promise
    expect(session.interrupt()).toBe(true)
    await interruptedPark
    expect(waitingOnBackgroundWork).toBe(false)

    const taskSettlementPark = nextPark.promise
    interruptedTask.resolve({ status: "completed", content: "result held for user" })

    await taskSettlementPark
    expect(waitingOnBackgroundWork).toBe(false)
    expect(calls).toHaveLength(3)
    expect(logicalTurnCount).toBe(3)
    expect(blockView.blocks()).toContainEqual(expect.objectContaining({ kind: "system", message: "Interrupted" }))

    const followUpPark = nextPark.promise
    expect(await session.send("continue after interrupt")).toBe("accepted")
    await Promise.race([streamEntries[3]!.promise, followUpPark])

    expect(turnEnds).toHaveLength(1)
    expect(calls).toHaveLength(4)
    expect(logicalTurnCount).toBe(4)
    expect(JSON.stringify(calls[3])).toContain("result held for user")
    expect(JSON.stringify(calls[3])).toContain("continue after interrupt")
  })

  it("leaves the wait once reconciliation delivers a paused child's completion past the registry", async () => {
    // A person paused the child, then stopped or deleted it. Its run settled
    // into the registry, and reconciliation, not the registry, delivers the
    // one completion to the runner. The turn it wakes must park idle.
    let streams = 0
    let capturedBackground: NonNullable<AgentOptions["runtimeSurfaces"]>["background"]
    let waitingOnBackgroundWork = false
    let nextPark = Promise.withResolvers<void>()
    const waitingProjected = Promise.withResolvers<void>()
    const createClient = async () => asModelClient({
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools(options: StreamOptions) {
        streams += 1
        yield { kind: "text_delta", text: `answer ${streams}`, blockKey: "b0" } as const
        if ((capturedBackground?.tasks.awaitedTaskCount() ?? 0) > 0) {
          expect(options.tools.some((tool) => tool.name === "process")).toBe(true)
          yield { kind: "tool_use", toolCall: { id: `wait-${streams}`, name: "process", input: { action: "wait", soft_timeout: 7200 } } } as const
          yield { kind: "done", stopReason: "tool_use" } as const
        } else {
          yield { kind: "done", stopReason: "end_turn" } as const
        }
      },
    })
    const eventBus = new EventBus()
    eventBus.subscribeToType("agent.turn.parked", () => {
      nextPark.resolve()
      nextPark = Promise.withResolvers<void>()
    })
    const blockView = captureBlocks((patch) => {
      if (patch.waitingOnBackgroundWork === undefined) return
      waitingOnBackgroundWork = patch.waitingOnBackgroundWork
      if (waitingOnBackgroundWork) waitingProjected.resolve()
    })
    const deps = createTestChatSessionDeps({
      sessionId: "chat-paused-child-stop",
      eventBus,
      createAgent: (options) => {
        capturedBackground = options.runtimeSurfaces?.background
        return newTestRunner(options, createClient)
      },
      updateEntry: blockView.updateEntry,
    })
    session = await createChatSession({ onError: () => {}, onEnded: () => {} }, deps)

    const initialPark = nextPark.promise
    expect(await session.send("delegate")).toBe("accepted")
    await initialPark
    capturedBackground?.tasks.track({
      done: Promise.resolve({ status: "stopped", content: "Stopped by the person." }),
      meta: { id: "child-run", type: "subagent", description: "review", toolUseId: "subagent-tool" },
    })
    expect(await session.send("wait for the review")).toBe("accepted")
    await waitingProjected.promise

    const deliveredPark = nextPark.promise
    expect(await session.deliverBackgroundNotification({
      key: "subagent-completions:child-run",
      text: "review stopped.",
      completionRunIds: ["child-run"],
    })).toBe(true)
    await deliveredPark

    expect(streams).toBe(3)
    expect(waitingOnBackgroundWork).toBe(false)
  })

  it("wakes the chat that owns a watch with each event as its own entry, and holds events while the chat is interrupted", async () => {
    const calls: ConversationMessage[][] = []
    let capturedBackground: NonNullable<AgentOptions["runtimeSurfaces"]>["background"]
    let nextPark = Promise.withResolvers<void>()
    const recorded: unknown[] = []
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
        yield { kind: "text_delta", text: `answer ${calls.length}`, blockKey: "b0" } as const
        if ((capturedBackground?.tasks.awaitedTaskCount() ?? 0) > 0) {
          yield { kind: "tool_use", toolCall: { id: `wait-${calls.length}`, name: "process", input: { action: "wait", soft_timeout: 600 } } } as const
          yield { kind: "done", stopReason: "tool_use" } as const
        } else {
          yield { kind: "done", stopReason: "end_turn" } as const
        }
      },
    })
    const eventBus = new EventBus()
    eventBus.subscribeToType("agent.turn.parked", () => {
      nextPark.resolve()
      nextPark = Promise.withResolvers<void>()
    })
    const deps = createTestChatSessionDeps({
      sessionId: "chat-watch-owner",
      eventBus,
      createAgent: (options) => {
        capturedBackground = options.runtimeSurfaces?.background
        return newTestRunner({
          ...options,
          onEvent: (event) => {
            if (event.type === "model.user_message.recorded") recorded.push(event.data)
            options.onEvent?.(event)
          },
        }, createClient)
      },
    })
    session = await createChatSession({ onError: () => {}, onEnded: () => {} }, deps)

    const initialPark = nextPark.promise
    expect(await session.send("start the watch")).toBe("accepted")
    await initialPark
    const tasks = capturedBackground!.tasks
    const meta = { id: "bash-bg-watch", type: "background_command", description: "tail -f app.log", notificationKey: "watch:bash-bg-watch:end", watch: true } as const
    const watchRun = Promise.withResolvers<BackgroundWorkResult>()
    tasks.track({ done: watchRun.promise, meta })
    expect(tasks.holdsWatchEvents()).toBe(false)

    // A resting chat: the event starts a request.
    const eventPark = nextPark.promise
    tasks.deliverWatchEvent(meta, { text: "ERROR one", position: 10, dropped: 0 })
    await eventPark
    expect(calls).toHaveLength(2)
    expect(String(calls[1]!.at(-1)?.content)).toContain("ERROR one")

    // The second request parked in a wait on the watch; the next event ends it.
    const waitPark = nextPark.promise
    tasks.deliverWatchEvent(meta, { text: "ERROR two", position: 20, dropped: 0 })
    await waitPark
    expect(calls).toHaveLength(3)
    expect(String(calls[2]!.at(-1)?.content)).toContain("ERROR two")
    expect(String(calls[2]!.at(-1)?.content)).not.toContain("ERROR one")
    expect(recorded).toContainEqual(expect.objectContaining({ message: expect.objectContaining({ origin: "system", backgroundNotificationIds: ["watch:bash-bg-watch:20"] }) }))

    const interruptedPark = nextPark.promise
    expect(session.interrupt()).toBe(true)
    await interruptedPark
    expect(tasks.holdsWatchEvents()).toBe(true)
    // A held event is refused, so the watch keeps it and its place.
    expect(tasks.deliverWatchEvent(meta, { text: "ERROR held", position: 30, dropped: 0 })).toBe(false)

    expect(await session.send("go on")).toBe("accepted")
    await nextPark.promise
    expect(tasks.holdsWatchEvents()).toBe(false)
    expect(calls.flat().some((message) => String(message.content).includes("ERROR held"))).toBe(false)
    watchRun.resolve({ status: "completed", content: "<watch_ended>done</watch_ended>" })
  })

  it("holds a watch's events while a question waits for the person, and delivers again once it is answered", async () => {
    let capturedBackground: NonNullable<AgentOptions["runtimeSurfaces"]>["background"]
    let nextPark = Promise.withResolvers<void>()
    let requests = 0
    const createClient = async () => asModelClient({
      accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test", contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false,
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools() {
        requests += 1
        if (requests === 1) {
          yield { kind: "tool_use", toolCall: { id: "ask-1", name: "ask_user", input: { context: "One decision is needed.", question: "Proceed?", header: "Go", options: [{ label: "Yes" }, { label: "No" }] } } } as const
          yield { kind: "done", stopReason: "tool_use" } as const
          return
        }
        yield { kind: "text_delta", text: "Done.", blockKey: "b0" } as const
        yield { kind: "done", stopReason: "end_turn" } as const
      },
    })
    const eventBus = new EventBus()
    eventBus.subscribeToType("agent.turn.parked", () => {
      nextPark.resolve()
      nextPark = Promise.withResolvers<void>()
    })
    session = await createChatSession({ onError: () => {}, onEnded: () => {} }, createTestChatSessionDeps({
      sessionId: "chat-watch-question",
      eventBus,
      createAgent: (options) => {
        capturedBackground = options.runtimeSurfaces?.background
        return newTestRunner(options, createClient)
      },
    }))
    void session.send("ask me")
    const deadline = Date.now() + 3_000
    while (capturedBackground?.tasks.holdsWatchEvents() !== true && Date.now() < deadline) await Bun.sleep(5)
    const tasks = capturedBackground!.tasks
    const meta = { id: "bash-bg-q", type: "background_command", description: "tail -f app.log", notificationKey: "watch:bash-bg-q:end", watch: true } as const
    const watchRun = Promise.withResolvers<BackgroundWorkResult>()
    tasks.track({ done: watchRun.promise, meta })
    expect(tasks.holdsWatchEvents()).toBe(true)
    expect(tasks.deliverWatchEvent(meta, { text: "ERROR q", position: 5, dropped: 0 })).toBe(false)

    const answered = nextPark.promise
    session.answerQuestion("ask-1", { "Proceed?": { kind: "freeform", text: "Yes" } })
    await answered
    expect(tasks.holdsWatchEvents()).toBe(false)
    watchRun.resolve({ status: "completed", content: "<watch_ended>done</watch_ended>" })
  })

  const temporary = temporaryDirectories()
  it("holds a watch's events in a chat whose stored turn end is an interruption, with no turn in the slot, and paints the event that wakes it after Resume as a live row", async () => {
    const projectRoot = temporary("chat-watch-stored-interrupt-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const capture = captureBlocks()
    const { chat, calls, parked } = await createStoredChatSession({
      sessionId: "chat-watch-stored", conversationId: "conversation-watch-stored", projectRoot,
      reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store),
      seed: async (tree) => {
        await tree.appendMessage({ kind: "user", content: "watch the log", origin: "human" })
        await appendTurnEnd(tree, interruptedTurnEnd("close"))
      },
      overrides: { updateEntry: capture.updateEntry },
    })
    const meta = { id: "bash-bg-stored", type: "background_command", description: "tail -f app.log", notificationKey: "watch:bash-bg-stored:end", watch: true } as const
    const watchRun = Promise.withResolvers<BackgroundWorkResult>()
    try {
      // The runner attaches with no turn in the slot, as an adopted chat's does.
      // The chat's tracking port is its registry, which a watch reaches whole.
      const tasks = chat.backgroundTasks
      if (!isBackgroundWorkRegistry(tasks)) throw new Error("the chat's tracking port is not its registry")
      tasks.track({ done: watchRun.promise, meta })
      await Bun.sleep(20)
      expect(tasks.holdsWatchEvents()).toBe(true)
      const event = { text: "ERROR stored", position: 13, dropped: 0 }
      expect(tasks.deliverWatchEvent(meta, event)).toBe(false)
      await Bun.sleep(20)
      expect(calls).toHaveLength(0)

      expect(chat.resume({ announce: false })).toBe(true)
      await parked(1)
      expect(tasks.holdsWatchEvents()).toBe(false)
      const requests = calls.length
      expect(tasks.deliverWatchEvent(meta, event)).toBe(true)
      await parked(2)
      expect(calls).toHaveLength(requests + 1)
      expect(JSON.stringify(calls.at(-1))).toContain("ERROR stored")
      const rows = capture.blocks().filter((block) => block.kind === "system" && block.watch !== undefined)
      expect(rows).toEqual([expect.objectContaining({ kind: "system", id: "watch:bash-bg-stored:13", message: "ERROR stored", watch: { processId: "bash-bg-stored", description: "tail -f app.log", kind: "event" } })])
    } finally {
      watchRun.resolve({ status: "completed", content: "" })
      await chat.dispose()
      store.close()
    }
  })
})

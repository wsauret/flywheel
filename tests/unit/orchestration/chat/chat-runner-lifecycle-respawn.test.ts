import { describe, expect, it } from "bun:test"

import { EventBus } from "../../../../src/infra/event-bus"
import { asAsyncEventReadSurface, asAsyncEventWriter, type StoredFact } from "../../../../src/infra/event-store-types"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { temporaryDirectories } from "../../../helpers/directories"
import { createChatRunnerLifecycle } from "../../../../src/orchestration/chat/runner-lifecycle"
import { createChatControls } from "../../../../src/orchestration/chat/controls"
import { ChatSessionState } from "../../../../src/orchestration/chat/types"
import type { AgentRunResult, Agent, AgentOptions } from "../../../../src/orchestration/agent-runtime/types"
import type { BackgroundWorkResult } from "../../../../src/orchestration/agent-runtime/background-work"
import type { ProviderRequestOptions } from "../../../../src/infra/llm/provider-options"
import {
  askUserStub,
  createTestChatSessionDeps,
  makeMemoryTreeWriter,
  outputSessionStub,
} from "./_chat-session-agent-runtime-fixtures"
import { flushMicrotasks, makeLifecycle, useStore } from "./_chat-runner-lifecycle-fixtures"

interface MutableRoleSelection {
  model: string
  providerOptions?: ProviderRequestOptions
}

describe("chat runner lifecycle definition ownership", () => {
  it("supplies the ProjectDefinitionRegistry persona revision to every runner", async () => {
    const { lifecycle, deps, runnerOptions } = makeLifecycle()
    lifecycle.enqueueInput("start")
    await flushMicrotasks()

    expect(runnerOptions[0]?.agentRegistry).toBe(deps.definitions.personas())
  })

  it("retains the session durability barrier across runner respawns", async () => {
    const { lifecycle, resolvers, runnerOptions, awaitDurableFacts } = makeLifecycle()
    lifecycle.enqueueInput("first")
    await flushMicrotasks()
    lifecycle.enqueueInput("queued")
    resolvers[0]?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "api_error", message: "failed", recovery: { kind: "none" } } })
    await flushMicrotasks()

    expect(runnerOptions).toHaveLength(2)
    expect(runnerOptions.every((options) =>
      options.conversation.kind === "durable-tree"
      && options.conversation.awaitDurableFacts === awaitDurableFacts,
    )).toBe(true)
  })
})

const makeDirectory = temporaryDirectories()

describe("chat runner lifecycle stranded-input respawn", () => {

  it("returns control after failed preparation without retrying unchanged queued input", async () => {
    const { lifecycle, deps, state, runnerOptions, resolvers, failures } = makeLifecycle()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const resolveRoles = deps.resolveRoles
    let preparations = 0
    let fail = true
    deps.resolveRoles = async () => {
      preparations += 1
      if (fail) {
        entered.resolve()
        await release.promise
        // Bound the broken implementation without a timer or a hot retry loop.
        if (preparations > 1) state.end()
        throw new Error("startup context unavailable")
      }
      return resolveRoles()
    }
    try {
      lifecycle.requestWithContext({ text: "goal", invocation: { label: "/experiment start" } }, "private context")
      await entered.promise
      await lifecycle.enqueueInput("queued while preparing")
      release.resolve()
      await lifecycle.settle()
      await flushMicrotasks()

      expect(preparations).toBe(1)
      expect(failures).toHaveLength(1)
      expect(runnerOptions).toHaveLength(0)
      expect(lifecycle.turnState).toBe("idle")

      fail = false
      await lifecycle.enqueueInput("explicit retry")
      await flushMicrotasks()
      expect(runnerOptions).toHaveLength(1)
    } finally {
      state.end()
      release.resolve()
      resolvers.at(-1)?.({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } })
      await lifecycle.settle()
      await lifecycle.terminateBackgroundWorks()
    }
  })

  it("does not restart after an accepted interrupt during preparation", async () => {
    const { lifecycle, deps, state, runnerOptions, runnerStarted, resolvers, failures } = makeLifecycle()
    const projectRoot = makeDirectory("flywheel-startup-interrupt-")
    const store = useStore(deps, projectRoot)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const notificationEntered = Promise.withResolvers<void>()
    const notificationRelease = Promise.withResolvers<void>()
    const resolveRoles = deps.resolveRoles
    const commitTurnEnd = deps.treeWriter.commitTurnEnd
    const interruptions: string[] = []
    deps.treeWriter.commitTurnEnd = async (by) => {
      interruptions.push(by)
      return commitTurnEnd(by)
    }
    let preparations = 0
    deps.resolveRoles = async () => {
      preparations += 1
      entered.resolve()
      await release.promise
      return resolveRoles()
    }
    try {
      lifecycle.requestWithContext({ text: "goal", invocation: { label: "/experiment start" } }, "private context")
      await entered.promise
      await lifecycle.enqueueInput("queued before interrupt")
      expect(lifecycle.interruptGeneration()).toBe(true)
      release.resolve()
      await lifecycle.settle()
      await flushMicrotasks()

      expect(preparations).toBe(1)
      expect(runnerOptions).toHaveLength(0)
      expect(failures).toEqual([])
      expect(interruptions).toEqual(["person"])
      expect(lifecycle.turnState).toBe("idle")

      await lifecycle.deliverBackgroundNotification({ key: "late-result", text: "background completed" })
      await flushMicrotasks()
      expect(preparations).toBe(1)
      expect(runnerOptions).toHaveLength(0)
      expect(lifecycle.recallQueuedUserInput()).toEqual({ text: "queued before interrupt" })

      const commitNotification = deps.treeWriter.commitBackgroundNotification
      deps.treeWriter.commitBackgroundNotification = async (notification) => {
        notificationEntered.resolve()
        await notificationRelease.promise
        return commitNotification(notification)
      }
      const delivering = lifecycle.deliverBackgroundNotification({ key: "next-result", text: "next background completed" })
      await notificationEntered.promise
      await lifecycle.enqueueInput("explicit retry during notification commit")
      notificationRelease.resolve()
      await delivering
      // The real tree builds context in task slices. On a loaded CPU a slice
      // yields to later host tasks, past any fixed flush, so wait for the runner.
      await runnerStarted
      expect(runnerOptions).toHaveLength(1)
    } finally {
      state.end()
      release.resolve()
      notificationRelease.resolve()
      resolvers.at(-1)?.({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } })
      await lifecycle.settle()
      await lifecycle.terminateBackgroundWorks()
      await deps.treeWriter.dispose()
      store.close()
    }
  })

  it.each(["failure notice", "failed teardown", "interrupted teardown"] as const)(
    "starts a fresh runner after durable teardown for public input accepted during %s",
    async (arrival) => {
      const { lifecycle, deps, state, session, runnerOptions, runnerStarted, resolvers, failures, eventBus } = makeLifecycle()
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const teardownEntered = Promise.withResolvers<void>()
      const teardownRelease = Promise.withResolvers<void>()
      const oldInputAccepted = Promise.withResolvers<void>()
      const newInputAccepted = Promise.withResolvers<void>()
      const resolveRoles = deps.resolveRoles
      let preparations = 0
      deps.resolveRoles = async () => {
        preparations += 1
        if (preparations === 1) {
          entered.resolve()
          await release.promise
          if (arrival !== "interrupted teardown") throw new Error("startup context unavailable")
        }
        return resolveRoles()
      }
      const endTurn = deps.treeWriter.endTurn
      let teardownCompleted = false
      deps.treeWriter.endTurn = async () => {
        teardownEntered.resolve()
        await teardownRelease.promise
        await endTurn()
        teardownCompleted = true
      }
      const enqueueInput = lifecycle.enqueueInput
      lifecycle.enqueueInput = (input) => {
        enqueueInput(input)
        const text = typeof input === "string" ? input : input.text
        if (text === "queued before startup stopped") oldInputAccepted.resolve()
        if (text === "later explicit input") newInputAccepted.resolve()
      }
      const controls = createChatControls({
        lifecycle, session, state, treeWriter: deps.treeWriter,
        callbacks: { onError() {}, onEnded() {} }, eventUnsubs: [],
        onTreeFailure: deps.onTreeFailure, drainEvents: () => eventBus.drain(),
        recordInterruption() {}, supersedeInterruptedTurn() {},
      })
      const pushSystemMessage = session.pushSystemMessage
      session.pushSystemMessage = (message) => {
        pushSystemMessage(message)
        if (arrival === "failure notice") controls.send("later explicit input")
      }
      try {
        lifecycle.requestWithContext({ text: "goal", invocation: { label: "/experiment start" } }, "private context")
        await entered.promise
        controls.send("queued before startup stopped")
        await oldInputAccepted.promise
        if (arrival === "interrupted teardown") expect(controls.interrupt()).toBe(true)
        release.resolve()
        await teardownEntered.promise
        if (arrival !== "failure notice") controls.send("later explicit input")
        await newInputAccepted.promise

        expect(preparations).toBe(1)
        expect(runnerOptions).toHaveLength(0)
        expect(teardownCompleted).toBe(false)
        teardownRelease.resolve()
        await lifecycle.settle()
        expect(lifecycle.turnState).toBe("active")
        await runnerStarted

        expect(teardownCompleted).toBe(true)
        expect(preparations).toBe(2)
        expect(runnerOptions).toHaveLength(1)
        expect(failures).toHaveLength(1)
        expect(runnerOptions[0]?.lifecycle.inputSource?.drainPending?.()).toMatchObject({
          kind: "message", origin: "human", text: "queued before startup stopped",
        })
        expect(runnerOptions[0]?.lifecycle.inputSource?.drainPending?.()).toMatchObject({
          kind: "message", origin: "human", text: "later explicit input",
        })
      } finally {
        state.end()
        release.resolve()
        teardownRelease.resolve()
        resolvers.at(-1)?.({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } })
        await lifecycle.settle()
        await lifecycle.terminateBackgroundWorks()
      }
    },
  )

  it("publishes resumed activity when committed input starts an idle runner", async () => {
    const { lifecycle, resolvers, eventBus } = makeLifecycle()
    const resumed: string[] = []
    eventBus.subscribeToType("agent.turn.resumed", (event) => { resumed.push(event.type) }, {
      deliveryClass: "ui",
      delivery: "direct",
    })

    expect(lifecycle.resumeCommitted()).toBe(true)
    expect(resumed).toEqual(["agent.turn.resumed"])

    resolvers[0]?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
    await flushMicrotasks()
  })

  it("respawns a runner for a message submitted while a failed turn tears down", async () => {
    const { lifecycle, resolvers, sends } = makeLifecycle()

    lifecycle.enqueueInput("first message")
    await flushMicrotasks()
    expect(resolvers.length).toBe(1)

    // Submitted while the turn slot is still occupied: parks in the mailbox.
    lifecycle.enqueueInput("retry after the failure")
    await flushMicrotasks()
    expect(resolvers.length).toBe(1)

    // The turn dies with a non-retryable terminal (e.g. the provider fatal
    // that previously left the session "down" with the message stranded).
    resolvers[0]?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "api_error", message: "Overloaded", recovery: { kind: "none" } } })
    await flushMicrotasks()

    // The stranded mailbox input respawned a fresh runner: the queued message
    // becomes the retry instead of sitting unconsumed forever.
    expect(resolvers.length).toBe(2)
    // The respawn's typed wake must still start the runner's loop (only
    // send() starts it); otherwise the mailbox input is never drained.
    expect(sends[1]).toEqual([{ kind: "wake" }])
  })

  it("does not respawn when the mailbox is empty at teardown", async () => {
    const { lifecycle, resolvers } = makeLifecycle()

    lifecycle.enqueueInput("only message")
    await flushMicrotasks()
    expect(resolvers.length).toBe(1)

    resolvers[0]?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "api_error", message: "Overloaded", recovery: { kind: "none" } } })
    await flushMicrotasks()

    expect(resolvers.length).toBe(1)
  })

  it("delivers held workflow completions as distinct background notifications", async () => {
    const { lifecycle, resolvers, runnerOptions } = makeLifecycle()

    lifecycle.enqueueInput("review the workflow")
    await flushMicrotasks()
    expect(await lifecycle.deliverBackgroundNotification({
      key: "workflow-completion:first",
      text: "First workflow completed.",
    })).toBe(true)
    expect(await lifecycle.deliverBackgroundNotification({
      key: "workflow-completion:second",
      text: "Second workflow completed.",
    })).toBe(true)
    expect(runnerOptions[0]?.lifecycle.inputSource?.drainPending?.()).toEqual({
      kind: "message",
      origin: "silent-system",
      text: "First workflow completed.",
      backgroundNotificationIds: ["workflow-completion:first"],
    })
    expect(runnerOptions[0]?.lifecycle.inputSource?.drainPending?.()).toEqual({
      kind: "message",
      origin: "silent-system",
      text: "Second workflow completed.",
      backgroundNotificationIds: ["workflow-completion:second"],
    })

    resolvers[0]?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
    await flushMicrotasks()
  })

  it("does not respawn when the session has ended, even with pending input", async () => {
    const { lifecycle, resolvers, state } = makeLifecycle()

    lifecycle.enqueueInput("first message")
    await flushMicrotasks()
    expect(resolvers.length).toBe(1)

    lifecycle.enqueueInput("arrives during shutdown")
    state.end()
    resolvers[0]?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } })
    await flushMicrotasks()

    expect(resolvers.length).toBe(1)
  })

  it("terminates and awaits every task in the chat registry", async () => {
    const { lifecycle, background } = makeLifecycle()
    lifecycle.enqueueInput("start")
    await flushMicrotasks()
    const owner = background()
    if (!owner) throw new Error("expected chat background owner")
    const done = Promise.withResolvers<BackgroundWorkResult>()
    const calls: string[] = []
    owner.tasks.track({
      done: done.promise,
      meta: { id: "bg-1", type: "background_command", description: "test" },
      kill: { run: () => { calls.push("terminate") } },
    })

    let settled = false
    const terminating = lifecycle.terminateBackgroundWorks().then(() => { settled = true })
    // The kill lands once close reaches the registry, which is after it drained
    // the dispatches it had admitted.
    await Bun.sleep(1)
    expect(calls).toEqual(["terminate"])
    expect(settled).toBe(false)

    done.resolve({ status: "failed", content: "terminated" })
    await terminating
    expect(settled).toBe(true)
  })

  it("retains the runner and background work across request selection changes", async () => {
    const roleRef: MutableRoleSelection = { model: "model-a" }
    const aborts: number[] = []
    const resolvers: Array<(result: AgentRunResult) => void> = []
    const runnerOptions: AgentOptions[] = []
    let activeRunners = 0
    const createAgent = (options: AgentOptions): Agent => {
      runnerOptions.push(options)
      activeRunners += 1
      const runAbort = new AbortController()
      let settle!: (result: AgentRunResult) => void
      const done = new Promise<AgentRunResult>((resolve) => {
        settle = (result) => {
          activeRunners -= 1
          resolve(result)
        }
        resolvers.push(settle)
      })
      // The abort signal releases the mailbox waiter, like the real loop.
      const park = async (): Promise<void> => {
        const inputSource = options.lifecycle.inputSource
        if (!inputSource) throw new Error("expected lifecycle input source")
        while (await inputSource.prepareWaitForInput?.(runAbort.signal).commit()) { /* consume and re-park */ }
      }
      return {
        send() { void park() },
        end() {},
        abort() {
          runAbort.abort()
          aborts.push(resolvers.length)
          resolvers[resolvers.length - 1]?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } })
        },
        done,
      }
    }
    const deps = createTestChatSessionDeps({
      sessionId: "session-respawn",
      createAgent,
      treeWriter: makeMemoryTreeWriter(),
      resolveRoles: async () => new Map([
        ["chat", { roleId: "chat", model: roleRef.model, effort: "high", providerOptions: roleRef.providerOptions }],
      ]),
    })
    const nestedEvent: StoredFact = {
      aggregateId: "session-respawn",
      type: "tool.execution.completed",
      version: 1,
      timestamp: 1,
      actor: "test",
      sessionId: "session-respawn",
      payload: {},
      position: 1,
      id: "event-1",
      seq: 0,
    }
    const projectedNestedEvents: StoredFact[] = []
    deps.infra.toolExecutionStore.applyStoredFact = async (event) => { projectedNestedEvents.push(event) }
    const state = new ChatSessionState(undefined, () => {})
    const eventBus = new EventBus()
    const busEvents: Array<{ type: string; sessionId?: string }> = []
    eventBus.subscribe((event) => { busEvents.push({ type: event.type, sessionId: event.sessionId }) })
    const lifecycle = createChatRunnerLifecycle({
      deps,
      eventBus,
      session: outputSessionStub("session-respawn"),
      applyNestedStoredFact: (event) => { deps.infra.toolExecutionStore.applyStoredFact(event) },
      state,
      askUser: askUserStub(),
      setConnectionState() {},
      awaitDurableFacts: async () => {},
    })

    lifecycle.enqueueInput("first message")
    await flushMicrotasks()
    expect(resolvers.length).toBe(1)
    runnerOptions[0]?.applyNestedStoredFact?.(nestedEvent)
    expect(projectedNestedEvents).toEqual([nestedEvent])
    const owner = runnerOptions[0]?.runtimeSurfaces?.background
    if (!owner) throw new Error("expected chat background owner")

    // A subagent-like background task is in flight when the assignment changes.
    const kills: string[] = []
    const task = Promise.withResolvers<BackgroundWorkResult>()
    owner.tasks.track({
      done: task.promise,
      meta: { id: "sub-1", type: "subagent", description: "test" },
      kill: { run: () => { kills.push("sub-1"); task.resolve({ status: "failed", content: "killed" }) } },
    })
    const foregroundOwner = runnerOptions[0]?.runtimeSurfaces?.foregroundBashHold
    expect(foregroundOwner).toBeDefined()

    const captureSelection = async () => runnerOptions[0]?.requestSelection?.(await deps.resolveRoles())
    for (const model of ["model-b", "model-c", "model-d", "model-e"]) {
      roleRef.model = model
      lifecycle.enqueueInput(`message for ${model}`)
      await flushMicrotasks()
      expect(activeRunners).toBe(1)
      expect((await captureSelection())?.model).toBe(model)
      expect(runnerOptions.at(-1)?.runtimeSurfaces?.background).toBe(owner)
      expect(runnerOptions.at(-1)?.runtimeSurfaces?.foregroundBashHold).toBe(foregroundOwner)
      expect(owner.signal.aborted).toBe(false)
    }

    roleRef.providerOptions = { openai: { service_tier: "priority" } }
    lifecycle.enqueueInput("message for new provider options")
    await flushMicrotasks()
    expect(activeRunners).toBe(1)
    expect(await captureSelection()).toMatchObject({ model: roleRef.model, providerOptions: roleRef.providerOptions })

    expect(aborts).toEqual([])
    expect(resolvers.length).toBe(1)
    expect(kills).toEqual([])

    // Model changes preserve the background owner's event delivery.
    runnerOptions[0]?.onBackgroundEvent?.({
      type: "tool.execution_output.recorded",
      data: { tool_use_id: "toolu_sub-1", output: "terminal tail" },
    })
    await flushMicrotasks()
    const recordedEvent = busEvents.find((event) => event.type === "tool.execution_output.recorded")
    expect(recordedEvent).toEqual({ type: "tool.execution_output.recorded", sessionId: "session-respawn" })

    resolvers.at(-1)?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
    await lifecycle.settle()
    expect(activeRunners).toBe(0)

    // Session end is the blanket kill switch for background work. The kill lands
    // after close drains the dispatches it admitted, and the work settles in
    // response to it.
    const terminated = lifecycle.terminateBackgroundWorks()
    await Bun.sleep(1)
    task.resolve({ status: "failed", content: "terminated" })
    await terminated
    expect(kills).toEqual(["sub-1"])
    expect(runnerOptions.at(-1)?.runtimeSurfaces?.background?.signal.aborted).toBe(true)
  })
})

describe("chat runner lifecycle background notification turn gate", () => {
  /** Holds the lifecycle's turn-end read until the test releases it, and
   *  fails it instead when `fail` is given. */
  function holdTurnEndRead(deps: ReturnType<typeof makeLifecycle>["deps"], fail?: Error) {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const base = deps.infra.projectionReader
    deps.infra.projectionReader = {
      ...base,
      readSlice: async (query, tolerant) => {
        entered.resolve()
        await release.promise
        if (fail) throw fail
        return base.readSlice(query, tolerant)
      },
    }
    return { entered: entered.promise, release: () => release.resolve() }
  }

  it("starts no turn and reports the end once when the runner ends while the turn-end read is in flight", async () => {
    const { lifecycle, deps, state, session, callbacks, ended, eventBus, runnerOptions } = makeLifecycle()
    const controls = createChatControls({
      lifecycle, session, state, treeWriter: deps.treeWriter, callbacks, eventUnsubs: [],
      onTreeFailure: deps.onTreeFailure, drainEvents: () => eventBus.drain(),
      recordInterruption() {}, supersedeInterruptedTurn() {},
    })
    const read = holdTurnEndRead(deps)

    const delivering = lifecycle.deliverBackgroundNotification({ key: "late", text: "background completed" })
    await read.entered
    // The held reservation makes the runner look busy to end(), but no turn
    // runs to report the end, so end() must report it itself.
    const ending = controls.end()
    read.release()

    expect(await delivering).toBe(true)
    await ending
    expect(runnerOptions).toHaveLength(0)
    expect(lifecycle.turnState).toBe("idle")
    expect(ended.count).toBe(1)
  })

  it("reports the end once when the runner ends during a running turn", async () => {
    const { lifecycle, deps, state, session, callbacks, ended, eventBus, resolvers } = makeLifecycle()
    const controls = createChatControls({
      lifecycle, session, state, treeWriter: deps.treeWriter, callbacks, eventUnsubs: [],
      onTreeFailure: deps.onTreeFailure, drainEvents: () => eventBus.drain(),
      recordInterruption() {}, supersedeInterruptedTurn() {},
    })
    lifecycle.enqueueInput("first message")
    await flushMicrotasks()
    expect(resolvers).toHaveLength(1)

    const ending = controls.end()
    resolvers[0]?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } })
    await ending

    expect(ended.count).toBe(1)
  })

  it("leaves a notification that lands after an unexpected exit for the person: no turn starts until a message", async () => {
    const { lifecycle, deps, state, runnerOptions, runnerStarted, resolvers } = makeLifecycle()
    const projectRoot = makeDirectory("flywheel-crash-gate-")
    const store = useStore(deps, projectRoot)
    try {
      // The process died with the person's message unanswered, and recovery
      // recorded the unexpected exit.
      await deps.treeWriter.commitUserTurn("do the work")
      const tree = await tryOpenConversationTree({ conversationId: deps.conversationId, sessionId: deps.sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
      if (!tree) throw new Error("the conversation did not open")
      await tree.recordInterruptedTurn("crash", { ownerDead: true })
      tree.getStorage().dispose()

      expect(await lifecycle.deliverBackgroundNotification({ key: "workflow-completion:child", text: "Workflow completed" })).toBe(true)
      await flushMicrotasks()
      expect(runnerOptions).toHaveLength(0)
      expect(lifecycle.turnState).toBe("idle")

      lifecycle.enqueueInput("continue")
      // The real tree builds context in task slices. On a loaded CPU a slice
      // yields to later host tasks, past any fixed flush, so wait for the runner.
      await runnerStarted
      expect(runnerOptions).toHaveLength(1)
    } finally {
      state.end()
      resolvers.at(-1)?.({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } })
      await lifecycle.settle()
      await lifecycle.terminateBackgroundWorks()
      await deps.treeWriter.dispose()
      store.close()
    }
  })

  it("leaves a committed notification for the person when its turn end cannot be read", async () => {
    const { lifecycle, deps, state, runnerOptions, resolvers } = makeLifecycle()
    const read = holdTurnEndRead(deps, new Error("project state request refused: pressure"))
    try {
      const delivering = lifecycle.deliverBackgroundNotification({ key: "late", text: "background completed" })
      await read.entered
      read.release()

      expect(await delivering).toBe(true)
      await flushMicrotasks()
      expect(runnerOptions).toHaveLength(0)
      expect(lifecycle.turnState).toBe("idle")

      // The turn slot is free again, so the person's next message starts a turn.
      lifecycle.enqueueInput("next message")
      await flushMicrotasks()
      expect(runnerOptions).toHaveLength(1)
    } finally {
      state.end()
      resolvers.at(-1)?.({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } })
      await lifecycle.settle()
      await lifecycle.terminateBackgroundWorks()
    }
  })
})

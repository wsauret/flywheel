/**
 * Tests for Reactive Session Store — createStore-backed implementation.
 *
 * Verifies that the sessionStore uses SolidJS reactive primitives:
 * - Store-backed entries (createStore)
 * - Reactive get() returns proxy that tracks in memos
 * - Discriminated union: workflow entries have steps, chat entries do not
 * - Mutations via store handle are visible to reactive consumers
 */

import { afterAll, describe, it, expect, mock, spyOn } from "bun:test"
import { createRoot } from "solid-js"
import type { AnyBlock } from "../../../../src/infra/output-blocks"
import type { SessionStore } from "../../../../src/orchestration/session-store/types"
import type { ChatRunner } from "../../../../src/orchestration/chat/runner-types"
import { NO_MODULE_RUNTIMES } from "../../../../src/infra/module-runtime"
import { DebugLog, type DebugLogRecordInput } from "../../../../src/infra/debug-log"
import { EventReaderService, EventStoreWriterService } from "../../../../src/infra/event-store-effect"
import { createSessionStore } from "../../../../src/orchestration/session-store/store"
import { createSessionStoreTestContext } from "./_session-store-fixtures"
import { registerLiveSessionControl } from "../../../../src/orchestration/session/live-session-control.js"
import { createForegroundBashHoldController } from "../../../../src/orchestration/agent-runtime/foreground-bash-hold.js"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work"

const { runtime, cleanup } = createSessionStoreTestContext()
afterAll(cleanup)

// ── Helpers ──

function createMockChatRunner(sessionId: string): ChatRunner & { calls: string[] } {
  const calls: string[] = []
  return {
    sessionId,
    chatModuleHosts: NO_MODULE_RUNTIMES,
    backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }),
    applyProjectionEvent: () => {},
    abort: () => { calls.push("abort") },
    interrupt: () => false,
    resume: () => { calls.push("resume"); return true },
    terminateBackgroundWork: (toolUseId: string) => { calls.push(`terminate:${toolUseId}`) },
    releaseForegroundBash: () => false,
    transferForegroundForReplacement: async () => {},
    adoptHandedOver: async () => {},
    dispose: async () => { calls.push("dispose") },
    send: async (text: string) => { calls.push(`send:${text}`); return "accepted" },
    deliverHeldMessage: async () => ({ status: "held", reason: "no_reader" }), messageState: async () => "at_rest",
    recallQueuedMessage: () => null,
    compact: async () => { calls.push("compact"); return false },
    awaitTurnSettlement: async () => {},
    awaitLogicalTurnDurability: async () => {},
    deliverCommitted: () => true,
    deliverBackgroundNotification: async () => true,
    requestWithContext: () => true,
    answerQuestion: () => {},
    cancelQuestion: () => {},
    resumeCommitted: () => false,
    awaitOwedCapacity: async () => false,
    setShown: () => {},
    holdsRunningTurn: () => false,
    prepareForShutdown: () => {},
    interruptForReplacement: async () => false,
    interruptPlannedCut: async () => "running",
    hold: async () => NO_MODULE_RUNTIMES,
    capabilities: async () => () => true,
    seedDisplayBlocks: () => {},
    calls,
  }
}

/** Production protocol in miniature: open the shell entry, then attach the
 *  live runner (shell-then-attach; there is no one-shot spawn path). */
function attachChat(sessionStore: SessionStore, sessionId: string, runner: ChatRunner): void {
  sessionStore.openSessionRuntime({ sessionId, conversationId: `conv-${sessionId}` })
  if (!sessionStore.attachChatRunner(sessionId, runner)) throw new Error(`attachChatRunner refused for ${sessionId}`)
}

describe("Reactive SessionStore — store-backed", () => {
  it("starts the activity clock only when the reported activity changes", () => {
    const clock = spyOn(Date, "now").mockReturnValue(1000)
    const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
    try {
      attachChat(sessionStore, "activity-clock", createMockChatRunner("activity-clock"))
      sessionStore.updateChatEntry("activity-clock", { runnerState: "streaming", streamPhase: "thinking" })
      expect(sessionStore.get("activity-clock")?.activityStartedAt).toBe(1000)
      clock.mockReturnValue(9000)
      sessionStore.updateChatEntry("activity-clock", { tokens: 500, streamPhase: "thinking" })
      expect(sessionStore.get("activity-clock")?.activityStartedAt).toBe(1000)
      sessionStore.updateChatEntry("activity-clock", { streamPhase: "generating" })
      expect(sessionStore.get("activity-clock")?.activityStartedAt).toBe(9000)
      clock.mockReturnValue(12000)
      sessionStore.updateChatEntry("activity-clock", { streamPhase: "tool_executing" })
      expect(sessionStore.get("activity-clock")?.activityStartedAt).toBe(12000)
      clock.mockReturnValue(15000)
      sessionStore.updateChatEntry("activity-clock", { runnerState: "idle", waitingOnBackgroundWork: true })
      expect(sessionStore.get("activity-clock")?.activityStartedAt).toBe(15000)
    } finally {
      clock.mockRestore()
    }
  })

  it("routes targeted background termination to the exact chat runner without interrupting the turn", async () => {
    const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const runner = createMockChatRunner("chat-bg")
    attachChat(sessionStore, "chat-bg", runner)

    sessionStore.terminateBackgroundWork("other-session", "target")
    sessionStore.terminateBackgroundWork("chat-bg", "wrong")
    sessionStore.terminateBackgroundWork("chat-bg", "target")
    expect(runner.calls).toEqual(["terminate:wrong", "terminate:target"])
    await sessionStore.remove("chat-bg")
  })

  it("reports active sessions that reject dependency refresh", async () => {
    const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
    attachChat(sessionStore, "refresh-failure", {
      ...createMockChatRunner("refresh-failure"),
      refreshDeps: async () => { throw new Error("refresh failed") },
    })

    await expect(sessionStore.refreshDeps()).rejects.toThrow("refresh-failure")
  })

  it("refreshes dependencies only for named sessions", async () => {
    const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const target = createMockChatRunner("refresh-target")
    const other = createMockChatRunner("refresh-other")
    target.refreshDeps = async () => { target.calls.push("refresh") }
    other.refreshDeps = async () => { other.calls.push("refresh") }
    attachChat(sessionStore, "refresh-target", target)
    attachChat(sessionStore, "refresh-other", other)

    await sessionStore.refreshDeps(["refresh-target"])

    expect(target.calls).toEqual(["refresh"])
    expect(other.calls).toEqual([])
  })

  it("routes foreground Bash release to the exact live workflow member and projects its active IDs", async () => {
    const reader = runtime.runSync(EventReaderService)
    const sessionStore = createSessionStore(runtime, reader)
    const sessionId = "workflow-foreground-bash"
    sessionStore.openSessionRuntime({ sessionId, kind: "workflow-agent", workflowId: "workflow", conversationId: "agent-conversation" })
    const controller = createForegroundBashHoldController(ids => sessionStore.updateEntry(sessionId, { activeForegroundBashToolCallIds: ids }))
    const unregister = registerLiveSessionControl(reader, {
      sessionId, state: async () => "running", deliver: async (_input, decide) => decide("running"), notify: async () => false,
      member: {
        modules: async () => NO_MODULE_RUNTIMES, backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }),
        compact: async () => false, interrupt: () => false, terminateBackgroundWork: () => {},
        releaseForegroundBash: id => controller.release(id), transferForegroundForReplacement: () => controller.transferForReplacement(),
      },
    })
    const hold = controller.register("toolu_workflow_bash")

    expect(sessionStore.get(sessionId)?.activeForegroundBashToolCallIds).toEqual(["toolu_workflow_bash"])
    expect(sessionStore.releaseForegroundBash(sessionId, "toolu_workflow_bash")).toBe(true)
    expect(sessionStore.get(sessionId)?.activeForegroundBashToolCallIds).toEqual([])
    await expect(hold.released).resolves.toBe("user_detach")
    expect(sessionStore.releaseForegroundBash(sessionId, "toolu_workflow_bash")).toBe(false)
    expect(sessionStore.releaseForegroundBash("missing", "toolu_workflow_bash")).toBe(false)

    // The detached command reports once the registry tracks it. A planned
    // replacement's move then reaches the same controller.
    hold.cleanup()
    const held = controller.register("toolu_workflow_replaced")
    const moved = sessionStore.transferForegroundForReplacement(sessionId)
    await expect(held.released).resolves.toBe("replacement")
    expect(sessionStore.get(sessionId)?.activeForegroundBashToolCallIds).toEqual([])
    held.cleanup()
    await moved
    await sessionStore.transferForegroundForReplacement("missing")

    unregister()
    controller.dispose()
    await sessionStore.remove(sessionId)
    expect(sessionStore.releaseForegroundBash(sessionId, "toolu_workflow_bash")).toBe(false)
  })

  it("opens and controls a subagent through the shared conversation runtime", () => {
    const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const baseRunner = createMockChatRunner("child")
    const runner: ChatRunner & { calls: string[] } = {
      ...baseRunner,
      interrupt: () => {
        baseRunner.calls.push("interrupt")
        return true
      },
    }

    sessionStore.openSessionRuntime({
      sessionId: "child",
      conversationId: "child-conversation",
      kind: "subagent",
    })

    expect(sessionStore.get("child")).toMatchObject({
      kind: "subagent",
      conversationId: "child-conversation",
      runner: null,
    })
    expect(sessionStore.attachChatRunner("child", runner)).toBe(true)
    expect(sessionStore.interrupt("child", "person")).toBe(true)
    expect(runner.calls).toEqual(["interrupt"])
  })

  it("remove() keeps the entry resident until runner disposal settles", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
        const release = Promise.withResolvers<void>()
        const runner = createMockChatRunner("remove-await-001")
        const disposalStarted = Promise.withResolvers<void>()
        runner.dispose = async () => {
          runner.calls.push("dispose:start")
          disposalStarted.resolve()
          await release.promise
          runner.calls.push("dispose:done")
        }
        attachChat(sessionStore, "remove-await-001", runner)

        const removing = sessionStore.remove("remove-await-001")
        await disposalStarted.promise
        expect(runner.calls).toEqual(["dispose:start"])
        expect(sessionStore.get("remove-await-001")).toBeDefined()

        release.resolve()
        await removing
        expect(runner.calls).toEqual(["dispose:start", "dispose:done"])
        expect(sessionStore.get("remove-await-001")).toBeUndefined()
        dispose()
        resolve()
      })
    })
  })

  it("compactConversation does not dispose an idle chat before any conversation exists", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))

        attachChat(sessionStore, "empty-compact-001", createMockChatRunner("empty-compact-001"))

        expect(sessionStore.get("empty-compact-001")?.runnerState).toBe("idle")
        const compacted = await sessionStore.compactConversation("empty-compact-001")

        expect(compacted).toBe(false)
        expect(sessionStore.get("empty-compact-001")).toBeDefined()

        dispose()
        resolve()
      })
    })
  })

  it("interrupt() does not eagerly write runnerState — settlement path owns the transition", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
        attachChat(sessionStore, "interrupt-001", {
          ...createMockChatRunner("interrupt-001"),
          interrupt: () => true,
        })

        // Simulate the runner attached and streaming.
        sessionStore.updateChatEntry("interrupt-001", { runnerState: "streaming" })
        expect(sessionStore.get("interrupt-001")!.runnerState).toBe("streaming")

        // interrupt() forwards to the runner but must not flip the activity —
        // the runner parks at prepareWaitForInput and detachRunner (chat) or
        // workflow.run.completed/failed (workflow) drives the transition.
        expect(sessionStore.interrupt("interrupt-001", "person")).toBe(true)
        expect(sessionStore.get("interrupt-001")!.runnerState).toBe("streaming")

        dispose()
        resolve()
      })
    })
  })

  it.each([
    ["a question", { runnerState: "awaiting_user", waitingOnBackgroundWork: false }],
    ["background work", { runnerState: "idle", waitingOnBackgroundWork: true }],
  ] as const)("disposeAll aborts and disposes a chat runner whose turn is parked on %s", async (_parkedOn, turn) => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
        const runner = createMockChatRunner("awaiting-dispose-001")
        attachChat(sessionStore, "awaiting-dispose-001", runner)
        sessionStore.updateEntry("awaiting-dispose-001", turn)

        await sessionStore.disposeAll()

        expect(runner.calls).toEqual(["abort", "dispose"])
        dispose()
        resolve()
      })
    })
  })

  it("disposeAll skips abort but disposes idle chat runners", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
        const runner = createMockChatRunner("idle-dispose-001")
        attachChat(sessionStore, "idle-dispose-001", runner)
        sessionStore.updateEntry("idle-dispose-001", { runnerState: "idle" })

        await sessionStore.disposeAll()

        expect(runner.calls).toEqual(["dispose"])
        dispose()
        resolve()
      })
    })
  })

  it("disposeAll keeps entries resident until every runner disposal settles", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
        const release = Promise.withResolvers<void>()
        const runner = createMockChatRunner("dispose-await-001")
        const disposalStarted = Promise.withResolvers<void>()
        runner.dispose = async () => {
          runner.calls.push("dispose:start")
          disposalStarted.resolve()
          await release.promise
          runner.calls.push("dispose:done")
        }
        attachChat(sessionStore, "dispose-await-001", runner)

        const disposing = sessionStore.disposeAll()
        await disposalStarted.promise
        expect(sessionStore.get("dispose-await-001")).toBeDefined()
        expect(runner.calls).toEqual(["dispose:start"])

        release.resolve()
        await disposing
        expect(sessionStore.get("dispose-await-001")).toBeUndefined()
        expect(runner.calls).toEqual(["dispose:start", "dispose:done"])
        dispose()
        resolve()
      })
    })
  })

  it("tracks explicit session order and reorders by before-id", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))

        for (const sessionId of ["first", "second", "third"]) {
          attachChat(sessionStore, sessionId, createMockChatRunner(sessionId))
        }

        expect(sessionStore.allIds()).toEqual(["first", "second", "third"])
        expect(sessionStore.reorder("third", "first")).toBe(true)
        expect(sessionStore.allIds()).toEqual(["third", "first", "second"])
        expect(sessionStore.reorder("first", null)).toBe(true)
        expect(sessionStore.allIds()).toEqual(["third", "second", "first"])
        expect(sessionStore.reorder("missing", "third")).toBe(false)

        await sessionStore.remove("second")
        expect(sessionStore.allIds()).toEqual(["third", "first"])

        dispose()
        resolve()
      })
    })
  })

  it("mutations via store handle are visible to reactive consumers", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
        attachChat(sessionStore, "mutate-001", createMockChatRunner("mutate-001"))

        // Mutate tokens
        sessionStore.updateChatEntry("mutate-001", { tokens: 500 })
        expect(sessionStore.get("mutate-001")!.tokens).toBe(500)

        // Mutate cost
        sessionStore.updateChatEntry("mutate-001", { cost: 1.23 })
        expect(sessionStore.get("mutate-001")!.cost).toBe(1.23)

        // Mutate model phase
        sessionStore.updateChatEntry("mutate-001", { streamPhase: "thinking" })
        expect(sessionStore.get("mutate-001")!.streamPhase).toBe("thinking")

        // Mutate context percent
        sessionStore.updateChatEntry("mutate-001", { contextPercent: 42 })
        expect(sessionStore.get("mutate-001")!.contextPercent).toBe(42)

        dispose()
        resolve()
      })
    })
  })

  it("pre-runner append updates the visible suffix count and publishes an upsert", () => {
    createRoot((dispose) => {
      const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
      const seeded: AnyBlock = { kind: "userMessage", id: "seed", content: "history", timestamp: 1, pending: false, injected: false }
      sessionStore.openSessionRuntime({ sessionId: "pre-runner-001", conversationId: "conv-1", priorBlocks: [seeded], outputSequenceStart: 7 })
      sessionStore.drainOutputChanges("pre-runner-001")

      const block: AnyBlock = { kind: "userMessage", id: "m1", content: "hello", timestamp: 2, pending: false, injected: false }
      expect(sessionStore.appendPreRunnerOutput("pre-runner-001", block)).toBe(true)

      const batch = sessionStore.drainOutputChanges("pre-runner-001")
      expect(batch.fullResync).toBe(false)
      expect(batch.changes).toEqual([{ kind: "upsert", index: 8, block }])
      expect(sessionStore.get("pre-runner-001")?.visibleMessageCountSuffix).toBe(1)
      dispose()
    })
  })

  it("output change batches merge across mutations, so a burst before one drain loses nothing", () => {
    createRoot((dispose) => {
      const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
      sessionStore.openSessionRuntime({ sessionId: "merge-001", conversationId: "conv-1", priorBlocks: [] })
      sessionStore.drainOutputChanges("merge-001")

      const first: AnyBlock = { kind: "userMessage", id: "m1", content: "one", timestamp: 1, pending: false, injected: false }
      const second: AnyBlock = { kind: "userMessage", id: "m2", content: "two", timestamp: 2, pending: false, injected: false }
      expect(sessionStore.appendPreRunnerOutput("merge-001", first)).toBe(true)
      expect(sessionStore.appendPreRunnerOutput("merge-001", second)).toBe(true)

      const batch = sessionStore.drainOutputChanges("merge-001")
      expect(batch.fullResync).toBe(false)
      expect(batch.changes).toEqual([
        { kind: "upsert", index: 0, block: first },
        { kind: "upsert", index: 1, block: second },
      ])
      dispose()
    })
  })

  it("onChange names the sessions changed since the last notification, and nothing after an order change", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
        attachChat(sessionStore, "scope-001", createMockChatRunner("scope-001"))
        attachChat(sessionStore, "scope-002", createMockChatRunner("scope-002"))
        await new Promise<void>((r) => queueMicrotask(r))

        const notifications: (ReadonlySet<string> | undefined)[] = []
        const unsubscribe = sessionStore.onChange((changed) => { notifications.push(changed) })

        sessionStore.updateChatEntry("scope-002", { tokens: 1 })
        sessionStore.updateChatEntry("scope-002", { tokens: 2 })
        await new Promise<void>((r) => queueMicrotask(r))
        expect(notifications).toEqual([new Set(["scope-002"])])

        expect(sessionStore.reorder("scope-002", "scope-001")).toBe(true)
        await new Promise<void>((r) => queueMicrotask(r))
        expect(notifications.at(-1)).toBeUndefined()
        expect(notifications).toHaveLength(2)

        unsubscribe()
        dispose()
        resolve()
      })
    })
  })

  it("onChange coalesces a synchronous mutation burst into one deferred notification", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
        attachChat(sessionStore, "coalesce-001", createMockChatRunner("coalesce-001"))
        await new Promise<void>((r) => queueMicrotask(r))

        let notifications = 0
        const unsubscribe = sessionStore.onChange(() => { notifications += 1 })

        sessionStore.updateChatEntry("coalesce-001", { tokens: 1 })
        sessionStore.updateChatEntry("coalesce-001", { tokens: 2 })
        sessionStore.updateChatEntry("coalesce-001", { tokens: 3 })
        expect(notifications).toBe(0)
        await new Promise<void>((r) => queueMicrotask(r))
        expect(notifications).toBe(1)
        expect(sessionStore.revision("coalesce-001")).toBeGreaterThanOrEqual(3)

        sessionStore.updateChatEntry("coalesce-001", { tokens: 4 })
        await new Promise<void>((r) => queueMicrotask(r))
        expect(notifications).toBe(2)

        unsubscribe()
        dispose()
        resolve()
      })
    })
  })

})

describe("session duration bookkeeping", () => {
  async function settleBackgroundWork(): Promise<void> {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  }

  /** Runs `use`, lets the background work it starts settle, and returns the
   *  WARN and ERROR records it left. bun test fails the running test on an
   *  unhandled rejection, which in the executor would end the process. */
  async function observe(use: () => void): Promise<readonly DebugLogRecordInput[]> {
    spyOn(DebugLog, "isOpen").mockReturnValue(true)
    const record = spyOn(DebugLog, "record").mockImplementation(() => {})
    try {
      use()
      await settleBackgroundWork()
      return record.mock.calls.map(([input]) => input).filter((input) => input.type === "log.warn" || input.type === "log.error")
    } finally {
      mock.restore()
    }
  }

  it("leaves a duration row that a newer build wrote in place and records nothing over it", async () => {
    const sessionId = "chat-newer-duration"
    const aggregateId = `session:${sessionId}`
    await runtime.runSync(EventStoreWriterService).append({ aggregateId, sessionId, type: "session.duration.recorded", version: 2, timestamp: 1, actor: "flywheel", payload: { accumulatedActiveMs: 9_000, pausedMs: 12 } })
    const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
    attachChat(sessionStore, sessionId, createMockChatRunner(sessionId))

    const records = await observe(() => {
      sessionStore.updateChatEntry(sessionId, { accumulatedActiveMs: 5_000 })
    })

    expect(records).toEqual([
      expect.objectContaining({ type: "log.warn", sessionId, payload: expect.objectContaining({ message: "session duration row has a shape this release cannot read; it is left in place", version: 2 }) }),
    ])
    expect((await runtime.runSync(EventReaderService).readSlice({ aggregateId, types: ["session.duration.recorded"] })).facts).toEqual([
      expect.objectContaining({ version: 2, payload: { accumulatedActiveMs: 9_000, pausedMs: 12 } }),
    ])
    await sessionStore.remove(sessionId)
  })

  it("disposes the runner and removes the entry when the duration read fails at removal", async () => {
    const sessionId = "chat-duration-read-refused"
    const base = runtime.runSync(EventReaderService)
    const projectionReader = { ...base, readLatestByAggregateAndTypes: async () => { throw new Error("project state request refused: closed-generation") } }
    const sessionStore = createSessionStore(runtime, projectionReader)
    const runner = createMockChatRunner(sessionId)
    attachChat(sessionStore, sessionId, runner)
    spyOn(DebugLog, "isOpen").mockReturnValue(true)
    const record = spyOn(DebugLog, "record").mockImplementation(() => {})
    try {
      await sessionStore.remove(sessionId)
      expect(record.mock.calls.map(([input]) => input)).toContainEqual(
        expect.objectContaining({ type: "log.warn", sessionId, payload: expect.objectContaining({ message: "record session duration failed" }) }),
      )
    } finally {
      mock.restore()
    }

    expect(runner.calls).toEqual(["dispose"])
    expect(sessionStore.get(sessionId)).toBeUndefined()
  })

  it("records a duration write that the closed store refuses at WARN, never as an unhandled rejection", async () => {
    const closed = createSessionStoreTestContext()
    try {
      const sessionStore = createSessionStore(closed.runtime, closed.runtime.runSync(EventReaderService))
      attachChat(sessionStore, "chat-closed-store", createMockChatRunner("chat-closed-store"))
      await closed.runtime.dispose()

      const records = await observe(() => {
        sessionStore.updateChatEntry("chat-closed-store", { accumulatedActiveMs: 5_000 })
      })

      expect(records).toEqual([
        expect.objectContaining({ type: "log.warn", sessionId: "chat-closed-store", payload: expect.objectContaining({ message: "record session duration failed", error: "Database has closed" }) }),
      ])
    } finally {
      await closed.cleanup()
    }
  })
})

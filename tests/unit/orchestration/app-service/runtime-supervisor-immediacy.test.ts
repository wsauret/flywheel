import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createRuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import type { ChatRunner } from "../../../../src/orchestration/chat/runner-types.js"
import type { SessionStore } from "../../../../src/orchestration/session-store/types.js"
import { createDeferred, createSupervisorTestContext, disposeSupervisorTestContext, mockRunner, supervisorBaseDeps, supervisorWithRunner, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { fakeSessionStore, workflowEntry } from "./_frontend-projection-fixtures.js"
import { publishTestWorkflow, startTestWorkflowMember } from "../session/_session-manager-fixtures.js"

let ctx: SupervisorTestContext
beforeEach(() => { ctx = createSupervisorTestContext() })
afterEach(async () => { await disposeSupervisorTestContext(ctx) })

describe("RuntimeSupervisor preemptive immediacy and two-phase lifecycle", () => {
  test("interrupt returns immediately while an ordered compact is still pending", async () => {
    const blocked = createDeferred<boolean>()
    const compactStarted = createDeferred<void>()
    let interruptCalls = 0
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId, {
      compact: () => { compactStarted.resolve(); return blocked.promise },
      interrupt: () => { interruptCalls += 1; return true },
    }))
    const sessionId = await supervisor.openSessionRuntime()
    await expect(supervisor.sendChat(sessionId, "first turn")).resolves.toEqual({ ok: true })
    await supervisor.ensureChatRunner(sessionId)
    ctx.sessionStore.updateChatEntry(sessionId, { runnerState: "streaming" })

    // The ordered compact command parks in the mailbox; interrupt is preemptive
    // and must resolve without waiting for the mailbox to drain.
    const pendingCompact = supervisor.compactChat(sessionId)
    await compactStarted.promise
    const interrupted = supervisor.interruptSession(sessionId, "person")
    expect(interruptCalls).toBe(1)
    expect(await interrupted).toBe(true)

    blocked.resolve(true)
    await expect(pendingCompact).resolves.toBe(true)
  })

  test("bash detach reaches the active runner while an ordered compact is still pending", async () => {
    const blocked = createDeferred<boolean>()
    const released: string[] = []
    let held = true
    let interruptCalls = 0
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId, {
      compact: () => blocked.promise,
      interrupt: () => { interruptCalls += 1; return true },
      releaseForegroundBash: (toolUseId) => {
        released.push(toolUseId)
        if (!held) return false
        held = false
        return true
      },
    }))
    const sessionId = await supervisor.openSessionRuntime()
    await expect(supervisor.sendChat(sessionId, "first turn")).resolves.toEqual({ ok: true })
    await supervisor.ensureChatRunner(sessionId)

    const pendingCompact = supervisor.compactChat(sessionId)
    expect(supervisor.releaseForegroundBash(sessionId, "toolu_bash")).toBe(true)
    expect(supervisor.releaseForegroundBash(sessionId, "toolu_bash")).toBe(false)
    expect(released).toEqual(["toolu_bash", "toolu_bash"])
    expect(interruptCalls).toBe(0)

    blocked.resolve(true)
    await expect(pendingCompact).resolves.toBe(true)
  })

  test("bash detach releases queued input before logical-turn durability settles", async () => {
    const durability = createDeferred<void>()
    const injected: string[] = []
    const released: string[] = []
    const order: string[] = []
    const supervisor = createRuntimeSupervisor(supervisorBaseDeps(ctx, ctx.sessionStore, {
      createRunner: async (deps) => mockRunner(deps.sessionId, {
        awaitLogicalTurnDurability: () => durability.promise,
        send: async (input) => {
          order.push("inject")
          injected.push(typeof input === "string" ? input : input.text)
          return "accepted"
        },
        releaseForegroundBash: (toolUseId) => {
          released.push(toolUseId)
          return true
        },
      }),
      reconcileChildSessionCompletions: async () => {
        order.push("reconcile")
        return { reconciledCount: 0, workflowAggregateReads: 0 }
      },
    }))
    const sessionId = await supervisor.openSessionRuntime()
    await expect(supervisor.sendChat(sessionId, "first turn")).resolves.toEqual({ ok: true })
    await supervisor.ensureChatRunner(sessionId)
    order.length = 0

    const queuedSend = supervisor.sendChat(sessionId, "send after detach")
    await Bun.sleep(0)
    expect(supervisor.releaseForegroundBash(sessionId, "toolu_bash")).toBe(true)
    await Bun.sleep(0)

    expect(released).toEqual(["toolu_bash"])
    expect(injected).toEqual(["send after detach"])
    expect(order).toEqual(["inject", "reconcile"])
    durability.resolve()
    await expect(queuedSend).resolves.toEqual({ ok: true })
  })

  test("bash detach is an idempotent no-op for unknown and inactive sessions", async () => {
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId))
    expect(supervisor.releaseForegroundBash("unknown", "toolu_bash")).toBe(false)

    const sessionId = await supervisor.openSessionRuntime()
    expect(supervisor.releaseForegroundBash(sessionId, "toolu_bash")).toBe(false)
  })

  test("bash detach reaches the session store for a session without a chat actor (workflow sessions)", () => {
    const released: string[] = []
    const wrappedStore: SessionStore = {
      ...ctx.sessionStore,
      releaseForegroundBash: (id, toolUseId) => { released.push(`${id}:${toolUseId}`); return true },
    }
    const supervisor = createRuntimeSupervisor(supervisorBaseDeps(ctx, wrappedStore, { createRunner: async (deps) => mockRunner(deps.sessionId) }))

    // No actor exists for this session: workflow sessions never create one,
    // so detach must route through the shared session store directly.
    expect(supervisor.releaseForegroundBash("workflow-session", "toolu_bash")).toBe(true)
    expect(released).toEqual(["workflow-session:toolu_bash"])
  })

  test("deleting during delayed startup cannot leave a listable half-active session", async () => {
    const deferred = createDeferred<ChatRunner>()
    const creating = createDeferred<void>()
    let attachCalls = 0
    const wrappedStore: SessionStore = {
      ...ctx.sessionStore,
      attachChatRunner: (id, runner) => { attachCalls += 1; return ctx.sessionStore.attachChatRunner(id, runner) },
    }
    const runner = mockRunner("late-delete")
    const supervisor = createRuntimeSupervisor(supervisorBaseDeps(ctx, wrappedStore, {
      createRunner: async () => {
        creating.resolve()
        return deferred.promise
      },
    }))
    const sessionId = await supervisor.openSessionRuntime()
    const startup = supervisor.ensureChatRunner(sessionId).catch((err) => err)
    await creating.promise

    const remove = supervisor.deleteSession(sessionId)
    deferred.resolve(runner)
    await expect(remove).resolves.toBe(true)
    await startup

    expect(attachCalls).toBe(0)
    expect(runner.disposeCalls()).toBe(1)
    expect(ctx.sessionStore.allIds()).not.toContain(sessionId)
    expect(await ctx.manager.read(sessionId)).toBeNull()
  })

  test("close prepares the active runner for durable shutdown before tearing it down", async () => {
    let abortCalls = 0
    let prepareCalls = 0
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId, {
      abort: () => { abortCalls += 1 },
      prepareForShutdown: () => { prepareCalls += 1 },
    }))
    const sessionId = await supervisor.openSessionRuntime()
    await expect(supervisor.sendChat(sessionId, "keep me")).resolves.toEqual({ ok: true })
    await supervisor.ensureChatRunner(sessionId)

    await expect(supervisor.closeChat(sessionId)).resolves.toBe(true)
    expect(prepareCalls).toBe(1)
    expect(abortCalls).toBe(0)
    expect((await ctx.manager.read(sessionId))?.lifecycleState).toBe("inactive")
  })

  test("workflow agent close awaits durable abort, disposal, and inactive publication", async () => {
    const workflowId = await publishTestWorkflow(ctx.manager, { id: "workflow-close", name: "Workflow", workflowDefinitionId: "workflow" })
    const sessionId = await startTestWorkflowMember(ctx.manager, ctx.store, workflowId)
    const entries = new Map([[sessionId, workflowEntry()]])
    const base = fakeSessionStore(entries)
    const release = Promise.withResolvers<void>()
    const order: string[] = []
    const sessionStore: SessionStore = {
      ...base,
      remove: async (id) => {
        order.push("workflow.aborted")
        await release.promise
        order.push("disposed")
        entries.delete(id)
        await ctx.manager.updateLifecycleState(id, "inactive")
        order.push("inactive")
      },
    }
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, sessionStore, { createRunner: async (deps) => mockRunner(deps.sessionId) }),
    })

    const closing = supervisor.closeChat(sessionId)
    for (let attempt = 0; attempt < 20 && order.length === 0; attempt += 1) await Bun.sleep(1)
    expect(order).toEqual(["workflow.aborted"])
    expect((await ctx.manager.read(sessionId))?.lifecycleState).toBe("active")
    release.resolve()

    await expect(closing).resolves.toBe(true)
    expect(order).toEqual(["workflow.aborted", "disposed", "inactive"])
    expect((await ctx.manager.read(sessionId))?.lifecycleState).toBe("inactive")
  })

  test("disposeAll shelves every session's turn before it joins any settlement", async () => {
    const order: string[] = []
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId, {
      interrupt: () => { order.push(`interrupt:${deps.sessionId}`); return true },
      // The teardown verb, not interrupt: only Escape records user intent.
      prepareForShutdown: () => { order.push(`shelve:${deps.sessionId}`) },
      dispose: async () => { order.push(`dispose:${deps.sessionId}`) },
    }))
    const first = await supervisor.openSessionRuntime()
    await supervisor.ensureChatRunner(first)
    const second = await supervisor.openSessionRuntime()
    await supervisor.ensureChatRunner(second)

    await supervisor.disposeAll()

    expect(order.slice(0, 2).toSorted()).toEqual([`shelve:${first}`, `shelve:${second}`].toSorted())
    expect(order.slice(2).toSorted()).toEqual([`dispose:${first}`, `dispose:${second}`].toSorted())
  })

  test("a failed session-store disposal does not skip the sessions' own settlement", async () => {
    const failing: SessionStore = {
      ...ctx.sessionStore,
      disposeAll: async () => { throw new Error("session disposal boom") },
    }
    const supervisor = createRuntimeSupervisor(supervisorBaseDeps(ctx, failing, { createRunner: async (deps) => mockRunner(deps.sessionId) }))
    const sessionId = await supervisor.openSessionRuntime()

    await expect(supervisor.disposeAll()).rejects.toThrow(AggregateError)

    // The blank shell is a tombstone disposition: its settlement ran even though
    // the store's own disposal ended unsafely.
    expect(await ctx.manager.read(sessionId)).toBeNull()
  })
})

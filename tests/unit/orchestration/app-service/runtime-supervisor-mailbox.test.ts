import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { EventStoreWriterService } from "../../../../src/infra/event-store-effect.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, requireGuardedEventAppender, type AsyncGuardedEventWriter } from "../../../../src/infra/event-store-types.js"
import { createRuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import type { ChatRunner } from "../../../../src/orchestration/chat/runner-types.js"
import type { ChatRunnerDeps } from "../../../../src/orchestration/chat/runner.js"
import { createChatRunnerLoader } from "../../../../src/orchestration/app-service/chat-runner-loader.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import type { ConversationEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types.js"
import type { SessionStore } from "../../../../src/orchestration/session-store/types.js"
import { loadSessionView } from "../../../../src/orchestration/session-store/view.js"
import { createDeferred, createSupervisorTestContext, disposeSupervisorTestContext, mockRunner, supervisorBaseDeps, supervisorWithRunner, testSessionAuthAdmission, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"

let ctx: SupervisorTestContext
beforeEach(() => { ctx = createSupervisorTestContext() })
afterEach(async () => { await disposeSupervisorTestContext(ctx) })

describe("RuntimeSupervisor actor mailbox", () => {
  test("reports an unknown session as unavailable rather than swallowing it as false", async () => {
    const supervisor = supervisorWithRunner(ctx, async () => { throw new Error("never reached") })
    await expect(supervisor.sendChat("missing-session", "hello"))
      .resolves.toEqual({ ok: false, reason: "Session missing-session is no longer available" })
  })

  test("two concurrent cold sends commit durable user entries in arrival order", async () => {
    const deferred = createDeferred<ChatRunner>()
    const supervisor = supervisorWithRunner(ctx, async () => deferred.promise)
    const sessionId = await supervisor.openSessionRuntime()
    const conversationId = chatConversationId(sessionId)

    const first = supervisor.sendChat(sessionId, "first")
    const second = supervisor.sendChat(sessionId, "second")
    await waitForDurableCount(sessionId, conversationId, 2)
    deferred.resolve(mockRunner("pending"))

    await Promise.all([first, second])
    expect(await durableUserTexts(sessionId, conversationId)).toEqual(["first", "second"])
  })

  test("a person's message sent again under its submission answers a receipt and is recorded once, cold or attached", async () => {
    const deferred = createDeferred<ChatRunner>()
    const sent: unknown[] = []
    const supervisor = supervisorWithRunner(ctx, async () => deferred.promise)
    const sessionId = await supervisor.openSessionRuntime()
    const conversationId = chatConversationId(sessionId)
    const input = { text: "once", submissionIds: ["submission-1"] }

    expect(await supervisor.sendChat(sessionId, input)).toEqual({ ok: true })
    // Cold: the conversation holds the entry, and no runner took it yet.
    expect(await supervisor.sendChat(sessionId, input)).toEqual({ ok: true, confirmedSubmissionIds: ["submission-1"] })
    deferred.resolve(mockRunner(sessionId, { send: async (message) => { sent.push(message); return "accepted" } }))
    await settled()
    // Attached: the actor answers before the runner or its admission.
    expect(await supervisor.sendChat(sessionId, input)).toEqual({ ok: true, confirmedSubmissionIds: ["submission-1"] })
    expect(sent).toEqual([])
    expect(await durableUserTexts(sessionId, conversationId)).toEqual(["once"])
  })

  test("a rejected ordered command does not poison the next dispatch", async () => {
    // Fail the first cold-send's durable commit, then let the second commit
    // cleanly: a rejected ordered section must clear the mailbox so the next
    // dispatch still runs and commits.
    const realWriter = ctx.runtime.runSync(EventStoreWriterService)
    const guardedWriter = requireGuardedEventAppender(realWriter, "test runtime writer must support guarded append")
    let failNextAppend = true
    const flakyWriter: AsyncGuardedEventWriter = {
      ...realWriter,
      appendGuarded: guardedWriter.appendGuarded,
      appendBatchGuarded: (events) => {
        if (failNextAppend) { failNextAppend = false; return Promise.reject(new Error("durable write failed")) }
        return guardedWriter.appendBatchGuarded(events)
      },
    }
    const supervisor = createRuntimeSupervisor({ ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => mockRunner(deps.sessionId) }), writer: flakyWriter })
    const sessionId = await supervisor.openSessionRuntime()

    const doomed = await supervisor.sendChat(sessionId, "doomed")
    if (doomed.ok) throw new Error("expected the failed commit to surface as a failure")
    expect(doomed.reason).toContain("Chat message could not be saved")
    expect(doomed.reason).toContain("durable write failed")

    await expect(supervisor.sendChat(sessionId, "recovers")).resolves.toEqual({ ok: true })
    expect(await durableUserTexts(sessionId, chatConversationId(sessionId))).toEqual(["recovers"])
  })

  test("two sends during startup reuse one startup and drain each once after attach", async () => {
    const deferred = createDeferred<ChatRunner>()
    let createCalls = 0
    let deliverCalls = 0
    const supervisor = supervisorWithRunner(ctx, async () => { createCalls += 1; return deferred.promise })
    const sessionId = await supervisor.openSessionRuntime()
    const conversationId = chatConversationId(sessionId)

    const first = supervisor.sendChat(sessionId, "first")
    const second = supervisor.sendChat(sessionId, "second")
    await waitForDurableCount(sessionId, conversationId, 2)
    deferred.resolve(mockRunner("pending", { deliverCommitted: () => { deliverCalls += 1; return true } }))

    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }])
    expect(createCalls).toBe(1)
    expect(deliverCalls).toBe(2)
  })

  test("step boundary output precedes the invocation args for a pre-runner send", async () => {
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId))
    const sessionId = await supervisor.openSessionRuntime()

    const input = { text: "expanded step prompt body", invocation: { label: "Step 1", args: "step input" }, submissionIds: ["pre-runner-1"] }
    await expect(supervisor.sendChat(sessionId, input)).resolves.toEqual({ ok: true })

    const blocks = chatEntry(sessionId).outputBlocks()
    const boundaryIndex = blocks.findIndex((block) => block.kind === "divider" && block.label === "Step 1")
    const messageIndex = blocks.findIndex((block) => block.kind === "userMessage" && block.content === "step input")
    expect(boundaryIndex).toBeGreaterThanOrEqual(0)
    expect(messageIndex).toBeGreaterThan(boundaryIndex)
    expect(blocks[messageIndex]).toMatchObject({ submissionIds: ["pre-runner-1"] })
  })

  test("deferred capabilities acknowledge commits and later deliver every input once in order", async () => {
    const held = createDeferred<Awaited<ReturnType<ReturnType<typeof supervisorBaseDeps>["runnerCapabilities"]>>>()
    const deliveries: string[] = []
    const base = supervisorBaseDeps(ctx)
    const supervisor = createRuntimeSupervisor({ ...base, runnerCapabilities: () => held.promise })
    const sessionId = await supervisor.openSessionRuntime()

    await expect(Promise.all([
      supervisor.sendChat(sessionId, "first"),
      supervisor.sendChat(sessionId, "second"),
    ])).resolves.toEqual([{ ok: true }, { ok: true }])
    expect(deliveries).toEqual([])
    let drained = false
    const settlement = supervisor.awaitAcceptedWork().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)

    const authAdmission = testSessionAuthAdmission()
    held.resolve({
      ...(await base.runnerCapabilities()),
      authAdmission,
      runnerLoader: createChatRunnerLoader({
        authAdmission,
        createRunner: async () => mockRunner(sessionId, {
          deliverCommitted: (input) => { deliveries.push(typeof input === "string" ? input : input.text); return true },
        }),
      }),
    })
    await supervisor.ensureChatRunner(sessionId)
    await settlement
    expect(drained).toBe(true)
    expect(deliveries).toEqual(["first", "second"])
  })

  test("capability rejection retains the durable message and publishes startup failure", async () => {
    const base = supervisorBaseDeps(ctx)
    const failures: string[] = []
    const supervisor = createRuntimeSupervisor({
      ...base,
      runnerCapabilities: async () => { throw new Error("capabilities unavailable") },
      onRunnerError: (_sessionId, message) => { failures.push(message) },
    })
    const sessionId = await supervisor.openSessionRuntime()
    const conversationId = chatConversationId(sessionId)

    await expect(supervisor.sendChat(sessionId, "retained")).resolves.toEqual({ ok: true })
    await Promise.resolve()
    expect(await durableUserTexts(sessionId, conversationId)).toEqual(["retained"])
    expect(supervisor.runtimeState(sessionId)).toEqual({ kind: "failed", message: "capabilities unavailable" })
    expect(chatEntry(sessionId).outputBlocks()).toContainEqual(expect.objectContaining({ kind: "system", level: "error", message: "Chat startup failed: capabilities unavailable" }))
    expect(failures).toEqual(["capabilities unavailable"])
  })

  test("close during capability loading prevents a late runner attach and ends the waiting activation unactivated", async () => {
    const held = createDeferred<Awaited<ReturnType<ReturnType<typeof supervisorBaseDeps>["runnerCapabilities"]>>>()
    const base = supervisorBaseDeps(ctx)
    const supervisor = createRuntimeSupervisor({ ...base, runnerCapabilities: () => held.promise, closeStartupGraceMs: 0 })
    const sessionId = await supervisor.openSessionRuntime()
    await supervisor.sendChat(sessionId, "closing")
    // The tab that opened the chat waits on the startup when the person closes it.
    const activation = supervisor.activateSession(sessionId)
    await settled()
    await supervisor.closeChat(sessionId)
    const runner = mockRunner(sessionId)
    const authAdmission = testSessionAuthAdmission()
    held.resolve({
      ...(await base.runnerCapabilities()),
      authAdmission,
      runnerLoader: createChatRunnerLoader({ authAdmission, createRunner: async () => runner }),
    })
    await Promise.resolve()
    // The close superseded the startup: the activation reports that the chat
    // did not open, and is not a startup failure.
    await expect(activation).resolves.toBe(false)
    expect(ctx.sessionStore.get(sessionId)).toBeUndefined()
    expect(runner.disposeCalls()).toBe(0)
  })

  test("a release ends an idle runner and leaves the store, and keeps the empty chat as it was", async () => {
    const runner = mockRunner("pending")
    const supervisor = supervisorWithRunner(ctx, async () => runner)
    const sessionId = await supervisor.openSessionRuntime()
    await expect(supervisor.activateSession(sessionId)).resolves.toBe(true)
    expect(chatEntry(sessionId).runner).toBe(runner)
    const before = await ctx.manager.read(sessionId)

    await supervisor.releaseSession(sessionId)
    expect(ctx.sessionStore.get(sessionId)).toBeUndefined()
    expect(runner.disposeCalls()).toBe(1)
    expect(await ctx.manager.read(sessionId)).toEqual(before)
    // A session that no actor holds has no runner left to end.
    await supervisor.releaseSession(sessionId)
  })

  test("a release while the turn runs ends the runner once the turn comes to rest, and an activation cancels it", async () => {
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId))
    const sessionId = await supervisor.openSessionRuntime()
    await supervisor.activateSession(sessionId)
    ctx.sessionStore.updateChatEntry(sessionId, { runnerState: "streaming" })

    await supervisor.releaseSession(sessionId)
    await supervisor.activateSession(sessionId)
    ctx.sessionStore.updateChatEntry(sessionId, { runnerState: "idle" })
    await settled()
    // The activation shows the chat again, so its runner stays at rest.
    expect(chatEntry(sessionId).runner).not.toBeNull()

    ctx.sessionStore.updateChatEntry(sessionId, { runnerState: "streaming" })
    await supervisor.releaseSession(sessionId)
    await settled()
    expect(chatEntry(sessionId).runner).not.toBeNull()
    ctx.sessionStore.updateChatEntry(sessionId, { runnerState: "idle" })
    await settled()
    expect(ctx.sessionStore.get(sessionId)).toBeUndefined()
  })

  test("a failed startup that an activation waits for keeps the entry the client shows and the input already sent", async () => {
    const held = createDeferred<Awaited<ReturnType<ReturnType<typeof supervisorBaseDeps>["runnerCapabilities"]>>>()
    const supervisor = createRuntimeSupervisor({ ...supervisorBaseDeps(ctx), runnerCapabilities: () => held.promise })
    const sessionId = await supervisor.openSessionRuntime()
    const conversationId = chatConversationId(sessionId)
    const activation = supervisor.activateSession(sessionId)
    await expect(supervisor.sendChat(sessionId, "kept")).resolves.toEqual({ ok: true })

    held.reject(new Error("capabilities unavailable"))
    await expect(activation).rejects.toThrow("capabilities unavailable")
    await settled()
    expect(chatEntry(sessionId).runner).toBeNull()
    expect(await durableUserTexts(sessionId, conversationId)).toEqual(["kept"])
    expect(await ctx.manager.read(sessionId)).not.toBeNull()
  })

  test("an older failed startup leaves the entry that a newer activation serves", async () => {
    type Capabilities = Awaited<ReturnType<ReturnType<typeof supervisorBaseDeps>["runnerCapabilities"]>>
    const capabilities = [createDeferred<Capabilities>(), createDeferred<Capabilities>(), createDeferred<Capabilities>()]
    let calls = 0
    const supervisor = createRuntimeSupervisor({ ...supervisorBaseDeps(ctx), runnerCapabilities: () => capabilities[calls++]!.promise })
    const sessionId = await supervisor.openSessionRuntime()
    const older = supervisor.activateSession(sessionId)
    await settled()
    // A compaction waits for capabilities inside the mailbox, so the newer
    // activation is queued before the older startup fails.
    const compaction = supervisor.compactChat(sessionId)
    await settled()
    const newer = supervisor.activateSession(sessionId)
    capabilities[0]!.reject(new Error("first start failed"))
    await expect(older).rejects.toThrow("first start failed")

    const runner = mockRunner(sessionId)
    const working = await supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async () => runner }).runnerCapabilities()
    capabilities[1]!.resolve(working)
    capabilities[2]!.resolve(working)
    await compaction
    await expect(newer).resolves.toBe(true)
    await settled()
    expect(chatEntry(sessionId).runner).toBe(runner)
  })

  test("a failed activation keeps one startup notice and the durable session until the person's next message starts the runner", async () => {
    type Capabilities = Awaited<ReturnType<ReturnType<typeof supervisorBaseDeps>["runnerCapabilities"]>>
    const base = supervisorBaseDeps(ctx)
    const runner = mockRunner("retried")
    const working = await supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async () => runner }).runnerCapabilities()
    let failing = true
    let starts = 0
    const supervisor = createRuntimeSupervisor({
      ...base,
      runnerCapabilities: async (): Promise<Capabilities> => {
        starts += 1
        if (failing) throw new Error("auth profile does not exist: Work")
        return working
      },
    })
    const sessionId = await supervisor.openSessionRuntime()
    const notices = () => chatEntry(sessionId).outputBlocks().filter(block => block.kind === "system")
    const seen: string[][] = []
    let shown = false
    const unwatch = ctx.sessionStore.onChange(() => {
      const entry = ctx.sessionStore.get(sessionId)
      const ids = entry?.kind === "chat" ? entry.outputBlocks().filter(block => block.kind === "system").map(block => block.id) : []
      shown ||= ids.length > 0
      if (shown) seen.push(ids)
    }, "startup-notice-test")
    try {
      // One tab open activates the session more than once (ARCH-SESSIONS-038).
      for (let open = 0; open < 3; open += 1) {
        await expect(supervisor.activateSession(sessionId)).rejects.toThrow("auth profile does not exist: Work")
        await settled()
      }
      expect(starts).toBe(3)
      expect(notices()).toEqual([expect.objectContaining({ id: "startup-failure", level: "error", message: "Chat startup failed: auth profile does not exist: Work" })])
      expect(await ctx.manager.read(sessionId)).not.toBeNull()

      failing = false
      await expect(supervisor.sendChat(sessionId, "again")).resolves.toEqual({ ok: true })
      await settled()
      await settled()
      expect(starts).toBe(4)
      expect(chatEntry(sessionId).runner).toBe(runner)
      expect(notices()).toEqual([])
      const removal = seen.findIndex(ids => ids.length === 0)
      expect(seen.slice(0, removal).every(ids => ids.length === 1 && ids[0] === "startup-failure")).toBe(true)
      expect(seen.slice(removal).every(ids => ids.length === 0)).toBe(true)
      expect(await durableUserTexts(sessionId, chatConversationId(sessionId))).toEqual(["again"])
    } finally { unwatch() }
  })
  test("a message the store cannot save fails its send with the cause, and the next message starts a turn", async () => {
    let sends = 0
    const runner = mockRunner("unused", {
      send: async () => {
        sends += 1
        if (sends === 1) throw new Error("database is locked")
        return "accepted"
      },
    })
    const supervisor = supervisorWithRunner(ctx, async () => runner)
    const id = await supervisor.openSessionRuntime()
    await supervisor.ensureChatRunner(id)

    await expect(supervisor.sendChat(id, "during the lock")).resolves.toEqual({ ok: false, reason: "Chat message could not be saved: database is locked" })
    await expect(supervisor.sendChat(id, "after the lock")).resolves.toEqual({ ok: true })
    expect(chatEntry(id).runner).toBe(runner)
  })

  test("a completion sweep that fails does not fail a person's message, attached or cold", async () => {
    const injected: string[] = []
    const supervisor = createRuntimeSupervisor(supervisorBaseDeps(ctx, ctx.sessionStore, {
      createRunner: async (deps) => mockRunner(deps.sessionId, { send: async (input) => { injected.push(typeof input === "string" ? input : input.text); return "accepted" } }),
      reconcileChildSessionCompletions: async () => { throw new Error("unreadable parent result") },
    }))

    const attached = await supervisor.openSessionRuntime()
    await supervisor.ensureChatRunner(attached)
    await expect(supervisor.sendChat(attached, "attached message")).resolves.toEqual({ ok: true })
    expect(injected).toEqual(["attached message"])

    const cold = await supervisor.openSessionRuntime()
    await expect(supervisor.sendChat(cold, "cold message")).resolves.toEqual({ ok: true })
    expect(await durableUserTexts(cold, chatConversationId(cold))).toEqual(["cold message"])
  })

  test("deleting a session whose record cannot be read removes it from the catalog", async () => {
    const supervisor = supervisorWithRunner(ctx, async () => { throw new Error("no runner starts for a delete") })
    await ctx.manager.createChat({ id: "broken", name: "Broken", initialState: "inactive" })
    const db = new Database(resolveEventStoreDbFile(ctx.baseDir))
    try {
      db.run(`update event set payload = '{"label":' where aggregate_id = 'session:broken' and type = 'session.created'`)
    } finally {
      db.close()
    }
    const erroredIds = async () => (await ctx.manager.listMetadata()).errors.map((error) => error.sessionId)
    expect(await erroredIds()).toContain("broken")

    expect(await supervisor.deleteSession("broken")).toBe(true)

    expect(await erroredIds()).not.toContain("broken")
    expect(ctx.store.read({ aggregateId: "session:broken", types: ["session.deleted"] })).toHaveLength(1)
  })

  test("a finished runner whose session the store cannot mark inactive still lets the next message start a new runner", async () => {
    const callbacks: ChatRunnerDeps[] = []
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => { callbacks.push(deps); return mockRunner(deps.sessionId) } }),
      sessionViewLoader: { load: (sessionId) => loadSessionView(sessionId, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) },
    })
    const id = "s"
    await ctx.manager.createChat({ id, conversationId: "conversation:s", name: "Saved chat", initialState: "inactive" })
    const tree = await tryOpenConversationTree({ conversationId: "conversation:s", sessionId: id, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store) })
    if (!tree) throw new Error("Missing durable chat tree")
    try {
      expect((await tree.appendMessages([{ kind: "user", content: "Earlier user turn" }])).kind).toBe("committed")
    } finally {
      await tree.getStorage().dispose()
    }
    expect(await supervisor.activateSession(id)).toBe(true)
    const updateLifecycleState = ctx.manager.updateLifecycleState.bind(ctx.manager)
    ctx.manager.updateLifecycleState = async () => { throw new Error("database is locked") }
    try {
      callbacks[0]?.onError("Session history flush failed: database is locked")
      for (let i = 0; i < 50 && ctx.sessionStore.has(id); i++) await settled()
    } finally {
      ctx.manager.updateLifecycleState = updateLifecycleState
    }
    expect(ctx.sessionStore.has(id)).toBe(false)

    expect(await supervisor.activateSession(id)).toBe(true)
    await expect(supervisor.sendChat(id, "after the lock")).resolves.toEqual({ ok: true })
    expect(callbacks).toHaveLength(2)
  })

  test("a runner that ends by itself while a client shows its session leaves the session shown: the next send's runner runs the engines with no new activation, until the client releases it", async () => {
    const callbacks: ChatRunnerDeps[] = []
    const shown: (readonly [number, boolean])[] = []
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => {
        const runner = callbacks.push(deps)
        return mockRunner(deps.sessionId, { setShown: (next) => { shown.push([runner, next]) } })
      } }),
      sessionViewLoader: { load: (sessionId) => loadSessionView(sessionId, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) },
    })
    const id = "shown"
    await ctx.manager.createChat({ id, conversationId: "conversation:shown", name: "Shown chat", initialState: "inactive" })
    const tree = await tryOpenConversationTree({ conversationId: "conversation:shown", sessionId: id, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store) })
    if (!tree) throw new Error("Missing durable chat tree")
    try {
      expect((await tree.appendMessages([{ kind: "user", content: "Earlier user turn" }])).kind).toBe("committed")
    } finally {
      await tree.getStorage().dispose()
    }
    expect(await supervisor.activateSession(id, { shown: true })).toBe(true)
    expect(shown).toEqual([[1, true]])

    callbacks[0]?.onError("Session history flush failed: database is locked")
    for (let i = 0; i < 50 && ctx.sessionStore.has(id); i++) await settled()
    expect(ctx.sessionStore.has(id)).toBe(false)

    await expect(supervisor.sendChat(id, "after the runner ended")).resolves.toEqual({ ok: true })
    expect(callbacks).toHaveLength(2)
    expect(shown).toEqual([[1, true], [2, true]])

    await supervisor.releaseSession(id)
    expect(shown.at(-1)).toEqual([2, false])
  })

  test("a hide stops showing a session and keeps its runner, an activation sent right after it shows the session again, and a hide of a session no actor holds creates nothing", async () => {
    const shown: boolean[] = []
    const runners: ChatRunnerDeps[] = []
    const runner = mockRunner("pending", { setShown: (next) => { shown.push(next) } })
    const supervisor = supervisorWithRunner(ctx, async (deps) => { runners.push(deps); return runner })
    const sessionId = await supervisor.openSessionRuntime()
    await supervisor.activateSession(sessionId, { shown: true })
    expect(shown).toEqual([true])

    await supervisor.hideSession(sessionId)
    expect(shown).toEqual([true, false])
    expect(chatEntry(sessionId).runner).toBe(runner)
    expect(runner.disposeCalls()).toBe(0)

    // A client that comes back at once: its activation follows the hide.
    const hidden = supervisor.hideSession(sessionId)
    const activated = supervisor.activateSession(sessionId, { shown: true })
    await Promise.all([hidden, activated])
    expect(shown.at(-1)).toBe(true)
    expect(chatEntry(sessionId).runner).toBe(runner)

    await supervisor.hideSession("never-opened")
    expect(ctx.sessionStore.get("never-opened")).toBeUndefined()
    expect(runners).toHaveLength(1)
  })
})

function chatEntry(sessionId: string): Extract<NonNullable<ReturnType<SessionStore["get"]>>, { kind: "chat" }> {
  const entry = ctx.sessionStore.get(sessionId)
  if (entry?.kind !== "chat") throw new Error("expected chat entry")
  return entry
}

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function chatConversationId(sessionId: string): string {
  return chatEntry(sessionId).conversationId
}

async function waitForDurableCount(sessionId: string, conversationId: string, count: number): Promise<void> {
  for (let i = 0; i < 50 && (await durableUserTexts(sessionId, conversationId)).length < count; i++) await Promise.resolve()
}

async function durableUserTexts(sessionId: string, conversationId: string): Promise<string[]> {
  const tree = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(ctx.store) })
  if (!tree) return []
  try {
    return (await tree.getBranch()).filter(isUserTurn).map(userTurnText)
  } finally {
    tree.getStorage().dispose()
  }
}

function isUserTurn(entry: ConversationEntry): boolean { return entry.kind === "message" && entry.message.kind === "user" }

function userTurnText(entry: ConversationEntry): string {
  if (entry.kind !== "message" || entry.message.kind !== "user") throw new Error("expected a user turn")
  const content = entry.message.content
  if (typeof content === "string") return content
  return content.filter((part) => part.type === "text").map((part) => part.text).join("")
}

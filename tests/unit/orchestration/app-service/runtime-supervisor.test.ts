import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { resolveSessionDir } from "../../../../src/infra/paths.js"
import type { AnyBlock } from "../../../../src/infra/output-blocks.js"
import { createFrontendProjection } from "../../../../src/orchestration/app-service/frontend-projection.js"
import { createRuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import { createTranscriptProjectionCache } from "../../../../src/orchestration/app-service/transcript-projection-cache.js"
import { createConversationTreeProjection } from "../../../../src/orchestration/session/conversation/conversation-projection.js"
import { createChatRunnerLoader } from "../../../../src/orchestration/app-service/chat-runner-loader.js"
import type { ChatRunnerDeps } from "../../../../src/orchestration/chat/runner.js"
import type { ChatRunner } from "../../../../src/orchestration/chat/runner-types.js"
import { createSessionManager, type SessionManager } from "../../../../src/orchestration/session/manager.js"
import { ConversationTreeStorage } from "../../../../src/orchestration/session/conversation/conversation-tree-storage.js"
import { readSessionDurationFromReader } from "../../../../src/orchestration/session/session-duration-projection.js"
import { EventReaderService } from "../../../../src/infra/event-store-effect.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import type { ConversationEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types.js"
import type { SessionStore } from "../../../../src/orchestration/session-store/types.js"
import { createSessionViewLoader, type ChatSessionView } from "../../../../src/orchestration/session-store/view.js"
import { createDeferred, createSupervisorTestContext, disposeSupervisorTestContext, mockRunner, supervisorBaseDeps, supervisorWithRunner, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"
let ctx: SupervisorTestContext
beforeEach(() => { ctx = createSupervisorTestContext() })
afterEach(async () => { await disposeSupervisorTestContext(ctx) })

describe("RuntimeSupervisor", () => {
  test("warms through its auth admission owner without creating a session", async () => {
    const deps = supervisorBaseDeps(ctx)
    let admissions = 0
    const capabilities = await deps.runnerCapabilities()
    const authAdmission = {
      ...capabilities.authAdmission,
      admitDefaults: async () => { admissions += 1; return capabilities.authAdmission.admitDefaults() },
    }
    const supervisor = createRuntimeSupervisor({
      ...deps,
      runnerCapabilities: async () => ({
        ...capabilities,
        authAdmission,
        runnerLoader: createChatRunnerLoader({ authAdmission }),
      }),
    })
    await expect(supervisor.warmChatRunner()).resolves.toBeUndefined()
    expect(admissions).toBe(1)
    expect(ctx.sessionStore.allIds()).toEqual([])
  })

  test("openSessionRuntime creates the chat with the new-session auth profile and keeps it when the default changes", async () => {
    let defaultProfile = "profile-a"
    const base = supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => mockRunner(deps.sessionId) })
    const supervisor = createRuntimeSupervisor({
      ...base,
      authProfileId: () => defaultProfile,
    })

    const sessionId = await supervisor.openSessionRuntime()
    expect((await ctx.manager.read(sessionId))?.authProfileId).toBe("profile-a")

    defaultProfile = "profile-b"
    await expect(supervisor.sendChat(sessionId, "keeps profile a")).resolves.toEqual({ ok: true })
    expect((await ctx.manager.read(sessionId))?.authProfileId).toBe("profile-a")
  })

  test("a fresh chat open is immediately projectable as a catalog row with a canonical execution directory", async () => {
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId))
    const projection = createFrontendProjection({ sessionStore: ctx.sessionStore, manager: ctx.manager, projectRoot: ctx.baseDir })

    const sessionId = await supervisor.openSessionRuntime()

    try {
      const row = await projection.catalogRow(sessionId)
      expect(row?.id).toBe(sessionId)
      expect(row?.executionCwd).toBe(realpathSync(ctx.baseDir))
      expect((await projection.snapshot()).rows.map((snapshotRow) => snapshotRow.id)).toEqual([sessionId])
    } finally {
      projection.dispose()
    }
  })

  test("a fresh chat open writes exactly one session.created, and the first send adds none", async () => {
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId))
    const sessionId = await supervisor.openSessionRuntime()
    expect(createdFactCount(sessionId)).toBe(1)

    await expect(supervisor.sendChat(sessionId, "first turn")).resolves.toEqual({ ok: true })
    await expect(supervisor.renameSession(sessionId, { title: "Named" })).resolves.toBe(true)

    expect(createdFactCount(sessionId)).toBe(1)
  })

  test("discarding an untouched blank chat removes its durable row and artifacts", async () => {
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId))
    const sessionId = await supervisor.openSessionRuntime()
    const sessionDir = resolveSessionDir(sessionId, ctx.baseDir)
    expect(existsSync(sessionDir)).toBe(true)

    await expect(supervisor.discardTransientChat(sessionId)).resolves.toEqual({ removed: true })

    expect(await ctx.manager.read(sessionId)).toBeNull()
    expect((await ctx.manager.listMetadata()).sessions).toEqual([])
    expect(existsSync(sessionDir)).toBe(false)
  })

  test("chat runners execute in the directory the session recorded, not the project directory", async () => {
    const nested = join(ctx.baseDir, "packages", "nested")
    mkdirSync(nested, { recursive: true })
    const executionCwd = realpathSync(nested)
    const manager = createSessionManager({ projectRoot: ctx.baseDir, executionCwd, store: ctx.store })
    let runnerCwd: string | undefined
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => {
        runnerCwd = deps.executionCwd
        return mockRunner(deps.sessionId)
      } }),
      manager,
    })

    const sessionId = await supervisor.openSessionRuntime()
    await supervisor.ensureChatRunner(sessionId)

    expect(runnerCwd).toBe(executionCwd)
    expect((await manager.read(sessionId))?.executionCwd).toBe(executionCwd)
    expect((await manager.read(sessionId))?.kind).toBe("chat")
    expect(executionCwd).not.toBe(realpathSync(ctx.baseDir))
  })

  test("closing a chat releases its transcript and conversation tree in the executor's cache", async () => {
    const reader = ctx.runtime.runSync(EventReaderService)
    const transcriptCache = createTranscriptProjectionCache({ sessionStore: ctx.sessionStore, reader, projectionReader: reader, projectRoot: ctx.baseDir })
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => mockRunner(deps.sessionId) }),
      transcriptCache,
    })
    const sessionId = await supervisor.openSessionRuntime()
    await expect(supervisor.sendChat(sessionId, "hello")).resolves.toEqual({ ok: true })
    const session = await ctx.manager.read(sessionId)
    if (session?.kind !== "chat") throw new Error("expected a chat")
    const opened = await transcriptCache.read(sessionId, session.conversationId, ctx.baseDir)
    expect(opened).not.toBeNull()
    const tree = createConversationTreeProjection(reader, session.conversationId)

    await expect(supervisor.closeChat(sessionId)).resolves.toBe(true)

    expect(createConversationTreeProjection(reader, session.conversationId)).not.toBe(tree)
    expect(await transcriptCache.read(sessionId, session.conversationId, ctx.baseDir)).not.toBe(opened)
  })

  test("chat runner creation does not own session lifecycle", async () => {
    const lifecycleWrites: string[] = []
    const manager: SessionManager = { ...ctx.manager, updateLifecycleState: (id, state) => {
      lifecycleWrites.push(`${id}:${state}`)
      return ctx.manager.updateLifecycleState(id, state)
    } }
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => {
        expect((await manager.read(deps.sessionId))?.lifecycleState).toBe("active")
        return mockRunner(deps.sessionId)
      } }), manager,
    })
    const sessionId = await supervisor.openSessionRuntime()
    await expect(supervisor.sendChat(sessionId, "hello")).resolves.toEqual({ ok: true })
    // The send resolves at its durable commit; join the startup it began, so
    // the lifecycle check inside runner creation has run and its failure surfaces.
    await supervisor.ensureChatRunner(sessionId)
    expect(lifecycleWrites).toEqual([])
    await expect(supervisor.closeChat(sessionId)).resolves.toBe(true)
    expect(lifecycleWrites).toEqual([`${sessionId}:inactive`])
  })

  test("opening three blank chats creates three visible shells and zero runners", async () => {
    let createCalls = 0
    const supervisor = supervisorWithRunner(ctx, async (deps) => {
      createCalls += 1
      return mockRunner(deps.sessionId)
    })

    const ids = await Promise.all([supervisor.openSessionRuntime(), supervisor.openSessionRuntime(), supervisor.openSessionRuntime()])

    expect(ctx.sessionStore.allIds().sort()).toEqual([...ids].sort())
    expect(createCalls).toBe(0)
  })

  test("activating an inactive chat opens history and attaches its runner; a send goes to that runner", async () => {
    const sessionId = "history-chat"
    await ctx.manager.createChat({ name: "History", initialState: "inactive", id: sessionId })
    const session = await ctx.manager.read(sessionId)
    const conversationId = session?.kind === "chat" ? session.conversationId : undefined
    if (!conversationId) throw new Error("expected chat conversation id")
    let createCalls = 0
    const injected: unknown[] = []
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => {
        createCalls += 1
        expect(deps.providerConversationId).toBe("provider-1")
        expect(deps.generateTitleForNextMessage).toBe(false)
        return mockRunner(deps.sessionId, { send: async (input) => { injected.push(input); return "accepted" as const } })
      } }),
      sessionViewLoader: {
        load: async (id) => chatView({
          id,
          description: "History",
          lifecycleState: "inactive",
          tokens: 12,
          cost: 0.03,
          contextPromptTokens: 4,
          contextPercent: 25,
          startedAt: 10,
          accumulatedActiveMs: 100_000,
          conversationId,
          providerConversationId: "provider-1",
          seedContext: "seed",
        }),
      },
    })

    await expect(supervisor.activateSession(sessionId)).resolves.toBe(true)
    const entry = ctx.sessionStore.get(sessionId)
    expect(entry?.kind).toBe("chat")
    expect(entry?.outputBlocks()).toEqual([])
    expect(entry?.accumulatedActiveMs).toBe(100_000)
    // The tab is open, so its runner attaches in the background (ARCH-SESSIONS-038).
    for (let turn = 0; turn < 50 && ctx.sessionStore.get(sessionId)?.runner === null; turn += 1) await Bun.sleep(0)
    expect(ctx.sessionStore.get(sessionId)?.runner).not.toBeNull()
    expect(createCalls).toBe(1)

    ctx.sessionStore.updateEntry(sessionId, { runnerState: "streaming", streamingStartedAt: Date.now() - 1_000 })
    ctx.sessionStore.updateEntry(sessionId, { runnerState: "idle", streamingStartedAt: null })
    const folded = ctx.sessionStore.get(sessionId)
    if (!folded) throw new Error("expected the live entry")
    expect(folded.accumulatedActiveMs).toBeGreaterThanOrEqual(101_000)
    await expect(supervisor.sendChat(sessionId, "next turn")).resolves.toEqual({ ok: true })
    expect(injected).toEqual(["next turn"])
    expect(createCalls).toBe(1)
    await expect(supervisor.closeChat(sessionId)).resolves.toBe(true)
    expect((await readSessionDurationFromReader(ctx.runtime.runSync(EventReaderService), sessionId)).accumulatedActiveMs).toBe(folded.accumulatedActiveMs)
  })

  test("activation starts the runner once; a send and a close while its capabilities load join that start", async () => {
    const sessionId = "held-capabilities-chat"
    await ctx.manager.createChat({ name: "Held", initialState: "inactive", id: sessionId })
    const durable = await ctx.manager.read(sessionId)
    if (durable?.kind !== "chat") throw new Error("expected chat metadata")
    const baseline = supervisorBaseDeps(ctx)
    const held = createDeferred<Awaited<ReturnType<typeof baseline.runnerCapabilities>>>()
    let capabilityLoads = 0
    const supervisor = createRuntimeSupervisor({
      ...baseline,
      runnerCapabilities: () => {
        capabilityLoads += 1
        return held.promise
      },
      closeStartupGraceMs: 0,
      sessionViewLoader: {
        load: async () => chatView({ id: sessionId, description: "Held", lifecycleState: "inactive", conversationId: durable.conversationId }),
      },
    })

    const activation = supervisor.activateSession(sessionId)
    // The open tab waits for its runner; a concurrent send joins that start.
    // oxlint-disable-next-line no-unmodified-loop-condition -- the pending activation increments it between turns
    for (let turn = 0; turn < 50 && capabilityLoads === 0; turn += 1) await Bun.sleep(0)
    expect(capabilityLoads).toBe(1)
    const sending = supervisor.sendChat(sessionId, "durable before capabilities")
    expect(capabilityLoads).toBe(1)
    held.resolve(await baseline.runnerCapabilities())
    await expect(activation).resolves.toBe(true)
    await expect(sending).resolves.toEqual({ ok: true })
    await expect(supervisor.closeChat(sessionId)).resolves.toBe(true)
    expect(capabilityLoads).toBe(1)
  })

  test("fork stays inactive and nonresident until an explicit follow-up activates copied context", async () => {
    const sourceSessionId = await ctx.manager.createChat({ name: "Source title", initialState: "inactive" })
    const source = await ctx.manager.read(sourceSessionId)
    if (source?.kind !== "chat") throw new Error("expected source chat")
    const sourceTree = await ConversationTreeStorage.open({
      conversationId: source.conversationId,
      sessionId: sourceSessionId,
      store: asAsyncEventReadSurface(ctx.store),
      writer: asAsyncEventWriter(ctx.store),
    })
    await sourceTree.appendEntry({
      kind: "message",
      id: "source-user",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { kind: "user", content: "copied question" },
    })
    sourceTree.dispose()
    let createCalls = 0
    const delivered: string[] = []
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => {
        createCalls += 1
        expect(deps.hasPriorBlocks).toBe(true)
        expect(deps.generateTitleForNextMessage).toBe(false)
        return mockRunner(deps.sessionId, { send: async (input) => {
          if (typeof input === "string") delivered.push(input)
          return "accepted" as const
        } })
      } }),
      sessionViewLoader: createSessionViewLoader({ reader: ctx.runtime.runSync(EventReaderService), projectionReader: ctx.runtime.runSync(EventReaderService), writer: ctx.store }),
    })

    const destinationSessionId = await supervisor.forkSession(sourceSessionId)
    const destination = await ctx.manager.read(destinationSessionId)
    if (destination?.kind !== "chat") throw new Error("expected destination chat")
    const labels = { label: destination.label, shortLabel: destination.shortLabel, name: destination.name }

    expect(destination.lifecycleState).toBe("inactive")
    expect(ctx.sessionStore.has(destinationSessionId)).toBe(false)
    expect(supervisor.runtimeState(destinationSessionId)).toBeNull()
    expect(existsSync(join(resolveSessionDir(destinationSessionId, ctx.baseDir), "owner.pid"))).toBe(false)
    expect(createCalls).toBe(0)

    expect(await supervisor.sendChat(destinationSessionId, "follow-up")).toEqual({ ok: true })

    expect(await ctx.manager.read(destinationSessionId)).toMatchObject({ lifecycleState: "active", ...labels })
    expect(await ctx.manager.read(sourceSessionId)).toMatchObject({
      lifecycleState: "inactive",
      label: "Source title",
      name: "Source title",
    })
    expect(await durableUserCount(sourceSessionId, source.conversationId)).toBe(1)
    expect(await durableUserCount(destinationSessionId, destination.conversationId)).toBe(1)
    expect(delivered).toEqual(["follow-up"])
    expect(ctx.sessionStore.has(destinationSessionId)).toBe(true)
    expect(createCalls).toBe(1)
  })

  test("closed committed chat can reactivate and send again", async () => {
    let createCalls = 0
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => {
        createCalls += 1
        return mockRunner(deps.sessionId)
      } }),
      sessionViewLoader: {
        load: async (id) => {
          const session = await ctx.manager.read(id)
          if (session?.kind !== "chat") return null
          return chatView({ id, description: session.name ?? "New Chat", lifecycleState: session.lifecycleState, conversationId: session.conversationId })
        },
      },
    })
    const sessionId = await supervisor.openSessionRuntime()

    await expect(supervisor.sendChat(sessionId, "first turn")).resolves.toEqual({ ok: true })
    await expect(supervisor.closeChat(sessionId)).resolves.toBe(true)
    expect((await ctx.manager.read(sessionId))?.lifecycleState).toBe("inactive")

    await expect(supervisor.activateSession(sessionId)).resolves.toBe(true)
    await expect(supervisor.sendChat(sessionId, "second turn")).resolves.toEqual({ ok: true })

    expect(createCalls).toBe(2)
  })

  test("pre-readiness send commits one durable user entry before runner creation and delivery", async () => {
    const sequence: string[] = []
    let atCreation: { readonly userEntries: number; readonly titleArmed: boolean | undefined } | undefined
    const delivered = createDeferred<void>()
    const supervisor = supervisorWithRunner(ctx, async (deps) => {
      sequence.push("createRunner")
      atCreation = { userEntries: await durableUserCount(deps.sessionId, deps.conversationId), titleArmed: deps.generateTitleForNextMessage }
      return mockRunner(deps.sessionId, { deliverCommitted: () => { sequence.push("deliver"); delivered.resolve(); return true } })
    })
    const sessionId = await supervisor.openSessionRuntime()

    await expect(supervisor.sendChat(sessionId, "hello")).resolves.toEqual({ ok: true })
    const entry = ctx.sessionStore.get(sessionId)
    if (entry?.kind !== "chat") throw new Error("expected chat entry")
    expect(await durableUserCount(sessionId, entry.conversationId)).toBe(1)

    // A cold send resolves once its input is durable. The runner that the send
    // started takes the input when it attaches, which can be later (ARCH-SUBSTRATE-036).
    await delivered.promise
    expect(atCreation).toEqual({ userEntries: 1, titleArmed: true })
    expect(sequence).toEqual(["createRunner", "deliver"])
  })

  test("adopting a blank durable chat arms both first-message title updates", async () => {
    const sessionId = "project-control-chat"
    await ctx.manager.createChat({ id: sessionId, name: "New Chat" })
    const durable = await ctx.manager.read(sessionId)
    if (durable?.kind !== "chat") throw new Error("expected chat metadata")
    const created = createDeferred<ChatRunnerDeps>()
    const supervisor = supervisorWithRunner(ctx, async (deps) => {
      created.resolve(deps)
      return mockRunner(sessionId)
    })

    supervisor.adoptBlankChat({
      sessionId,
      conversationId: durable.conversationId,
      description: durable.label,
    })
    await expect(supervisor.sendChat(sessionId, "titles should work")).resolves.toEqual({ ok: true })
    // The send resolves at its durable commit; the runner it started can come later.
    const runnerDeps = await created.promise
    expect(runnerDeps.generateTitleForNextMessage).toBe(true)

    async function applyTitle(label: string, shortLabel: string): Promise<void> {
      const changed = Promise.withResolvers<void>()
      const unsubscribe = ctx.manager.subscribe((change) => {
        if (change.kind === "changed" && change.sessionIds.includes(sessionId)) changed.resolve()
      })
      runnerDeps.onSessionName?.({ label, shortLabel })
      await changed.promise
      unsubscribe()
    }

    await applyTitle("titles should work", "titles should")
    expect(await ctx.manager.read(sessionId)).toMatchObject({ label: "titles should work", shortLabel: "titles should" })
    await applyTitle("Restore Generated Session Titles", "Restore titles")
    expect(await ctx.manager.read(sessionId)).toMatchObject({ label: "Restore Generated Session Titles", shortLabel: "Restore titles" })
  })

  test("concurrent pre-readiness sends stay on the active durable branch", async () => {
    const deferred = createDeferred<ChatRunner>()
    let deliverCalls = 0
    const bothDelivered = createDeferred<void>()
    const runner = mockRunner("pending", {
      deliverCommitted: () => { deliverCalls += 1; if (deliverCalls === 2) bothDelivered.resolve(); return true },
    })
    const supervisor = supervisorWithRunner(ctx, async () => deferred.promise)
    const sessionId = await supervisor.openSessionRuntime()
    const entry = ctx.sessionStore.get(sessionId)
    if (entry?.kind !== "chat") throw new Error("expected chat entry")

    const first = supervisor.sendChat(sessionId, "first")
    const second = supervisor.sendChat(sessionId, "second")
    for (let i = 0; i < 20 && await durableUserCount(sessionId, entry.conversationId) < 2; i++) await Promise.resolve()
    deferred.resolve(runner)

    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }])
    expect(await durableUserCount(sessionId, entry.conversationId)).toBe(2)
    await bothDelivered.promise
    expect(deliverCalls).toBe(2)
  })

  test("a send landing while the host is still starting is included in the attach-time display seed", async () => {
    const deferred = createDeferred<ChatRunner>()
    const seeded = createDeferred<readonly AnyBlock[]>()
    const runner = mockRunner("pending", { seedDisplayBlocks: (blocks) => { seeded.resolve(blocks) } })
    const supervisor = supervisorWithRunner(ctx, async () => deferred.promise)
    const sessionId = await supervisor.openSessionRuntime()
    const entry = ctx.sessionStore.get(sessionId)
    if (entry?.kind !== "chat") throw new Error("expected chat entry")

    // First cold send commits and starts the host (parked on the deferred);
    // the second lands while that startup is still in flight.
    const first = supervisor.sendChat(sessionId, "first")
    for (let i = 0; i < 20 && await durableUserCount(sessionId, entry.conversationId) < 1; i++) await Promise.resolve()
    const second = supervisor.sendChat(sessionId, "second")
    for (let i = 0; i < 20 && await durableUserCount(sessionId, entry.conversationId) < 2; i++) await Promise.resolve()
    deferred.resolve(runner)
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }])

    const seededMessages = (await seeded.promise).flatMap((block) => (block.kind === "userMessage" ? [block.content] : []))
    expect(seededMessages).toEqual(["first", "second"])
    expect(entry.outputBlocks().flatMap((block) => (block.kind === "userMessage" ? [block.content] : []))).toEqual(["first", "second"])
  })

  test("pre-readiness send triggers exactly one committed delivery after attach", async () => {
    let deliverCalls = 0
    let injectCalls = 0
    const delivered = createDeferred<void>()
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId, {
      deliverCommitted: () => { deliverCalls += 1; delivered.resolve(); return true },
      send: async () => { injectCalls += 1; return "accepted" as const },
    }))
    const sessionId = await supervisor.openSessionRuntime()

    await expect(supervisor.sendChat(sessionId, "run once")).resolves.toEqual({ ok: true })

    await delivered.promise
    expect(deliverCalls).toBe(1)
    expect(injectCalls).toBe(0)
  })

  test("closing during startup disposes the late runner and never attaches it", async () => {
    const deferred = createDeferred<ChatRunner>()
    const constructionStarted = createDeferred<void>()
    let attachCalls = 0
    const wrappedStore: SessionStore = {
      ...ctx.sessionStore,
      attachChatRunner: (sessionId, runner) => {
        attachCalls += 1
        return ctx.sessionStore.attachChatRunner(sessionId, runner)
      },
    }
    const runner = mockRunner("late")
    const supervisor = createRuntimeSupervisor(supervisorBaseDeps(ctx, wrappedStore, { createRunner: async () => {
      constructionStarted.resolve()
      return deferred.promise
    } }))
    const sessionId = await supervisor.openSessionRuntime()
    const startup = supervisor.ensureChatRunner(sessionId).catch((err) => err)
    await constructionStarted.promise
    const close = supervisor.closeChat(sessionId)

    deferred.resolve(runner)
    await close
    await startup

    expect(runner.disposeCalls()).toBe(1)
    expect(attachCalls).toBe(0)
    expect(ctx.sessionStore.get(sessionId)).toBeUndefined()
  })

  test("close completes even when the cold-start never returns, so a wedged startup can't make a tab unclosable", async () => {
    const neverSettles = createDeferred<ChatRunner>()
    const supervisor = createRuntimeSupervisor({ ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async () => neverSettles.promise }), closeStartupGraceMs: 0 })
    const sessionId = await supervisor.openSessionRuntime()
    // Kick the cold start off in the background (as a first send would) and leave it hung.
    void supervisor.ensureChatRunner(sessionId).catch(() => {})

    await expect(supervisor.closeChat(sessionId)).resolves.toBe(true)
    expect(ctx.sessionStore.get(sessionId)).toBeUndefined()
    expect(await ctx.manager.read(sessionId)).toBeNull()
  })

  test("close succeeds for a durable session that is no longer resident", async () => {
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId))
    const sessionId = await supervisor.openSessionRuntime()
    await supervisor.sendChat(sessionId, "keep me")

    // First close deactivates the session and evicts it from the resident store.
    await expect(supervisor.closeChat(sessionId)).resolves.toBe(true)
    expect(ctx.sessionStore.get(sessionId)).toBeUndefined()
    expect((await ctx.manager.read(sessionId))?.lifecycleState).toBe("inactive")

    // A tab can still reference the session after it left the resident store
    // (e.g. a workflow that went inactive under an open tab); closing that tab
    // must succeed via the durable record rather than failing the command.
    await expect(supervisor.closeChat(sessionId)).resolves.toBe(true)

    // Sessions unknown to both the store and the durable record are already
    // closed: close is idempotent user intent and never refuses.
    await expect(supervisor.closeChat("no-such-session")).resolves.toBe(true)
  })

  test("startup rejection leaves a visible failed shell with a system error block", async () => {
    const supervisor = supervisorWithRunner(ctx, async () => { throw new Error("provider unavailable") })
    const sessionId = await supervisor.openSessionRuntime()

    await expect(supervisor.ensureChatRunner(sessionId)).rejects.toThrow("provider unavailable")
    const entry = ctx.sessionStore.get(sessionId)

    expect(entry?.kind).toBe("chat")
    expect(supervisor.runtimeState(sessionId)).toEqual({ kind: "failed", message: "provider unavailable" })
    expect(entry?.outputBlocks().some((block) => block.kind === "system" && block.level === "error" && block.message.includes("provider unavailable"))).toBe(true)
  })

  test("close tombstones only truly empty blank shells", async () => {
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId))
    const blankId = await supervisor.openSessionRuntime()
    await supervisor.closeChat(blankId)

    const committedId = await supervisor.openSessionRuntime()
    await supervisor.sendChat(committedId, "keep me")
    await supervisor.closeChat(committedId)

    // A startup error is not durable, so the chat whose runner failed is as
    // empty as the blank one.
    const failedSupervisor = supervisorWithRunner(ctx, async () => { throw new Error("boom") })
    const failedId = await failedSupervisor.openSessionRuntime()
    await failedSupervisor.ensureChatRunner(failedId).catch(() => {})
    await failedSupervisor.closeChat(failedId)

    expect(await ctx.manager.read(blankId)).toBeNull()
    expect((await ctx.manager.read(committedId))?.lifecycleState).toBe("inactive")
    expect(await ctx.manager.read(failedId)).toBeNull()
  })

  test("resident deletion waits for runner disposal before deleting artifacts", async () => {
    const release = createDeferred<void>()
    const sequence: string[] = []
    const manager: SessionManager = {
      ...ctx.manager,
      finalizeDeletionTarget: async (target) => {
        sequence.push("delete")
        return await ctx.manager.finalizeDeletionTarget(target)
      },
    }
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => mockRunner(deps.sessionId, {
        dispose: async () => {
          sequence.push("dispose:start")
          await release.promise
          sequence.push("dispose:done")
        },
      }) }),
      manager,
    })
    const sessionId = await supervisor.openSessionRuntime()
    await supervisor.sendChat(sessionId, "keep me")

    const deleting = supervisor.deleteSession(sessionId)
    for (let i = 0; i < 20 && sequence.length === 0; i++) await Promise.resolve()
    expect(sequence).toEqual(["dispose:start"])

    release.resolve()
    await deleting
    expect(sequence).toEqual(["dispose:start", "dispose:done", "delete"])
  })

})

async function durableUserCount(sessionId: string, conversationId: string): Promise<number> {
  const tree = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(ctx.store) })
  if (!tree) return 0
  try {
    const branch = await tree.getBranch()
    return branch.filter(isUserTurn).length
  } finally {
    await tree.getStorage().dispose()
  }
}

/** A loaded chat with no runner activity, as `loadSessionView` reads an inactive one. */
function chatView(fields: Pick<ChatSessionView, "id" | "description" | "lifecycleState" | "conversationId"> & Partial<ChatSessionView>): ChatSessionView {
  return {
    kind: "chat",
    outputBlocks: [],
    streamingToolText: {},
    tokens: 0,
    cost: 0,
    billedCost: 0,
    priceUnavailable: false,
    contextPromptTokens: 0,
    contextPercent: 0,
    startedAt: 0,
    activity: "absent",
    streamingStartedAt: null,
    activityStartedAt: null,
    accumulatedActiveMs: 0,
    connectionState: "connected",
    notices: [],
    compactionStartedAt: null,
    ...fields,
  }
}

function isUserTurn(entry: ConversationEntry): boolean { return entry.kind === "message" && entry.message.kind === "user" }

function createdFactCount(sessionId: string): number {
  return ctx.store.read({ aggregateId: `session:${sessionId}`, types: ["session.created"] }).length
}

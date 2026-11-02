import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { registerTestChildRun } from "../../../helpers/live-child-run"
import { DebugLog } from "../../../../src/infra/debug-log.js"
import { EventReaderService } from "../../../../src/infra/event-store-effect.js"
import { createRuntimeSupervisor as createRuntimeSupervisorBase } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import type { ChatRunner } from "../../../../src/orchestration/chat/runner-types.js"
import type { ChatRunnerDeps } from "../../../../src/orchestration/chat/runner.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { createDeferred, createSupervisorTestContext, disposeSupervisorTestContext, mockRunner, supervisorBaseDeps, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { publishTestSubagent } from "../session/_session-manager-fixtures.js"

const createRuntimeSupervisor = createRuntimeSupervisorBase

let ctx: SupervisorTestContext

beforeEach(() => { ctx = createSupervisorTestContext() })
afterEach(async () => { await disposeSupervisorTestContext(ctx) })

function supervisor() {
  return createRuntimeSupervisor(supervisorBaseDeps(ctx))
}

function supervisorWithRunner(createRunner: (deps: ChatRunnerDeps) => Promise<ChatRunner>) {
  return createRuntimeSupervisor(supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner }))
}

describe("RuntimeSupervisor close tombstone", () => {
  test("releases state admission before awaited child settlement", async () => {
    const parent = await ctx.manager.createChat({
      id: "parent",
      conversationId: "parent-conversation",
      name: "Parent",
      initialState: "inactive",
    })
    const child = await publishTestSubagent(ctx.manager, ctx.baseDir, "child", parent, "parent-conversation")
    const interrupted = Promise.withResolvers<void>()
    const settlement = Promise.withResolvers<void>()
    const unregister = registerTestChildRun(ctx.runtime.runSync(EventReaderService), {
      sessionId: child,
      runId: "child-run",
      parentSessionId: parent,
      parentConversationId: "parent-conversation",
      parentToolCallId: "child-tool",
      settled: settlement.promise,
      stop: () => interrupted.resolve(),
      interrupt: async () => {},
    })
    try {
      const deleting = supervisor().deleteSession(parent)
      await interrupted.promise

      const sibling = await ctx.manager.createChat({ id: "sibling", name: "Sibling", initialState: "inactive" })
      expect(sibling).toBe("sibling")
      expect(await ctx.manager.read(parent)).not.toBeNull()

      settlement.resolve()
      await deleting
      expect(await ctx.manager.read(parent)).toBeNull()
      expect(await ctx.manager.read(child)).toBeNull()
    } finally {
      settlement.resolve()
      unregister()
    }
  })

  test("preserves a chat with visible user output before the tree flush is observable", async () => {
    const sup = supervisor()
    const sessionId = await sup.openSessionRuntime()
    ctx.sessionStore.appendPreRunnerOutput(sessionId, { kind: "userMessage", id: "user-visible", content: "visible but not tree-flushed", timestamp: 1, pending: false, injected: false })

    await sup.closeChat(sessionId)

    expect((await ctx.manager.read(sessionId))?.lifecycleState).toBe("inactive")
  })

  test("a pre-readiness committed user turn survives RuntimeSupervisor recreation and blocks tombstone via the durable tree", async () => {
    const deferred = createDeferred<ChatRunner>()
    const creating = createDeferred<void>()
    const first = supervisorWithRunner(async () => { creating.resolve(); return deferred.promise })
    const sessionId = await first.openSessionRuntime()
    const entry = ctx.sessionStore.get(sessionId)
    if (entry?.kind !== "chat") throw new Error("expected chat shell")

    // Commit the user turn durably while the runner startup is still pending, so
    // no in-memory committed-id cache could persist past supervisor recreation.
    const sending = first.sendChat(sessionId, "remember me")
    await creating.promise
    expect(await durableUserCount(sessionId, entry.conversationId)).toBe(1)

    // A fresh supervisor against the same SQLite store has an empty in-memory
    // state. Reactivating and closing must still read the durable user turn and
    // refuse to tombstone -- the durable tree is the only authority.
    const fresh = supervisorWithRunner(async (deps) => mockRunner(deps.sessionId))
    await fresh.activateSession(sessionId)
    await fresh.closeChat(sessionId)

    expect((await ctx.manager.read(sessionId))?.lifecycleState).toBe("inactive")
    expect(ctx.sessionStore.has(sessionId)).toBe(false)

    deferred.resolve(mockRunner(sessionId))
    await sending.catch(() => {})
  })

  test("renaming a transient chat marks its durable row user-named so it survives close", async () => {
    const sup = supervisorWithRunner(async (deps) => mockRunner(deps.sessionId))
    const sessionId = await sup.openSessionRuntime()
    expect((await ctx.manager.read(sessionId))?.userNamed).toBeUndefined()

    await expect(sup.renameSession(sessionId, { title: "  My Research Chat  ", shortTitle: "My tab" })).resolves.toBe(true)
    await expect(sup.renameSession(sessionId, { title: "My Research Chat" })).resolves.toBe(true)

    const session = await ctx.manager.read(sessionId)
    expect(session?.label).toBe("My Research Chat")
    expect(session?.shortLabel).toBe("My tab")
    expect(session?.userNamed).toBe(true)
    const entry = ctx.sessionStore.get(sessionId)
    expect(entry?.kind === "chat" && entry.description).toBe("My Research Chat")

    // User naming is deliberate state: close deactivates instead of tombstoning.
    await sup.closeChat(sessionId)
    expect((await ctx.manager.read(sessionId))?.lifecycleState).toBe("inactive")
  })

  test("renameSession rejects blank names and unknown sessions", async () => {
    const sup = supervisor()
    const sessionId = await sup.openSessionRuntime()

    await expect(sup.renameSession(sessionId, { title: "   " })).resolves.toBe(false)
    await expect(sup.renameSession("no-such-session", { title: "Name" })).resolves.toBe(false)
  })

  test("a user rename gates generated titles: refused durably and never mirrored to the live entry", async () => {
    let captured: ChatRunnerDeps | undefined
    const sup = supervisorWithRunner(async (deps) => { captured = deps; return mockRunner(deps.sessionId) })
    const sessionId = await sup.openSessionRuntime()
    await sup.renameSession(sessionId, { title: "Chosen Name" })

    await sup.sendChat(sessionId, "first message")
    await Bun.sleep(0)
    // The runner is created after the rename, so it skips generation outright.
    expect(captured?.suppressTitleGeneration).toBe(true)

    // A stray generated title (an in-flight LLM result) landing anyway is
    // refused by the durable gate and never reaches the live entry.
    captured?.onSessionName?.({ label: "Generated Title", shortLabel: "Gen" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await ctx.manager.read(sessionId))?.label).toBe("Chosen Name")
    const entry = ctx.sessionStore.get(sessionId)
    expect(entry?.kind === "chat" && entry.description).toBe("Chosen Name")
  })

  test("a generated title is accepted and mirrored to the live entry when the session is not user-named", async () => {
    let captured: ChatRunnerDeps | undefined
    const sup = supervisorWithRunner(async (deps) => { captured = deps; return mockRunner(deps.sessionId) })
    const sessionId = await sup.openSessionRuntime()
    await sup.sendChat(sessionId, "first message")
    await Bun.sleep(0)
    expect(captured?.suppressTitleGeneration).toBe(false)

    captured?.onSessionName?.({ label: "Generated Title", shortLabel: "Gen" })
    // The live mirror is written in the updateLabel continuation; poll it.
    const description = () => { const entry = ctx.sessionStore.get(sessionId); return entry?.kind === "chat" ? entry.description : undefined }
    for (let i = 0; i < 50 && description() !== "Generated Title"; i++) await new Promise((resolve) => setTimeout(resolve, 1))
    expect((await ctx.manager.read(sessionId))?.label).toBe("Generated Title")
    expect(description()).toBe("Generated Title")
  })

  test("a generated title or chat metadata that the manager refuses is recorded at WARN and never rejects unhandled", async () => {
    let captured: ChatRunnerDeps | undefined
    const sup = supervisorWithRunner(async (deps) => { captured = deps; return mockRunner(deps.sessionId) })
    const sessionId = await sup.openSessionRuntime()
    await sup.sendChat(sessionId, "first message")
    await Bun.sleep(0)
    spyOn(ctx.manager, "updateLabel").mockRejectedValue(new Error("label write refused"))
    spyOn(ctx.manager, "updateChatMetadata").mockRejectedValue(new Error("metadata write refused"))
    spyOn(DebugLog, "isOpen").mockReturnValue(true)
    const record = spyOn(DebugLog, "record").mockImplementation(() => {})
    try {
      captured?.onSessionName?.({ label: "Generated Title", shortLabel: "Gen" })
      captured?.onChatMetadata?.({ providerConversationId: "provider-1" })
      // bun test fails the running test on an unhandled rejection.
      await Bun.sleep(0)

      const records = record.mock.calls.map(([input]) => input).filter((input) => input.type === "log.warn" || input.type === "log.error")
      expect(records).toHaveLength(2)
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "log.warn", sessionId, payload: expect.objectContaining({ message: "record generated session name failed", error: "label write refused" }) }),
        expect.objectContaining({ type: "log.warn", sessionId, payload: expect.objectContaining({ message: "record chat metadata failed", error: "metadata write refused" }) }),
      ]))
    } finally {
      mock.restore()
    }
  })

  test("discardTransient uses the same durable tombstone predicate as close and refuses a chat with a durable user turn", async () => {
    const deferred = createDeferred<ChatRunner>()
    const creating = createDeferred<void>()
    let blankRunner: ReturnType<typeof mockRunner> | undefined
    const sup = supervisorWithRunner(async (deps) => {
      if (deps.sessionId !== sessionId) {
        blankRunner = mockRunner(deps.sessionId)
        return blankRunner
      }
      creating.resolve()
      return deferred.promise
    })
    const sessionId = await sup.openSessionRuntime()
    const entry = ctx.sessionStore.get(sessionId)
    if (entry?.kind !== "chat") throw new Error("expected chat shell")

    const sending = sup.sendChat(sessionId, "durable turn")
    await creating.promise

    // A truly empty sibling discards; the one with a durable user turn does not.
    const blankId = await sup.openSessionRuntime()
    await sup.activateSession(blankId)
    const blank = ctx.sessionStore.get(blankId)
    expect(blank?.kind === "chat" && blank.runner !== null).toBe(true)
    await expect(sup.discardTransientChat(blankId)).resolves.toEqual({ removed: true })
    expect(blankRunner?.disposeCalls()).toBe(1)
    expect(ctx.sessionStore.has(blankId)).toBe(false)
    expect(await ctx.manager.read(blankId)).toBeNull()
    await expect(sup.discardTransientChat(sessionId)).resolves.toEqual({ removed: false })

    deferred.resolve(mockRunner(sessionId))
    await sending.catch(() => {})
  })
})

async function durableUserCount(sessionId: string, conversationId: string): Promise<number> {
  const tree = await tryOpenConversationTree({ conversationId, sessionId, store: ctx.runtime.runSync(EventReaderService) })
  if (!tree) return 0
  try {
    return (await tree.getBranch()).filter((e) => e.kind === "message" && e.message.kind === "user").length
  } finally {
    tree.getStorage().dispose()
  }
}

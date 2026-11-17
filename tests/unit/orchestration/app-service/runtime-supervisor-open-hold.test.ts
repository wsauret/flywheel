import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createSupervisorTestContext, disposeSupervisorTestContext, mockRunner, supervisorWithRunner, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"

let ctx: SupervisorTestContext
beforeEach(() => { ctx = createSupervisorTestContext() })
afterEach(async () => { await disposeSupervisorTestContext(ctx) })

describe("RuntimeSupervisor open holds", () => {
  test("an open hold keeps a chat open past its tab's close, and its end closes nothing", async () => {
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId))
    const sessionId = await supervisor.openSessionRuntime()
    await supervisor.sendChat(sessionId, "start")
    await supervisor.activateSession(sessionId, { shown: true })
    await settled()
    const hold = supervisor.createOpenHold()
    hold.hold(sessionId)

    // The tab closes while the hold lasts.
    await supervisor.closeChat(sessionId, true)
    await supervisor.releaseSession(sessionId)
    await settled()
    expect((await ctx.manager.read(sessionId))?.lifecycleState).toBe("active")

    // The hold ends while no client shows the chat, and the chat stays open.
    hold.release(sessionId)
    await settled()
    expect((await ctx.manager.read(sessionId))?.lifecycleState).toBe("active")

    // A dropped holder closes nothing either.
    const other = supervisor.createOpenHold()
    other.hold(sessionId)
    other.drop()
    await settled()
    expect((await ctx.manager.read(sessionId))?.lifecycleState).toBe("active")
  })

  test("a hold's close closes the chat as a tab's close does, only when no other holder holds it and no client shows it, and tells no close listener", async () => {
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId))
    const sessionId = await supervisor.openSessionRuntime()
    await supervisor.sendChat(sessionId, "start")
    await settled()
    const closed: string[] = []
    supervisor.onChatClosed((id) => { closed.push(id) })
    const hold = supervisor.createOpenHold()
    const other = supervisor.createOpenHold()
    hold.hold(sessionId)
    other.hold(sessionId)

    await hold.close(sessionId)
    await settled()
    expect((await ctx.manager.read(sessionId))?.lifecycleState).toBe("active")

    other.release(sessionId)
    await supervisor.activateSession(sessionId, { shown: true })
    hold.hold(sessionId)
    await hold.close(sessionId)
    await settled()
    expect((await ctx.manager.read(sessionId))?.lifecycleState).toBe("active")

    await supervisor.releaseSession(sessionId)
    hold.hold(sessionId)
    await hold.close(sessionId)
    await settled()
    expect((await ctx.manager.read(sessionId))?.lifecycleState).toBe("inactive")
    expect(closed).toEqual([])
  })
})

describe("RuntimeSupervisor person closes", () => {
  test("a close by the person tells each listener, also for an inactive chat and an unheld tab close, and a hold-blocked tab close or a stop tells none", async () => {
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId))
    const closed: string[] = []
    const unsubscribe = supervisor.onChatClosed((sessionId) => { closed.push(sessionId) })
    const held = await supervisor.openSessionRuntime()
    const tab = await supervisor.openSessionRuntime()
    const modal = await supervisor.openSessionRuntime()
    for (const sessionId of [held, tab, modal]) await supervisor.sendChat(sessionId, "start")
    await settled()
    const hold = supervisor.createOpenHold()
    hold.hold(held)

    // A tab close that a hold blocks.
    await supervisor.closeChat(held, true)
    // A tab close that no hold blocks.
    await supervisor.closeChat(tab, true)
    // Close chat, as the Sessions list or the web client sends it, and again once the chat is inactive.
    await supervisor.closeChat(modal)
    await settled()
    expect((await ctx.manager.read(modal))?.lifecycleState).toBe("inactive")
    await supervisor.closeChat(modal)
    expect(closed).toEqual([tab, modal, modal])

    unsubscribe()
    await supervisor.closeChat(held)
    expect(closed).toEqual([tab, modal, modal])

    // A stop deactivates the open chats and tells no listener.
    supervisor.onChatClosed((sessionId) => { closed.push(sessionId) })
    await supervisor.disposeAll()
    expect(closed).toEqual([tab, modal, modal])
  })

  test("a chat shows while a client's activation holds it, until its release", async () => {
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId))
    const sessionId = await supervisor.openSessionRuntime()
    expect(supervisor.isShown(sessionId)).toBe(false)
    await supervisor.activateSession(sessionId, { shown: true })
    expect(supervisor.isShown(sessionId)).toBe(true)
    await supervisor.releaseSession(sessionId)
    expect(supervisor.isShown(sessionId)).toBe(false)
  })
})

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

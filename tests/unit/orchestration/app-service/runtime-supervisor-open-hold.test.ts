import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { SessionStore } from "../../../../src/orchestration/session-store/types.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, mockRunner, supervisorWithRunner, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"

let ctx: SupervisorTestContext
beforeEach(() => { ctx = createSupervisorTestContext() })
afterEach(async () => { await disposeSupervisorTestContext(ctx) })

describe("RuntimeSupervisor open holds", () => {
  test("an open hold that ends while the turn runs ends no work, and closes the chat once the turn comes to rest", async () => {
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId))
    const sessionId = await supervisor.openSessionRuntime()
    await supervisor.sendChat(sessionId, "keep working")
    await settled()
    const hold = supervisor.createOpenHold()
    hold.hold(sessionId)
    // A tab shows the chat while its turn runs, and closes.
    await supervisor.activateSession(sessionId, { shown: true })
    await settled()
    ctx.sessionStore.updateChatEntry(sessionId, { runnerState: "streaming" })
    await supervisor.closeChat(sessionId, true)
    await supervisor.releaseSession(sessionId)

    await hold.release(sessionId)
    await settled()
    expect(chatEntry(sessionId).runner).not.toBeNull()
    expect((await ctx.manager.read(sessionId))?.lifecycleState).toBe("active")

    ctx.sessionStore.updateChatEntry(sessionId, { runnerState: "idle" })
    await settled()
    expect(ctx.sessionStore.get(sessionId)).toBeUndefined()
    expect((await ctx.manager.read(sessionId))?.lifecycleState).toBe("inactive")
  })

  test("an open hold keeps a chat open past its tab's close, and its end closes nothing while a client shows the chat", async () => {
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

    // A tab shows the chat when the hold ends.
    await supervisor.activateSession(sessionId, { shown: true })
    await hold.release(sessionId)
    await settled()
    expect((await ctx.manager.read(sessionId))?.lifecycleState).toBe("active")

    // A dropped holder closes nothing either.
    const other = supervisor.createOpenHold()
    other.hold(sessionId)
    other.drop()
    await supervisor.releaseSession(sessionId)
    await settled()
    expect((await ctx.manager.read(sessionId))?.lifecycleState).toBe("active")
  })
})

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function chatEntry(sessionId: string): Extract<NonNullable<ReturnType<SessionStore["get"]>>, { kind: "chat" }> {
  const entry = ctx.sessionStore.get(sessionId)
  if (entry?.kind !== "chat") throw new Error("expected chat entry")
  return entry
}

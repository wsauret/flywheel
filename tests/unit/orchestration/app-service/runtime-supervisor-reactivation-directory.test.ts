import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { createRuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import { loadSessionView } from "../../../../src/orchestration/session-store/view.js"
import { mockRunner, supervisorBaseDeps, createSupervisorTestContext, disposeSupervisorTestContext, supervisorConversationFixture, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { historicalSessionCreatedFacts } from "../../../fixtures/tolerant-reprojection-fixtures.js"

let ctx: SupervisorTestContext
const { commitUserTurn } = supervisorConversationFixture(() => ctx)

beforeEach(() => {
  ctx = createSupervisorTestContext()
})

afterEach(async () => {
  await disposeSupervisorTestContext(ctx)
})

describe("RuntimeSupervisor re-activation execution directory fallback", () => {
  test("session_metadata historical chat activation opens session.created@1 and @2 through the project fallback without repair", async () => {
    await ctx.store.appendBatch(historicalSessionCreatedFacts("legacy-reactivate"))
    for (const version of [1, 2]) {
      const sessionId = `legacy-reactivate-${version}`
      const conversationId = `legacy-conversation-${version}`
      await ctx.store.append({ aggregateId: `conversation:${conversationId}`, sessionId, type: "chat.tree.created", version: 1, actor: "flywheel", timestamp: 3 + version, payload: { conversationId, createdAt: "2023-11-14T22:13:20.000Z" } })
      await commitUserTurn(sessionId)
    }
    const runnerCwds: string[] = []
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => { runnerCwds.push(deps.executionCwd); return mockRunner(deps.sessionId) } }),
      sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) },
    })

    expect(await supervisor.activateSession("legacy-reactivate-1")).toBe(true)
    expect(await supervisor.activateSession("legacy-reactivate-2")).toBe(true)
    expect(await supervisor.sendChat("legacy-reactivate-1", "new v1 turn")).toEqual({ ok: true })
    expect(await supervisor.sendChat("legacy-reactivate-2", "new v2 turn")).toEqual({ ok: true })
    expect(runnerCwds).toEqual([realpathSync(ctx.baseDir), realpathSync(ctx.baseDir)])
    expect(ctx.store.read({ aggregateId: "session:legacy-reactivate-1", types: ["session.execution_cwd.updated"] })).toEqual([])
    expect(ctx.store.read({ aggregateId: "session:legacy-reactivate-2", types: ["session.execution_cwd.updated"] })).toEqual([])
    await supervisor.disposeAll()
  })

  test("identity-only metadata activates and cold-sends through the project fallback without repair", async () => {
    const sessionId = "identity-only"
    const conversationId = "identity-conversation"
    await ctx.store.append({ aggregateId: `session:${sessionId}`, sessionId, type: "session.created", version: 3, actor: "flywheel", timestamp: 1, payload: { kind: "chat", command: "chat", conversationId, label: "Identity", lastUpdated: "2023-11-14T22:13:20.000Z", lifecycleState: "inactive" } })
    await ctx.store.append({ aggregateId: `conversation:${conversationId}`, sessionId, type: "chat.tree.created", version: 1, actor: "flywheel", timestamp: 2, payload: { conversationId, createdAt: "2023-11-14T22:13:20.000Z" } })
    await commitUserTurn(sessionId)
    let runnerCwd: string | undefined
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => { runnerCwd = deps.executionCwd; return mockRunner(deps.sessionId) } }),
      sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) },
    })

    expect(await supervisor.activateSession(sessionId)).toBe(true)
    expect(await supervisor.sendChat(sessionId, "new turn")).toEqual({ ok: true })
    expect(runnerCwd).toBe(realpathSync(ctx.baseDir))
    expect((await ctx.manager.read(sessionId))?.executionCwd).toBeUndefined()
    expect(ctx.store.read({ aggregateId: `session:${sessionId}`, types: ["session.execution_cwd.updated"] })).toEqual([])
    await supervisor.disposeAll()
  })

  test("activation of a chat whose recorded directory is gone refuses its start with a notice that names the directory", async () => {
    // Work never moves into the project root (ARCH-DIRECTORIES-007): no
    // runner is created and no directory is repaired.
    const executionCwd = realpathSync(mkdtempSync(join(tmpdir(), "flywheel-reactivation-gone-cwd-")))
    const manager = createSessionManager({ projectRoot: ctx.baseDir, executionCwd, store: ctx.store })
    const sessionId = "reactivate-missing-cwd"
    await manager.createChat({ name: "Gone", initialState: "inactive", id: sessionId })
    await commitUserTurn(sessionId)
    rmSync(executionCwd, { recursive: true, force: true })
    let created = 0
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps({ ...ctx, manager }, ctx.sessionStore, { createRunner: async (deps) => { created += 1; return mockRunner(deps.sessionId) } }),
      sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) },
    })
    const message = `session execution directory does not exist: ${executionCwd}. Restore the directory to continue.`

    // Activation attaches the runner of the tab that opens the chat, so the
    // refused start answers the activation.
    await expect(supervisor.activateSession(sessionId)).rejects.toThrow(message)
    expect(supervisor.runtimeState(sessionId)).toEqual({ kind: "failed", message })
    expect(ctx.sessionStore.get(sessionId)?.outputBlocks()).toContainEqual(expect.objectContaining({ kind: "system", level: "error", message: `Chat startup failed: ${message}` }))
    expect(created).toBe(0)
    expect(ctx.store.read({ aggregateId: `session:${sessionId}`, types: ["session.execution_cwd.updated"] })).toEqual([])
    await supervisor.disposeAll()
  })
})

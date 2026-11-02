import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { createRuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import { loadSessionView } from "../../../../src/orchestration/session-store/view.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, mockRunner, supervisorBaseDeps, supervisorConversationFixture, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"

let ctx: SupervisorTestContext
const { commitUserTurn } = supervisorConversationFixture(() => ctx)

beforeEach(() => { ctx = createSupervisorTestContext() })
afterEach(async () => { await disposeSupervisorTestContext(ctx) })

describe("RuntimeSupervisor recovered chat handling", () => {
  test("sendChat materializes a persisted active chat missing from the live store", async () => {
    const sessionId = "recovered-chat"
    await ctx.manager.createChat({ name: "Recovered Chat", initialState: "active", id: sessionId })
    await commitUserTurn(sessionId)
    let createCalls = 0
    const delivered: string[] = []
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, {
        createRunner: async (deps) => {
          createCalls += 1
          expect(deps.sessionId).toBe(sessionId)
          return {
            ...mockRunner(sessionId),
            send: async (input) => {
              if (typeof input === "string") delivered.push(input)
              return "accepted" as const
            },
          }
        },
      }),
      sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) },
    })

    await expect(supervisor.sendChat(sessionId, "continue")).resolves.toEqual({ ok: true })

    const entry = ctx.sessionStore.get(sessionId)
    expect(entry?.kind).toBe("chat")
    expect(entry?.runner?.sessionId).toBe(sessionId)
    expect(delivered).toEqual(["continue"])
    expect((await ctx.manager.read(sessionId))?.lifecycleState).toBe("active")
    expect(createCalls).toBe(1)
  })
})

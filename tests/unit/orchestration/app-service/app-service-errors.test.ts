import { describe, expect, test } from "bun:test"
import { createFlywheelAppService, type FlywheelAppServiceDeps } from "../../../../src/orchestration/app-service/app-service.js"
import { createFrontendProjection } from "../../../../src/orchestration/app-service/frontend-projection.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { chatEntry, fakeManager, fakeProjections, fakeSessionStore, runtimeSupervisor } from "./app-service-doubles.js"

describe("FlywheelAppService errors-as-values at the command boundary", () => {
  test("session.send surfaces the supervisor's real failure reason as the command error", async () => {
    const store = fakeSessionStore(new Map([["chat-1", chatEntry()]]))
    const manager = fakeManager()
    const service = createFlywheelAppService({
      projectRoot: "/workspace",
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: "/workspace" }),
      bus: createRuntimeUiBus(),
      ...fakeProjections(),
      runtimeSupervisor: runtimeSupervisor({
        sendChat: async () => ({ ok: false, reason: "Chat message could not be saved: disk write failed" }),
      }),
    })

    // The handler renders the carried reason verbatim rather than reconstructing
    // a generic "Unable to send message" string -- a disk-write failure and a
    // missing session stay distinguishable to the TUI.
    await expect(service.dispatch({ type: "session.send", sessionId: "chat-1", input: "hi" }))
      .resolves.toEqual({ ok: false, error: "Chat message could not be saved: disk write failed" })
  })

  test("a forgotten status projection wire fails loudly instead of silently returning empty status forever", async () => {
    const store = fakeSessionStore(new Map([["chat-1", chatEntry()]]))
    const manager = fakeManager()
    // The projection deps are required, so a composition that omits one is a
    // construction error rather than a healthy-looking service that returns empty
    // status forever. Stripping statusProjection proves the fictional optionality
    // is gone: reading it throws rather than yielding a silent null. The type
    // system refuses such a composition, so the test removes the wire at runtime.
    const deps: FlywheelAppServiceDeps = {
      projectRoot: "/workspace",
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: "/workspace" }),
      bus: createRuntimeUiBus(),
      ...fakeProjections(),
      runtimeSupervisor: runtimeSupervisor(),
    }
    Reflect.deleteProperty(deps, "statusProjection")
    const service = createFlywheelAppService(deps)

    await expect(service.query({ type: "statusSnapshot", sessionIds: ["chat-1"] })).rejects.toThrow()
  })
})

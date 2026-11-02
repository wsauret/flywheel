import { describe, expect, test } from "bun:test"
import { createFlywheelAppService } from "../../../../src/orchestration/app-service/app-service.js"
import { createFrontendProjection } from "../../../../src/orchestration/app-service/frontend-projection.js"
import { createRoleProtocolProjection } from "../../../../src/orchestration/app-service/role-protocol-projection.js"
import { projectRoleAssignments } from "../../../../src/orchestration/app-service/role-assignment-projection.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { runRuntimeShutdownBarrier } from "../../../../src/orchestration/app-service/runtime-shutdown.js"
import type { FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import type { ReplayedSession } from "../../../../src/orchestration/session/schemas.js"
import { fakeManager, fakeProjections, fakeSessionStore, runtimeSupervisor } from "./app-service-doubles.js"

function chat(model: string): ReplayedSession {
  return {
    label: "Chat",
    lastUpdated: "2026-08-31T00:00:00.000Z",
    lifecycleState: "active",
    executionCwd: "/scratch/flywheel-test",
    kind: "chat",
    command: "chat",
    conversationId: "conversation-1",
    roleAssignments: { defaults: {}, overrides: { chat: { model, effort: "medium" } } },
  }
}

describe("app-service role protocol", () => {
  test("serves durable snapshots and publishes manager changes", async () => {
    let session = chat("gpt-5")
    const sessionStore = fakeSessionStore(new Map())
    const manager = fakeManager({ read: async (sessionId) => sessionId === "session-1" ? session : null })
    const bus = createRuntimeUiBus()
    const roleProjection = createRoleProtocolProjection({ manager, publish: bus.publish, readRoles: async () => ({ assignments: projectRoleAssignments(session.roleAssignments?.overrides ?? {}) }) })
    const projections = fakeProjections()
    const service = createFlywheelAppService({
      projection: createFrontendProjection({ sessionStore, manager, projectRoot: "/workspace" }),
      projectRoot: "/workspace",
      runtimeSupervisor: runtimeSupervisor(),
      bus,
      ...projections,
      roleProjection,
    })
    const events: FrontendEvent[] = []
    const unsubscribe = service.subscribe((event) => { events.push(event) })

    await expect(service.query({ type: "roleSnapshot", sessionIds: ["session-1"] })).resolves.toMatchObject({
      views: [{ sessionId: "session-1", view: { assignments: { chat: { model: "gpt-5", effort: "medium" } } } }],
    })

    session = chat("gpt-6")
    manager.emitChange(["session-1"])
    await Bun.sleep(1)
    await bus.drain()

    expect(events.find((event) => event.type === "patch" && event.patch.cursor.domain === "roles")).toMatchObject({
      type: "patch",
      patch: {
        cursor: { scope: "session", domain: "roles", sessionId: "session-1" },
        payload: { kind: "roles.updated", roles: { assignments: { chat: { model: "gpt-6", effort: "medium" } } } },
      },
    })

    unsubscribe()
    await runRuntimeShutdownBarrier(service.shutdown)
  })
})

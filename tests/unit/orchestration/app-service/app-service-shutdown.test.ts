import { describe, expect, test } from "bun:test"
import type { FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { createFlywheelAppService } from "../../../../src/orchestration/app-service/app-service.js"
import { createFrontendProjection } from "../../../../src/orchestration/app-service/frontend-projection.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { runRuntimeShutdownBarrier } from "../../../../src/orchestration/app-service/runtime-shutdown.js"
import { durableRow, managerWithSessions } from "./_frontend-projection-fixtures.js"
import { chatEntry, fakeManager, fakeProjections, fakeSessionStore, runtimeSupervisor } from "./app-service-doubles.js"
import { FIXTURE_EXECUTION_CWD } from "../../../helpers/directories.js"

const noopOutputProjection = { flush: async () => {}, watch: () => {}, dispose: () => {} }

describe("FlywheelAppService shutdown", () => {
  test("teardown settles runners before client projections", async () => {
    const store = fakeSessionStore(new Map([["chat-1", chatEntry()]]))
    const manager = managerWithSessions([durableRow("chat-1")])
    const order: string[] = []
    const projection = createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD })
    const projectionWithSpy = { ...projection, dispose: () => { order.push("projection") } }
    const projections = fakeProjections()
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: projectionWithSpy,
      bus: createRuntimeUiBus(),
      ...projections,
      roleProjection: { ...projections.roleProjection, dispose: async () => { order.push("roles") } },
      runtimeSupervisor: runtimeSupervisor({ disposeAll: async () => { await Promise.resolve(); order.push("supervisor") } }),
    })

    await runRuntimeShutdownBarrier(service.shutdown)

    expect(order).toEqual(["supervisor", "roles", "projection"])
  })

  test("teardown clears the subscription and pending-patch timer; a later store change emits no patch", async () => {
    const store = fakeSessionStore(new Map([["chat-1", chatEntry()]]))
    const manager = managerWithSessions([durableRow("chat-1")])
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
      bus: createRuntimeUiBus(),
      ...fakeProjections(), outputProjection: noopOutputProjection,
      runtimeSupervisor: runtimeSupervisor(),
    })
    const events: FrontendEvent[] = []
    service.subscribe((event) => { events.push(event) })

    await runRuntimeShutdownBarrier(service.shutdown)
    events.length = 0
    store.updateChatEntry("chat-1", { description: "after teardown" })

    expect(events).toEqual([])
  })

  test("teardown disposes each owned runtime resource once and emits no additional patches", async () => {
    const store = fakeSessionStore(new Map([["chat-1", chatEntry()]]))
    const manager = managerWithSessions([durableRow("chat-1")])
    let supervisorDisposals = 0
    let roleProjectionDisposals = 0
    const projections = fakeProjections()
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
      bus: createRuntimeUiBus(),
      ...projections,
      roleProjection: { ...projections.roleProjection, dispose: async () => { roleProjectionDisposals += 1 } },
      runtimeSupervisor: runtimeSupervisor({ disposeAll: async () => { supervisorDisposals += 1 } }),
    })
    const events: FrontendEvent[] = []
    service.subscribe((event) => { events.push(event) })
    events.length = 0

    const result = await runRuntimeShutdownBarrier(service.shutdown)

    expect(result).toEqual({ kind: "settled" })
    expect(supervisorDisposals).toBe(1)
    expect(roleProjectionDisposals).toBe(1)
    expect(events).toEqual([])
  })

  test("a durable flush that ends unsafely blocks the client-stream teardown", async () => {
    const store = fakeSessionStore(new Map([["chat-1", chatEntry()]]))
    const manager = managerWithSessions([durableRow("chat-1")])
    const projections = fakeProjections()
    const projection = createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD })
    let projectionDisposals = 0
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: { ...projection, dispose: () => { projectionDisposals += 1 } },
      bus: createRuntimeUiBus(),
      ...projections,
      historyProjection: { ...projections.historyProjection, dispose: async () => { throw new Error("durable flush boom") } },
      runtimeSupervisor: runtimeSupervisor(),
    })

    const result = await runRuntimeShutdownBarrier(service.shutdown)

    expect(result).toMatchObject({ kind: "blocked", phase: "flush-durable-state" })
    // Unwritten durable state is not a state to tear the client streams down over:
    // every later phase, up to the state release, is left unasked.
    expect(projectionDisposals).toBe(0)
  })

  test("closes command admission while interrupting runners and joins accepted calls", async () => {
    const accepted = Promise.withResolvers<string>()
    let runnersInterrupted = false
    const store = fakeSessionStore(new Map())
    const manager = fakeManager()
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
      bus: createRuntimeUiBus(),
      ...fakeProjections(),
      runtimeSupervisor: runtimeSupervisor({
        openSessionRuntime: () => accepted.promise,
        disposeAll: async () => { runnersInterrupted = true },
      }),
    })

    const admitted = service.dispatch({ type: "chat.open" })
    await Promise.resolve()
    const shutdown = runRuntimeShutdownBarrier(service.shutdown)
    await Promise.resolve()

    expect(runnersInterrupted).toBe(true)
    await expect(service.dispatch({ type: "chat.open" })).resolves.toEqual({ ok: false, error: "Flywheel is shutting down" })
    expect(await Promise.race([shutdown.then(() => "settled"), Bun.sleep(5).then(() => "pending")])).toBe("pending")

    accepted.resolve("chat-1")
    await admitted
    await expect(shutdown).resolves.toEqual({ kind: "settled" })
  })
})

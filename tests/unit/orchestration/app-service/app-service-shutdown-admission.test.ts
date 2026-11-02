import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { PROTOCOL_MODULE_MUTATIONS } from "../../../../src/protocol/modules.js"
import type { FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { createFlywheelAppService } from "../../../../src/orchestration/app-service/app-service.js"
import { createFrontendProjection } from "../../../../src/orchestration/app-service/frontend-projection.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { runRuntimeShutdownBarrier, type RuntimeShutdownResult } from "../../../../src/orchestration/app-service/runtime-shutdown.js"
import { chatEntry, fakeProjections, fakeSessionStore, runtimeSupervisor } from "./app-service-doubles.js"
import { durableRow, managerWithSessions } from "./_frontend-projection-fixtures.js"
import { FIXTURE_EXECUTION_CWD } from "../../../helpers/directories.js";

const ADMISSION_CLOSED_ERROR = "Flywheel is shutting down"

/** Deterministic in place of a sleep: the accepted dispatch and the barrier are
 *  microtask chains, so draining the microtask queue advances everything that is
 *  able to advance. What is still pending afterwards is blocked, not slow. */
async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
}

function blockedSupervisorHarness() {
  const store = fakeSessionStore(new Map([["chat-1", chatEntry()]]))
  const manager = managerWithSessions([durableRow("chat-1")])
  const order: string[] = []
  let releaseOpenChat = (): void => {}
  const openChatBlocked = new Promise<void>((resolve) => { releaseOpenChat = resolve })
  const service = createFlywheelAppService({
    projectRoot: FIXTURE_EXECUTION_CWD,
    projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
    bus: createRuntimeUiBus(),
    ...fakeProjections(),
    runtimeSupervisor: runtimeSupervisor({
      openSessionRuntime: async () => {
        await openChatBlocked
        order.push("accepted-dispatch")
        return "chat-opened"
      },
      disposeAll: async () => { order.push("dispose-runners") },
    }),
  })
  return { service, store, order, releaseOpenChat }
}

describe("FlywheelAppService shutdown admission", () => {
  test("shutdown interrupts runners while it joins the dispatch already accepted", async () => {
    const { service, order, releaseOpenChat } = blockedSupervisorHarness()

    const accepted = service.dispatch({ type: "chat.open" })
    await drainMicrotasks()

    let barrierResult: RuntimeShutdownResult | null = null
    const barrier = runRuntimeShutdownBarrier(service.shutdown).then((result) => { barrierResult = result; return result })
    await drainMicrotasks()

    // Closed admission: a command that had not started is refused outright, so
    // it cannot create a runner outside the barrier. An admitted command would
    // park inside the blocked openSessionRuntime instead of answering, so the sentinel
    // reports that outcome rather than letting the test hang on it.
    const later = await Promise.race([
      service.dispatch({ type: "chat.open" }),
      Bun.sleep(20).then(() => ({ ok: true as const, sessionId: "admitted-after-closure" })),
    ])
    expect(later).toEqual({ ok: false, error: ADMISSION_CLOSED_ERROR })
    // Runner interruption is requested in parallel with the admission join, but
    // the barrier stays in stop-runners until the accepted command returns.
    expect(order).toEqual(["dispose-runners"])
    expect(barrierResult).toBeNull()

    releaseOpenChat()
    await expect(accepted).resolves.toEqual({ ok: true, sessionId: "chat-opened" })

    await expect(barrier).resolves.toEqual({ kind: "settled" })
    expect(order).toEqual(["dispose-runners", "accepted-dispatch"])
  })

  test("a workflow operation started after closure is refused with that operation's own failure result", async () => {
    const { service } = blockedSupervisorHarness()

    await runRuntimeShutdownBarrier(service.shutdown)

    // A refused interrupt says why, so a client never reads it as nothing running.
    await expect(service.dispatch({ type: "workflow.interrupt", workflowId: "wf-1" }))
      .resolves.toEqual({ kind: "interrupt", interrupted: false, reason: ADMISSION_CLOSED_ERROR })
  })

  test("closed module admission uses its declared refusal codec without calling a service", async () => {
    const { service } = blockedSupervisorHarness()
    await runRuntimeShutdownBarrier(service.shutdown)
    const requests = [
      { type: "remote.pair.open" }, { type: "remote.pair.cancel" },
      { type: "remote.device.revoke", deviceId: "phone" },
      { type: "remote.device.rename", deviceId: "phone", label: "Phone" },
      { type: "remote.push.subscribe", deviceId: "phone", subscription: { endpoint: "https://push.example/send", expirationTime: null, keys: { p256dh: "key", auth: "auth" } } },
      { type: "remote.push.unsubscribe", deviceId: "phone" },
      { type: "remote.project.forget", placementId: "placement" },
    ] as const
    for (const request of requests) {
      const result = await service.dispatch(request)
      expect(result).toEqual({ kind: "rejected", message: ADMISSION_CLOSED_ERROR })
      const declaration = PROTOCOL_MODULE_MUTATIONS.find(({ type }) => type === request.type)!
      expect(Schema.decodeUnknownSync(declaration.result)(result)).toEqual(result)
    }
    const other = await service.dispatch({ type: "mcp.authenticate", server: "server" })
    expect(other).toEqual({ ok: false, error: ADMISSION_CLOSED_ERROR })
    const declaration = PROTOCOL_MODULE_MUTATIONS.find(({ type }) => type === "mcp.authenticate")!
    expect(Schema.decodeUnknownSync(declaration.result)(other)).toEqual(other)
  })

  test("subscribe and warmBackground start no owned work after closure, while a read-only query still answers", async () => {
    const store = fakeSessionStore(new Map([["chat-1", chatEntry()]]))
    const manager = managerWithSessions([durableRow("chat-1")])
    let warmCalls = 0
    let laneStarts = 0
    const projections = fakeProjections()
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
      bus: createRuntimeUiBus(),
      ...projections,
      backgroundLane: {
        ...projections.backgroundLane,
        sessionChangeSummary: async () => { throw new Error("Session change summary is not used in this fixture") },
        start: () => { laneStarts += 1 },
        snapshot: async () => ({ rows: [], errors: [], totalsLoading: false, generationSpeeds: {} }),
        sessionDetail: async () => ({ view: null }),
        moduleSnapshot: async () => { throw new Error("Module background snapshots are not used in this fixture") },
        dispose: async () => {},
      },
      runtimeSupervisor: runtimeSupervisor({ warmChatRunner: async () => { warmCalls += 1 } }),
    })

    await runRuntimeShutdownBarrier(service.shutdown)

    const events: FrontendEvent[] = []
    const unsubscribe = service.subscribe((event) => { events.push(event) })
    store.updateChatEntry("chat-1", { description: "after teardown" })
    await service.dispatch({ type: "background.warm" })

    expect(events).toEqual([])
    expect(warmCalls).toBe(0)
    expect(laneStarts).toBe(0)
    unsubscribe()
    // Read-only queries stay admitted on purpose: a client that is still
    // rendering while the runtime tears down owns no runtime work.
    expect((await service.query({ type: "snapshot" })).rows.map((row) => row.id)).toEqual(["chat-1"])
  })
})

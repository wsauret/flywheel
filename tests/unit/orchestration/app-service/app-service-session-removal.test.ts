import { describe, expect, test } from "bun:test"
import type { FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import type { DurableSessionCatalogRow } from "../../../../src/orchestration/session/session-catalog-types.js"
import { createFlywheelAppService } from "../../../../src/orchestration/app-service/app-service.js"
import { createFrontendProjection } from "../../../../src/orchestration/app-service/frontend-projection.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { chatEntry, fakeManager, fakeProjections, fakeSessionStore, runtimeSupervisor } from "./app-service-doubles.js"
import { durableRow, managerWithSessions } from "./_frontend-projection-fixtures.js"
import { FIXTURE_EXECUTION_CWD } from "../../../helpers/directories.js";

const noopOutputProjection = { flush: async () => {}, watch: () => {}, dispose: () => {} }

async function eventually(fn: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (fn()) return
    await Bun.sleep(1)
  }
}

describe("FlywheelAppService session removal commands", () => {
  test("discarding a removed transient publishes removal from the projection", async () => {
    const store = fakeSessionStore(new Map([["chat-1", chatEntry()]]))
    // Discarding a transient chat deletes it, so both the live entry and the
    // durable metadata row leave the catalog.
    const durableRows = [durableRow("chat-1")]
    const manager = managerWithSessions(durableRows)
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
      bus: createRuntimeUiBus(),
      ...fakeProjections(), outputProjection: noopOutputProjection,
      runtimeSupervisor: runtimeSupervisor({
        discardTransientChat: async (sessionId) => {
          durableRows.length = 0
          await store.remove(sessionId)
          return { removed: true }
        },
      }),
    })
    const events: FrontendEvent[] = []
    service.subscribe((event) => { events.push(event) })

    await expect(service.dispatch({ type: "session.discard_transient", sessionId: "chat-1" })).resolves.toEqual({ ok: true, sessionId: "chat-1", sessionRemoved: true })
    await eventually(() => events.some((event) => event.type === "patch" && event.patch.payload.kind === "session.removed"))

    const removal = events.find((event): event is Extract<FrontendEvent, { type: "patch" }> => event.type === "patch" && event.patch.payload.kind === "session.removed")
    expect(removal?.patch.cursor).toEqual({ scope: "session", domain: "session", sessionId: "chat-1" })
    expect(removal?.patch.payload).toEqual({ kind: "session.removed" })
  })

  test("discarding a kept transient does not synthesize removal", async () => {
    const store = fakeSessionStore(new Map([["chat-1", chatEntry()]]))
    const manager = managerWithSessions([durableRow("chat-1")])
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
      bus: createRuntimeUiBus(),
      ...fakeProjections(), outputProjection: noopOutputProjection,
      runtimeSupervisor: runtimeSupervisor({ discardTransientChat: async () => ({ removed: false }) }),
    })
    const events: FrontendEvent[] = []
    service.subscribe((event) => { events.push(event) })

    await expect(service.dispatch({ type: "session.discard_transient", sessionId: "chat-1" })).resolves.toEqual({ ok: true, sessionId: "chat-1", sessionRemoved: false })

    expect(events.filter((event) => event.type === "patch")).toEqual([])
  })

  for (const [inactiveBefore, removed] of [[undefined, true], [1, true], [1, false]] as const) {
    test(`session.delete ${inactiveBefore === undefined ? "explicit" : "conditional"} ${removed ? "success publishes exactly one removal" : "refusal publishes none"}, minted by the projection diff`, async () => {
      let sessions: DurableSessionCatalogRow[] = [durableRow("chat-1")]
      const store = fakeSessionStore(new Map())
      const manager = fakeManager({ listMetadata: async () => ({ sessions, errors: [] }) })
      const service = createFlywheelAppService({
        projectRoot: FIXTURE_EXECUTION_CWD,
        projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
        bus: createRuntimeUiBus(),
        ...fakeProjections(), outputProjection: noopOutputProjection,
        runtimeSupervisor: runtimeSupervisor({
          deleteSession: async (sessionId, cutoff) => {
            expect(cutoff).toBe(inactiveBefore)
            if (!removed) return false
            sessions = sessions.filter((row) => row.id !== sessionId)
            manager.emitDeleted(sessionId)
            return true
          },
        }),
      })
      const events: FrontendEvent[] = []
      service.subscribe((event) => { events.push(event) })

      expect((await service.query({ type: "snapshot" })).rows.map((row) => row.id)).toEqual(["chat-1"])
      await expect(service.dispatch({ type: "session.delete", sessionId: "chat-1", ...(inactiveBefore === undefined ? {} : { inactiveBefore }) })).resolves.toEqual({ ok: true, sessionId: "chat-1", ...(inactiveBefore === undefined ? {} : { sessionRemoved: removed }) })
      if (removed) await eventually(() => events.some((event) => event.type === "patch" && event.patch.payload.kind === "session.removed"))
      // Give a hypothetical duplicate publisher time to fire before counting.
      await Bun.sleep(5)

      const removals = events.filter((event): event is Extract<FrontendEvent, { type: "patch" }> => event.type === "patch" && event.patch.payload.kind === "session.removed")
      expect(removals).toHaveLength(removed ? 1 : 0)
      if (removed) expect(removals[0]?.patch.cursor).toEqual({ scope: "session", domain: "session", sessionId: "chat-1" })
    })
  }
})

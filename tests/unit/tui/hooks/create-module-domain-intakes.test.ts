import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import type { AttachedRuntimeClient, FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { workspaceDomainCursor } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { createModuleDomainIntakes } from "../../../../src/tui/hooks/create-module-domain-intakes.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"

/** A client that answers the workspace papercut snapshot and counts those
 *  reads; the other workspace domain answers empty, and the session-scoped
 *  intake asks nothing until a session is ensured. */
function fakeAppService(initialCount: number) {
  const sequencer = createRuntimeUiPatchSequencer()
  const cursor = workspaceDomainCursor("papercuts")
  let count = initialCount
  let snapshotCalls = 0
  // Every registry domain subscribes on its own, so the fake fans out.
  const listeners = new Set<(event: FrontendEvent) => void>()
  const deliver = (event: FrontendEvent): void => { for (const receive of listeners) { receive(event) } }
  let lastPatch: (FrontendEvent & { type: "patch" }) | null = null
  const query = runtimeQuery({
    definitionStalenessSnapshot: async () => ({ snapshotPosition: sequencer.snapshotPosition({ kind: "cursor", cursor: workspaceDomainCursor("definitionStaleness") }), definitionStaleness: { overrides: [], diagnostics: [], reviewCount: 0 } }),
    projectNotificationSnapshot: async () => ({ snapshotPosition: sequencer.snapshotPosition({ kind: "cursor", cursor: workspaceDomainCursor("project_notifications") }), notifications: [] }),
    papercutCountSnapshot: async () => {
      snapshotCalls += 1
      return { snapshotPosition: sequencer.snapshotPosition({ kind: "cursor", cursor }), papercuts: { undisposedCount: count } }
    },
  })
  const lanes = fakeLanes()
  const service = {
    query,
    subscribe: (next: (event: FrontendEvent) => void) => {
      listeners.add(next)
      return () => { listeners.delete(next) }
    },
    onLane: lanes.onLane,
  } satisfies Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">
  return {
    service,
    snapshotCalls: () => snapshotCalls,
    setCount: (next: number) => { count = next },
    live: (next: number) => {
      lastPatch = { type: "patch", patch: sequencer.publish({ cursor, payload: { kind: "papercuts.changed", papercuts: { undisposedCount: next } } }) }
      deliver(lastPatch)
    },
    replay: () => { if (lastPatch) deliver(lastPatch) },
    skipThenLive: (next: number) => {
      sequencer.publish({ cursor, payload: { kind: "papercuts.changed", papercuts: { undisposedCount: -1 } } })
      deliver({ type: "patch", patch: sequencer.publish({ cursor, payload: { kind: "papercuts.changed", papercuts: { undisposedCount: next } } }) })
    },
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("module domain intakes", () => {
  it("binds a workspace-scoped registry domain: hydrates, applies ordered patches, ignores stale patches, and resnapshots gaps", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService(3)
      const intakes = createModuleDomainIntakes({ appService: fake.service, hydration: fake.service })
      const count = () => intakes.papercuts.view()?.undisposedCount
      await flush()
      expect(count()).toBe(3)

      fake.live(7)
      expect(count()).toBe(7)
      fake.replay()
      expect(count()).toBe(7)

      fake.setCount(11)
      fake.skipThenLive(99)
      await flush()
      expect(count()).toBe(11)
      expect(fake.snapshotCalls()).toBe(2)
      dispose()
    })
  })

  it("binds a session-scoped registry domain as a per-session cache that asks nothing until a session is ensured", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService(0)
      const intakes = createModuleDomainIntakes({ appService: fake.service, hydration: fake.service })
      await flush()
      expect(fake.snapshotCalls()).toBe(1)
      expect(intakes.experiment_view.view("chat-1")).toBeUndefined()
      dispose()
    })
  })
})

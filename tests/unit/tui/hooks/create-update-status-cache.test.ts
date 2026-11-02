import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import type { AttachedRuntimeClient, FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { updatesCursor, type UpdateAutoInstall, type UpdateStatusView } from "../../../../src/protocol/update-protocol-types.js"
import { createUpdateStatusCache } from "../../../../src/tui/hooks/create-update-status-cache.js"
import { fakeLanes, LANE_BREAK } from "../../../helpers/fake-lanes.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"

function autoInstall(on: boolean): UpdateAutoInstall {
  return { persisted: on, forcedOff: false, effective: on }
}

function view(overrides: Partial<UpdateStatusView> = {}): UpdateStatusView {
  return { revision: 1, autoInstall: autoInstall(true), status: { kind: "idle" }, ...overrides }
}

function fakeAppService(initial: UpdateStatusView) {
  const sequencer = createRuntimeUiPatchSequencer()
  const cursor = updatesCursor()
  let snapshot = initial
  let snapshotCalls = 0
  let listener: ((event: FrontendEvent) => void) | null = null
  let lastPatch: (FrontendEvent & { type: "patch" }) | null = null

  const query = runtimeQuery({
    updateSnapshot: async () => {
      snapshotCalls += 1
      return { update: snapshot, snapshotPosition: sequencer.snapshotPosition({ kind: "cursor", cursor }) }
    },
  })
  const lanes = fakeLanes()
  const service = {
    query,
    subscribe: (l: (event: FrontendEvent) => void) => {
      listener = l
      return () => { listener = null }
    },
    onLane: lanes.onLane,
  } satisfies Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">

  return {
    service,
    setSnapshot: (next: UpdateStatusView) => { snapshot = next },
    snapshotCalls: () => snapshotCalls,
    live: (next: UpdateStatusView) => {
      lastPatch = { type: "patch", patch: sequencer.publish({ cursor, payload: { kind: "update.changed", update: next } }) }
      listener?.(lastPatch)
    },
    redeliverLastPatch: () => { if (lastPatch) listener?.(lastPatch) },
    skipThenLive: (next: UpdateStatusView) => {
      sequencer.publish({ cursor, payload: { kind: "update.changed", update: view({ revision: 98 }) } })
      listener?.({ type: "patch", patch: sequencer.publish({ cursor, payload: { kind: "update.changed", update: next } }) })
    },
    reconnect: () => {
      lanes.end()
      listener?.(LANE_BREAK)
      lanes.open()
    },
  }
}

/** Lets a held view's read answer: the read crosses several promise turns. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
}

describe("createUpdateStatusCache", () => {
  it("hydrates the runtime's state and policy from the snapshot", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService(view({ revision: 3, autoInstall: autoInstall(false), status: { kind: "available", version: "1.2.3", blocking: "auto-install-off" } }))
      const cache = createUpdateStatusCache({ appService: fake.service })

      expect(cache.view()).toBeUndefined()
      await settle()

      expect(cache.view()).toEqual({ revision: 3, autoInstall: autoInstall(false), status: { kind: "available", version: "1.2.3", blocking: "auto-install-off" } })
      dispose()
    })
  })

  it("replaces the held view with the latest patch", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService(view())
      const cache = createUpdateStatusCache({ appService: fake.service })
      await settle()

      fake.live(view({ revision: 2, status: { kind: "installing", version: "2.0.0" } }))
      fake.live(view({ revision: 3, status: { kind: "installed", version: "2.0.0" } }))

      expect(cache.view()).toEqual({ revision: 3, autoInstall: autoInstall(true), status: { kind: "installed", version: "2.0.0" } })
      dispose()
    })
  })

  it("publishes an externally changed policy without a resnapshot", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService(view())
      const cache = createUpdateStatusCache({ appService: fake.service })
      await settle()
      const hydrationCalls = fake.snapshotCalls()

      fake.live(view({ revision: 2, autoInstall: autoInstall(false) }))

      expect(cache.view()?.autoInstall).toEqual(autoInstall(false))
      expect(fake.snapshotCalls()).toBe(hydrationCalls)
      dispose()
    })
  })

  it("treats a redelivered patch as a no-op", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService(view())
      const cache = createUpdateStatusCache({ appService: fake.service })
      await settle()
      const hydrationCalls = fake.snapshotCalls()

      fake.live(view({ revision: 2, status: { kind: "available", version: "9.9.9", blocking: "nothing" } }))
      fake.redeliverLastPatch()

      expect(cache.view()).toEqual({ revision: 2, autoInstall: autoInstall(true), status: { kind: "available", version: "9.9.9", blocking: "nothing" } })
      expect(fake.snapshotCalls()).toBe(hydrationCalls)
      dispose()
    })
  })

  it("resnapshots after a gap", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService(view())
      const cache = createUpdateStatusCache({ appService: fake.service })
      await settle()
      const authoritative = view({ revision: 7, autoInstall: autoInstall(false), status: { kind: "installed", version: "3.1.0" } })
      fake.setSnapshot(authoritative)
      const before = fake.snapshotCalls()

      fake.skipThenLive(view({ revision: 99 }))
      expect(fake.snapshotCalls()).toBe(before + 1)
      await settle()

      expect(cache.view()).toEqual(authoritative)
      dispose()
    })
  })

  it("resnapshots on reconnect", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService(view())
      const cache = createUpdateStatusCache({ appService: fake.service })
      await settle()
      const reconnected = view({ revision: 12, autoInstall: autoInstall(false), status: { kind: "available", version: "4.0.0", blocking: "auto-install-off" } })
      fake.setSnapshot(reconnected)

      fake.reconnect()
      await settle()

      expect(cache.view()).toEqual(reconnected)
      dispose()
    })
  })
})

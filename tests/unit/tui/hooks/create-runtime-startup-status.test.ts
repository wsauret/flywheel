import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import type { AttachedRuntimeClient, FrontendEvent, RuntimeStartupStatus } from "../../../../src/protocol/app-service-types.js"
import { createRuntimeStartupStatus } from "../../../../src/tui/hooks/create-runtime-startup-status.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"

function fakeAppService() {
  let listener: ((event: FrontendEvent) => void) | null = null
  let unsubscribed = false
  const lanes = fakeLanes({ open: false })
  const service = {
    subscribe: (l: (event: FrontendEvent) => void) => {
      listener = l
      return () => { unsubscribed = true; listener = null }
    },
    onLane: lanes.onLane,
  } satisfies Pick<AttachedRuntimeClient, "subscribe" | "onLane">

  return {
    service,
    startup: (status: RuntimeStartupStatus) => listener?.({ type: "runtime.startup", status }),
    laneOpened: () => lanes.open(),
    isUnsubscribed: () => unsubscribed,
  }
}

describe("createRuntimeStartupStatus", () => {
  it("starts empty and tracks the latest phase", () => {
    createRoot((dispose) => {
      const fake = fakeAppService()
      const status = createRuntimeStartupStatus({ appService: fake.service })
      expect(status()).toBeNull()
      fake.startup({ kind: "phase", label: "Preparing workspace state" })
      fake.startup({ kind: "phase", label: "Upgrading stored facts: skill reach", progress: { step: 10, total: 12 } })
      expect(status()).toEqual({ kind: "phase", label: "Upgrading stored facts: skill reach", progress: { step: 10, total: 12 } })
      dispose()
    })
  })

  it("clears when a lane opens, including a failure a respawn healed", () => {
    createRoot((dispose) => {
      const fake = fakeAppService()
      const status = createRuntimeStartupStatus({ appService: fake.service })
      fake.startup({ kind: "failed", error: "no such table: in_flight" })
      fake.laneOpened()
      expect(status()).toBeNull()
      dispose()
    })
  })

  it("keeps the first failure of an attempt over the raw error blob that follows it", () => {
    createRoot((dispose) => {
      const fake = fakeAppService()
      const status = createRuntimeStartupStatus({ appService: fake.service })
      fake.startup({ kind: "failed", error: "no such table: in_flight" })
      fake.startup({ kind: "failed", error: "44 | const insertContent = db.query(...)\nSQLiteError: no such table" })
      expect(status()).toEqual({ kind: "failed", error: "no such table: in_flight" })
      // A respawned attempt's phase notice resets the slate, so its own
      // failure is reported fresh.
      fake.startup({ kind: "phase", label: "Preparing workspace state" })
      fake.startup({ kind: "failed", error: "disk full" })
      expect(status()).toEqual({ kind: "failed", error: "disk full" })
      dispose()
    })
  })

  it("unsubscribes on dispose", () => {
    const fake = fakeAppService()
    createRoot((dispose) => {
      createRuntimeStartupStatus({ appService: fake.service })
      dispose()
    })
    expect(fake.isUnsubscribed()).toBe(true)
  })
})

import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import type { FrontendEvent, RuntimeClient } from "../../../../src/protocol/app-service-types.js"
import { createRuntimeHealth } from "../../../../src/tui/hooks/create-runtime-health.js"

function fakeAppService() {
  let listener: ((event: FrontendEvent) => void) | null = null
  let unsubscribed = false
  const service = {
    subscribe: (l: (event: FrontendEvent) => void) => {
      listener = l
      return () => { unsubscribed = true; listener = null }
    },
  } satisfies Pick<RuntimeClient, "subscribe">
  return {
    service,
    reconnectRequired: () => listener?.({
      type: "patch",
      patch: { cursor: { scope: "workspace", domain: "runtime" }, position: 0, prevPosition: 0, payload: { kind: "runtime.invalidate", reason: "reconnect_required" } },
    }),
    faulted: (cause?: string) => listener?.({ type: "runtime.health", health: { kind: "faulted", since: 5, ...(cause === undefined ? {} : { cause }) } }),
    /** The connection reports health again once the runtime answers. */
    answered: () => listener?.({ type: "runtime.health", health: { kind: "healthy" } }),
    isUnsubscribed: () => unsubscribed,
  }
}

describe("createRuntimeHealth", () => {
  it("starts healthy and stays healthy through a recovery that is under way", () => {
    createRoot((dispose) => {
      const fake = fakeAppService()
      const health = createRuntimeHealth({ appService: fake.service })
      expect(health()).toEqual({ kind: "healthy" })
      // The reconnect loop's invalidation is a reseed instruction, not a status.
      fake.reconnectRequired()
      expect(health()).toEqual({ kind: "healthy" })
      dispose()
    })
  })

  it("carries the fault the connection reports, with its cause, until the runtime answers again", () => {
    createRoot((dispose) => {
      const fake = fakeAppService()
      const health = createRuntimeHealth({ appService: fake.service })
      fake.faulted("Module services failed to settle")
      expect(health()).toEqual({ kind: "faulted", since: 5, cause: "Module services failed to settle" })
      fake.answered()
      expect(health()).toEqual({ kind: "healthy" })
      dispose()
    })
  })

  it("unsubscribes on dispose", () => {
    const fake = fakeAppService()
    createRoot((dispose) => {
      createRuntimeHealth({ appService: fake.service })
      dispose()
    })
    expect(fake.isUnsubscribed()).toBe(true)
  })
})

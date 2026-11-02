import { describe, expect, test } from "bun:test"
import { createSubscriptionUsageService } from "../../../../../src/orchestration/modules/subscription-usage/service.js"
import { subscriptionUsageConfigSection } from "../../../../../src/orchestration/modules/subscription-usage/config.js"
import { composeFirstPartyModules } from "../../../../../src/orchestration/modules.js"
import { decodeCanonicalConfigText } from "../../../../../src/orchestration/config/loader.js"
import type { RuntimeConfigOwner, RuntimeConfigSnapshot } from "../../../../../src/orchestration/config/runtime-config-owner.js"
import { projectRuntimeConfig } from "../../../../../src/orchestration/app-service/runtime-config-projection.js"

function fixture(options: { readonly accountingUnavailable?: boolean } = {}) {
  let enabled = true
  let rejectNext = false
  let hold: Promise<void> | undefined
  let starts = 0
  let pauses = 0
  const received: Array<readonly number[]> = []
  const subscribers = new Map<string, Set<(snapshot: RuntimeConfigSnapshot) => void | Promise<void>>>()
  const selectionListeners = new Set<() => void | Promise<void>>()
  const config = decodeCanonicalConfigText("[subscription_usage]\nalert_thresholds = [80, 95]\n", {}, "/scratch/usage-service-test").config
  const snapshot = (): RuntimeConfigSnapshot => ({ revision: 1, config, warnings: [], diagnostics: [], sourceIdentity: "test", status: { kind: "valid" } })
  const owner: Pick<RuntimeConfigOwner, "snapshot" | "subscribe" | "mutateSection"> = {
    snapshot,
    mutateSection: async () => { throw new Error("No mutation in this lifecycle test") },
    subscribe: (section, subscriber) => {
      const id = typeof section === "string" ? section : section.key
      const listeners = subscribers.get(id) ?? new Set()
      listeners.add(subscriber)
      subscribers.set(id, listeners)
      return async () => { listeners.delete(subscriber); if (listeners.size === 0) subscribers.delete(id) }
    },
  }
  const service = createSubscriptionUsageService({
    config: owner, enabled: () => enabled, configView: () => projectRuntimeConfig(snapshot(), "/scratch/project"),
    moduleSelection: () => composeFirstPartyModules([]),
    onSelectionChanged: (listener) => { selectionListeners.add(listener); return () => { selectionListeners.delete(listener) } },
    notify: async () => {}, interactive: true, directories: { projectRoot: "/scratch/usage-service-test" },
    projectionReader: { hasInFlightProfile: async () => false },
    // A composition that fails before its auth runtime exists disposes this
    // service while the accounting accessor still throws.
    profileAccounting: () => options.accountingUnavailable ? (() => { throw new ReferenceError("Cannot access 'authRuntime' before initialization.") })() : ({
      refreshSubscriptionSpendConsent: async () => {},
      subscriptionUsage: {
        acquireScope: async () => { throw new Error("No query in this lifecycle test") },
        subscribePublications: () => () => {},
        start: () => { starts += 1 }, pause: () => { pauses += 1 },
        replaceThresholds: async (thresholds) => {
          received.push(thresholds)
          if (rejectNext) { rejectNext = false; throw new Error("observations unavailable") }
          await hold
        },
      },
    }),
  })
  async function publish(section: string = subscriptionUsageConfigSection.key): Promise<void> { await Promise.all([...subscribers.get(section) ?? []].map((subscriber) => subscriber(snapshot()))) }
  async function selectionChanged(): Promise<void> { await Promise.all([...selectionListeners].map((listener) => listener())) }
  return { service, received, publish, subscribers, owner, selectionChanged, get starts() { return starts }, get pauses() { return pauses }, enable(value: boolean) { enabled = value }, fail() { rejectNext = true }, hold(value: Promise<void>) { hold = value } }
}

describe("Usage monitoring lifecycle", () => {
  test("keeps threshold publication pending until the generation settles", async () => {
    const scope = fixture()
    scope.service.start?.()
    await scope.publish()
    const settled = Promise.withResolvers<void>()
    scope.hold(settled.promise)
    let didSettle = false
    const publication = scope.publish().then(() => { didSettle = true })
    await Promise.resolve()
    expect(scope.received.at(-1)).toEqual([80, 95])
    expect(didSettle).toBe(false)
    settled.resolve()
    await publication
    expect(didSettle).toBe(true)
    await scope.service.dispose()
    expect(scope.subscribers.size).toBe(0)
  })

  test("follows the validated selection after a delayed root config subscriber", async () => {
    const scope = fixture()
    let nextEnabled = false
    let adoption = Promise.withResolvers<void>()
    const stopRoot = scope.owner.subscribe("moduleSelection", async () => {
      await adoption.promise
      scope.enable(nextEnabled)
      await scope.selectionChanged()
    })
    scope.service.start?.()
    await scope.publish()
    const priorStarts = scope.starts

    const disabling = scope.publish("moduleSelection")
    await Promise.resolve()
    expect(scope.pauses).toBe(0)
    adoption.resolve()
    await disabling
    expect(scope.pauses).toBe(1)
    expect(scope.received.at(-1)).toEqual([])
    expect(scope.starts).toBe(priorStarts)

    nextEnabled = true
    adoption = Promise.withResolvers<void>()
    const enabling = scope.publish("moduleSelection")
    await Promise.resolve()
    expect(scope.starts).toBe(priorStarts)
    adoption.resolve()
    await enabling
    expect(scope.starts).toBe(priorStarts + 1)
    expect(scope.received.at(-1)).toEqual([80, 95])
    await stopRoot()
    await scope.service.dispose()
  })

  test("disposing a service that never started touches no profile accounting", async () => {
    const scope = fixture({ accountingUnavailable: true })
    await scope.service.dispose()
  })

  test("a failed transition does not block off and on, and shutdown prevents restart", async () => {
    const scope = fixture()
    scope.service.start?.()
    await scope.publish()
    const priorStarts = scope.starts
    scope.fail()
    await expect(scope.publish()).rejects.toThrow("observations unavailable")
    expect(scope.starts).toBe(priorStarts)
    scope.enable(false)
    const disabled = scope.selectionChanged()
    expect(scope.pauses).toBe(1)
    await disabled
    expect(scope.received.at(-1)).toEqual([])
    scope.enable(true)
    await scope.selectionChanged()
    expect(scope.starts).toBe(priorStarts + 1)
    expect(scope.received.at(-1)).toEqual([80, 95])
    scope.service.closeAdmission?.()
    await scope.selectionChanged()
    expect(scope.starts).toBe(priorStarts + 1)
    await scope.service.dispose()
  })
})

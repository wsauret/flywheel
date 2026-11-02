import { describe, expect, test } from "bun:test"
import { isAbortError } from "../../../../../src/infra/abort.js"
import { createSubscriptionUsageServicePool } from "../../../../../src/orchestration/auth/provider-observations/subscription-usage-service-pool.js"
import type { SubscriptionUsageProfile, SubscriptionUsageService } from "../../../../../src/orchestration/auth/provider-observations/subscription-usage-service.js"

function fakeService(profile: SubscriptionUsageProfile, closed: string[]): SubscriptionUsageService {
  let thresholds: readonly number[] = []
  let admissionClosed = false
  return {
    generation: () => ({ generation: 1, profileId: profile.id, profileDirectory: profile.directory, providerIds: [], enabledModuleIds: [], readerProviderIds: [], accounts: [], thresholds, identity: profile.id }),
    snapshot: () => undefined,
    currentAccounts: () => [],
    store: () => undefined,
    metric: () => ({ kind: "unknown" }),
    refresh: async () => undefined,
    replaceThresholds: async (next) => { thresholds = next; return undefined },
    check: async () => undefined,
    checkAccounts: async () => undefined,
    applyReset: async () => ({ kind: "noCredit" }),
    onPublished: () => () => {},
    start: () => {},
    pause: () => {},
    closeAdmission: () => { admissionClosed = true },
    settled: async () => { if (!admissionClosed) throw new Error("settled before admission closed"); closed.push(profile.id) },
  }
}

describe("subscription usage service pool", () => {
  test("coalesces leases only within one resolved profile", async () => {
    const created: string[] = []
    const closed: string[] = []
    const pool = createSubscriptionUsageServicePool({
      create: (profile) => { created.push(profile.id); return fakeService(profile, closed) },
    })
    const a = { id: "a", directory: "/profiles/a" }
    const b = { id: "b", directory: "/profiles/b" }

    const [a1, a2, b1] = await Promise.all([pool.acquire(a), pool.acquire(a), pool.acquire(b)])

    expect(a1.service).toBe(a2.service)
    expect(a1.service).not.toBe(b1.service)
    expect(created).toEqual(["a", "b"])
    await a1.release()
    expect(closed).toEqual([])
    await b1.release()
    expect(closed).toEqual(["b"])
    await a2.release()
    expect(closed).toEqual(["b", "a"])
  })

  test("recreates a released profile and drains each resident generation once on shutdown", async () => {
    const created: string[] = []
    const closed: string[] = []
    const pool = createSubscriptionUsageServicePool({
      create: (profile) => { created.push(profile.id); return fakeService(profile, closed) },
    })
    const a = { id: "a", directory: "/profiles/a" }
    const first = await pool.acquire(a)
    await first.release()
    const second = await pool.acquire(a)
    expect(second.service).not.toBe(first.service)

    pool.closeAdmission()
    const refusal = await pool.acquire({ id: "b", directory: "/profiles/b" }).then(() => undefined, (error: unknown) => error)
    // A closed pool is its owner's shutdown, so the refusal is an abort.
    expect(isAbortError(refusal)).toBe(true)
    expect(refusal).toMatchObject({ message: "subscription usage service pool is closed" })
    await pool.settled()
    await second.release()

    expect(created).toEqual(["a", "a"])
    expect(closed).toEqual(["a", "a"])
  })

  test("coalesces profile deletion with shutdown generation close", async () => {
    const closed: string[] = []
    const profile = { id: "a", directory: "/profiles/a" }
    const pool = createSubscriptionUsageServicePool({ create: (captured) => fakeService(captured, closed) })
    await pool.acquire(profile)

    const removal = pool.closeProfile(profile.id)
    pool.closeAdmission()
    const [finishRemoval] = await Promise.all([removal, pool.settled()])
    finishRemoval()

    expect(closed).toEqual(["a"])
  })

  test("blocks profile admission through removal and restores it after settlement failure", async () => {
    const created: string[] = []
    let failSettlement = true
    const pool = createSubscriptionUsageServicePool({
      create: (profile) => {
        created.push(profile.id)
        const service = fakeService(profile, [])
        return { ...service, settled: async () => { if (failSettlement) throw new Error("close failed") } }
      },
    })
    const profile = { id: "a", directory: "/profiles/a" }
    await pool.acquire(profile)
    await expect(pool.closeProfile("a")).rejects.toThrow("close failed")
    failSettlement = false
    const replacement = await pool.acquire(profile)
    const finishRemoval = await pool.closeProfile("a")
    let admitted = false
    const pendingAdmission = pool.acquire(profile).then(() => { admitted = true })
    await Bun.sleep(0)
    expect(admitted).toBe(false)
    finishRemoval()
    await pendingAdmission
    await replacement.release()
    expect(created).toEqual(["a", "a", "a"])
  })

  test("propagates threshold and capability refreshes to every admitted generation", async () => {
    const refreshed: string[] = []
    const thresholds: Array<{ id: string; values: readonly number[] }> = []
    const pool = createSubscriptionUsageServicePool({
      create: (profile) => {
        const service = fakeService(profile, [])
        return {
          ...service,
          refresh: async () => { refreshed.push(profile.id); return undefined },
          replaceThresholds: async (values) => { thresholds.push({ id: profile.id, values }); return undefined },
        }
      },
    })
    const a = await pool.acquire({ id: "a", directory: "/profiles/a" })
    const b = await pool.acquire({ id: "b", directory: "/profiles/b" })

    await pool.refresh()
    await pool.replaceThresholds([80, 95])

    expect(refreshed).toEqual(["a", "b"])
    expect(thresholds).toEqual([{ id: "a", values: [80, 95] }, { id: "b", values: [80, 95] }])
    await Promise.all([a.release(), b.release()])
  })

  test("fans out service publications with the captured profile", async () => {
    const listeners = new Set<() => void>()
    const profile = { id: "a", directory: "/profiles/a" }
    const snapshot = { generation: 1, profileId: profile.id, profileDirectory: profile.directory, checkedAtMs: 0, thresholds: [], accounts: [] }
    const service: SubscriptionUsageService = { ...fakeService(profile, []), snapshot: () => snapshot, onPublished: (listener) => { const publish = () => listener(snapshot); listeners.add(publish); return () => { listeners.delete(publish) } } }
    const pool = createSubscriptionUsageServicePool({ create: () => service })
    const published: string[] = []
    const unsubscribe = pool.onPublished((captured) => { published.push(captured.id) })
    const lease = await pool.acquire(profile)

    for (const listener of listeners) listener()
    expect(published).toEqual(["a"])

    unsubscribe()
    await lease.release()
    expect(listeners.size).toBe(0)
  })
  test("releases inactive-profile deletion before recreating the profile", async () => {
    const created: string[] = []
    const closed: string[] = []
    const pool = createSubscriptionUsageServicePool({
      create: (profile) => { created.push(profile.id); return fakeService(profile, closed) },
    })
    const profile = { id: "inactive", directory: "/profiles/inactive" }

    const finish = await pool.closeProfile(profile.id)
    finish()
    const lease = await pool.acquire(profile)

    expect(created).toEqual(["inactive"])
    await lease.release()
    expect(closed).toEqual(["inactive"])
  })

})


test("pausing optional polling preserves resident accounting leases and can restart", async () => {
  const calls: string[] = []
  const pool = createSubscriptionUsageServicePool({ create: (profile) => ({ ...fakeService(profile, calls), start: () => { calls.push("start") }, pause: () => { calls.push("pause") } }) })
  const lease = await pool.acquire({ id: "a", directory: "/profiles/a" })
  pool.start()
  pool.pause()
  const settlement = await pool.acquireSettlement(lease.profile)
  expect(settlement.service).toBe(lease.service)
  expect(calls).toEqual(["start", "pause"])
  pool.start()
  expect(calls).toEqual(["start", "pause", "start"])
  await settlement.release()
  await lease.release()
})


test("new and recreated profiles capture the current pool threshold policy before polling", async () => {
  const captured: Array<{ id: string; thresholds: readonly number[] }> = []
  const polled: Array<readonly number[]> = []
  const pool = createSubscriptionUsageServicePool({
    create: (profile, thresholds) => {
      captured.push({ id: profile.id, thresholds })
      const service = fakeService(profile, [])
      return { ...service, start() { polled.push(thresholds) } }
    },
  })
  const configured = [80, 95]
  await pool.replaceThresholds(configured)
  configured.push(100)
  pool.start()
  const profile = { id: "new", directory: "/profiles/new" }
  const first = await pool.acquire(profile)
  expect(captured).toEqual([{ id: "new", thresholds: [80, 95] }])
  expect(polled).toEqual([[80, 95]])
  await first.release()
  await pool.replaceThresholds([85, 100])
  const second = await pool.acquire(profile)
  expect(captured.at(-1)).toEqual({ id: "new", thresholds: [85, 100] })
  expect(polled.at(-1)).toEqual([85, 100])
  pool.pause()
  await pool.replaceThresholds([])
  const other = await pool.acquire({ id: "off", directory: "/profiles/off" })
  expect(captured.at(-1)).toEqual({ id: "off", thresholds: [] })
  expect(polled).toHaveLength(2)
  await Promise.all([second.release(), other.release()])
})

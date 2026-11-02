import { afterEach, describe, expect, test } from "bun:test"
import { type SubscriptionUsageOutcome, type SubscriptionUsageReport, CHATGPT_RATE_LIMIT_RESET_TYPE } from "../../../../../src/infra/llm/subscription-usage.js"
import { createSubscriptionUsageService } from "../../../../../src/orchestration/auth/provider-observations/subscription-usage-service.js"
import { createProfileFixture, definition, registry, report, writeAccounts } from "./_service-fixtures.js"

const { profile, cleanup } = createProfileFixture()
afterEach(cleanup)
const key = (providerId: string) => ({ providerId, instanceId: "account" })

describe("account-scoped subscription usage checks", () => {
  test("coalesces full and targeted provider work and preserves a newer row while a full check awaits its sibling", async () => {
    const directory = profile("account-overlap")
    const definitions = [definition("a"), definition("b")]
    writeAccounts(directory, definitions)
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const releaseA = Promise.withResolvers<void>()
    const reads = { a: 0, b: 0 }
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry(definitions, new Map([
        ["a", async () => { reads.a += 1; await releaseA.promise; return { kind: "success" as const, report: report("a", 10_000 + reads.a) } }],
        ["b", async () => { reads.b += 1; started.resolve(); await release.promise; return { kind: "success" as const, report: report("b", 10_000) } }],
      ])),
      thresholds: () => [],
      now: () => 10_000,
    })
    const full = service.check({ forceRefresh: true })
    await started.promise
    const joinA = service.checkAccounts([key("a"), key("a")], { forceRefresh: true })
    releaseA.resolve()
    await joinA
    const targeted = await service.checkAccounts([key("a")], { forceRefresh: true })
    const latestA = targeted?.accounts.find((row) => row.account.providerId === "a")
    const joinB = service.checkAccounts([key("b")], { forceRefresh: true })
    release.resolve()
    const complete = await full
    await joinB
    expect(reads.b).toBe(1)
    expect(reads.a).toBe(2)
    expect(complete?.accounts.find((row) => row.account.providerId === "a")).toBe(latestA)
    expect(complete?.accounts.map((row) => row.kind)).toEqual(["supported", "supported"])
    await service.settled()
  })

  test("a forced check does not join a cache-only full check", async () => {
    const directory = profile("force-after-cache")
    const definitions = [definition("a")]
    writeAccounts(directory, definitions)
    let reads = 0
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry(definitions, new Map([["a", async () => ({ kind: "success" as const, report: report("a", 10_000 + ++reads) })]])),
      thresholds: () => [], now: () => 10_000,
    })
    await service.check()
    await Promise.all([service.check(), service.checkAccounts([key("a")], { forceRefresh: true })])
    expect(reads).toBe(2)
    await service.settled()
  })

  test("retains publication identity for check-only changes and publishes complete semantic changes", async () => {
    const directory = profile("semantic-publication")
    const definitions = [definition("a")]
    writeAccounts(directory, definitions)
    let now = 10_000
    let nextReport: SubscriptionUsageReport = report("a", now)
    let failure = false
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry(definitions, new Map([["a", async (): Promise<SubscriptionUsageOutcome> => failure ? { kind: "fetch-failure" } : { kind: "success", report: nextReport }]])),
      thresholds: () => [], now: () => now,
    })
    let publications = 0
    service.onPublished(() => { publications += 1 })
    const first = await service.check()
    now += 1
    expect(await service.check()).toBe(first)
    expect(await service.replaceThresholds([])).toBeDefined()
    expect(service.snapshot()).toBe(first)
    expect(publications).toBe(1)
    for (const change of [
      { observedAtMs: now },
      { metrics: [] },
      { spendSources: [{ kind: "prepaid", availability: "available" }] },
      { providerStatus: "warning" },
      { label: "renamed", plan: "new plan" },
      { resetCredits: { availableCount: 1, credits: [{ id: "credit", resetType: CHATGPT_RATE_LIMIT_RESET_TYPE, status: "available" }] } },
    ] satisfies Partial<SubscriptionUsageReport>[]) {
      const previous = service.snapshot()
      const updatedReport: SubscriptionUsageReport = { ...nextReport, ...change, observedAtMs: ++now }
      nextReport = updatedReport
      await service.checkAccounts([key("a")], { forceRefresh: true })
      expect(service.snapshot()).not.toBe(previous)
    }
    const reset = service.snapshot()
    expect(await service.check()).toBe(reset)
    failure = true
    await service.checkAccounts([key("a")], { forceRefresh: true })
    const failed = service.snapshot()
    expect(failed).not.toBe(reset)
    expect(await service.checkAccounts([key("a")], { forceRefresh: true })).toBe(failed)
    await service.replaceThresholds([75])
    expect(service.snapshot()).not.toBe(failed)
    await service.settled()
  })

  test("aborts and joins targeted account work before closing its stable authority", async () => {
    const directory = profile("targeted-close")
    const definitions = [definition("a"), definition("b")]
    writeAccounts(directory, definitions)
    const started = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry(definitions, new Map([["a", async ({ signal }) => {
        signal.addEventListener("abort", () => aborted.resolve(), { once: true })
        started.resolve()
        await release.promise
        return { kind: "fetch-failure" as const }
      }]])),
      thresholds: () => [],
    })
    const authority = service.store()!
    const target = service.checkAccounts([key("a")], { forceRefresh: true })
    await started.promise
    service.closeAdmission()
    let closed = false
    const shutdown = service.settled().then(() => { closed = true })
    await aborted.promise
    expect(closed).toBe(false)
    expect(() => authority.revision()).not.toThrow()
    release.resolve()
    expect(await target).toBeUndefined()
    await shutdown
    expect(() => authority.revision()).toThrow("disposed")
  })

  test("a successful reset refreshes metrics captured before a pending credit-detail read", async () => {
    const directory = profile("reset-pending-details")
    const providerIds = ["chatgpt", "sibling"] as const
    const definitions = providerIds.map(definition)
    writeAccounts(directory, definitions)
    const detailsStarted = Promise.withResolvers<void>()
    const releaseDetails = Promise.withResolvers<void>()
    const resetCompleted = Promise.withResolvers<void>()
    const reads = { chatgpt: 0, sibling: 0 }
    let resetApplied = false
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry(definitions, new Map(providerIds.map((id) => [id, async () => {
        const read = ++reads[id]
        const observation = report(id, 10_000 + read)
        const metrics = observation.metrics.map((metric) => ({
          ...metric,
          usedFraction: resetApplied ? 0 : 0.6,
          remaining: { ...metric.remaining, value: resetApplied ? 10 : 4 },
        }))
        if (id === "chatgpt" && read === 2) {
          detailsStarted.resolve()
          await releaseDetails.promise
        }
        return { kind: "success" as const, report: {
          ...observation, metrics,
          resetCredits: { availableCount: resetApplied ? 0 : 1, credits: resetApplied ? [] : [{ id: "credit", resetType: CHATGPT_RATE_LIMIT_RESET_TYPE, status: "available" as const }] },
        } }
      }])), new Map([["chatgpt", async () => {
        resetApplied = true
        resetCompleted.resolve()
        return { kind: "reset" as const }
      }]])),
      thresholds: () => [], now: () => 10_000,
    })
    try {
      await service.check()
      const authority = service.store()!
      const reviewed = { authorityIncarnation: authority.incarnation(), revision: authority.revision() }
      const sibling = service.snapshot()?.accounts.find((row) => row.account.providerId === "sibling")
      const oldRead = service.checkAccounts([key("chatgpt")], { forceRefresh: true })
      await detailsStarted.promise
      let resetSettled = false
      const reset = service.applyReset({ ...key("chatgpt"), ...reviewed, actionId: "pending-details" }).then((outcome) => {
        resetSettled = true
        return outcome
      })
      await resetCompleted.promise
      await Bun.sleep(0)
      expect(resetSettled).toBe(false)
      expect(reads).toEqual({ chatgpt: 2, sibling: 1 })
      releaseDetails.resolve()
      await oldRead
      expect(await reset).toEqual({ kind: "reset" })
      expect(service.metric("chatgpt", "account", "remaining")).toMatchObject({
        kind: "fresh", metric: { usedFraction: 0, remaining: { value: 10 } },
      })
      expect(reads).toEqual({ chatgpt: 3, sibling: 1 })
      expect(service.snapshot()?.accounts.find((row) => row.account.providerId === "sibling")).toBe(sibling)
      expect(service.store()).toBe(authority)
    } finally {
      releaseDetails.resolve()
      service.closeAdmission()
      await service.settled()
    }
  })

  test("full and targeted checks coalesce while nothingToReset requires a subsequent target read", async () => {
    const directory = profile("reset-overlap")
    const providerIds = ["a", "b"] as const
    const definitions = providerIds.map(definition)
    writeAccounts(directory, definitions)
    let hold = false
    const reads = { a: 0, b: 0 }
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const resetStarted = Promise.withResolvers<void>()
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry(definitions, new Map(providerIds.map((id) => [id, async () => {
        reads[id] += 1
        if (hold) { started.resolve(); await release.promise }
        return { kind: "success" as const, report: {
          ...report(id, 10_000 + reads[id]),
          resetCredits: { availableCount: 1, credits: [{ id: "credit", resetType: CHATGPT_RATE_LIMIT_RESET_TYPE, status: "available" as const }] },
        } }
      }])), new Map([["a", async () => { resetStarted.resolve(); return { kind: "nothingToReset" as const } }]])),
      thresholds: () => [], now: () => 10_000,
    })
    await service.check()
    const authority = service.store()!
    const reviewed = { authorityIncarnation: authority.incarnation(), revision: authority.revision() }
    hold = true
    const full = service.check({ forceRefresh: true })
    await started.promise
    const reset = service.applyReset({ ...key("a"), ...reviewed, actionId: "overlap" })
    const target = service.checkAccounts([key("a")], { forceRefresh: true })
    await resetStarted.promise
    expect(reads).toEqual({ a: 2, b: 2 })
    release.resolve()
    expect(await reset).toEqual({ kind: "nothingToReset" })
    const [fullSnapshot] = await Promise.all([full, target])
    expect(reads).toEqual({ a: 3, b: 2 })
    expect(service.snapshot()?.accounts.find((row) => row.account.providerId === "a")).toMatchObject({
      kind: "supported", snapshot: { observedAtMs: 10_003 },
    })
    expect(service.snapshot()?.accounts.find((row) => row.account.providerId === "b")).toBe(fullSnapshot?.accounts.find((row) => row.account.providerId === "b"))
    expect(service.store()).toBe(authority)
    await service.settled()
  })
})

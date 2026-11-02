import { afterEach, describe, expect, test } from "bun:test"
import { Redacted } from "effect"
import { type SubscriptionUsageReader, type SubscriptionUsageResetConsumer, CHATGPT_RATE_LIMIT_RESET_TYPE } from "../../../../../src/infra/llm/subscription-usage.js"
import { createSubscriptionUsageStore } from "../../../../../src/infra/llm/subscription-usage-store.js"
import { createUsageAuthority } from "../../../../../src/infra/llm/usage-authority.js"
import { createSubscriptionUsageService, SUBSCRIPTION_USAGE_CHECK_INTERVAL_MS } from "../../../../../src/orchestration/auth/provider-observations/subscription-usage-service.js"
import { createProfileFixture, definition, readerFor, registry, report, writeAccounts } from "./_service-fixtures.js"

const { profile, cleanup } = createProfileFixture()

afterEach(cleanup)

describe("subscription usage service lifecycle", () => {
  test("drains an old generation before admitting the replacement", async () => {
    const directory = profile("drain")
    const definitions = [definition("supported")]
    writeAccounts(directory, definitions)
    const started = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const reader: SubscriptionUsageReader = async ({ signal }) => {
      signal.addEventListener("abort", () => aborted.resolve(), { once: true })
      started.resolve()
      await release.promise
      return { kind: "fetch-failure" }
    }
    let activeReader = reader
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry(definitions, new Map([["supported", activeReader]])),
      thresholds: () => [],
    })
    const authority = service.store()
    const publications: number[] = []
    service.onPublished((snapshot) => { publications.push(snapshot.generation) })
    const check = service.check({ forceRefresh: true })
    await started.promise
    activeReader = readerFor("supported")
    let refreshed = false
    const replacement = service.refresh().then((value) => { refreshed = true; return value })
    await aborted.promise
    expect(refreshed).toBe(false)
    const latest = service.refresh()
    release.resolve()
    expect(await check).toBeUndefined()
    await replacement
    const generation = await latest
    if (generation === undefined) throw new Error("Expected the latest refresh generation")
    expect(publications).toEqual([])
    expect((await service.check())?.accounts[0]?.kind).toBe("supported")
    expect(publications).toEqual([generation.generation])
    expect(service.store()).toBe(authority)
    await service.settled()
  })

  test("same-identity credential replacement rebuilds the generation with the new secret", async () => {
    const directory = profile("credential-replacement")
    const definitions = [definition("supported")]
    writeAccounts(directory, definitions, "first-secret")
    const seen: string[] = []
    const reader: SubscriptionUsageReader = async ({ account }) => {
      if (account.credential.type !== "oauth") throw new Error("expected OAuth")
      seen.push(Redacted.value(account.credential.access))
      return { kind: "success", report: report("supported", 10_000) }
    }
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry(definitions, new Map([["supported", reader]])),
      thresholds: () => [],
    })
    const first = service.generation()
    const authority = service.store()
    await service.check({ forceRefresh: true })
    writeAccounts(directory, definitions, "second-secret")
    const second = await service.refresh()
    await service.check()

    expect(second?.generation).not.toBe(first?.generation)
    expect(second?.identity).not.toBe(first?.identity)
    expect(seen).toEqual(["first-secret", "second-secret"])
    expect(service.store()).toBe(authority)
    await service.settled()
  })

  test("the monitor starts immediately and schedules a bounded five-minute jitter", async () => {
    const directory = profile("monitor")
    const definitions = [definition("supported")]
    writeAccounts(directory, definitions)
    const timers: Array<{ readonly delayMs: number; readonly cancel: () => void }> = []
    const scheduler = {
      nowMs: () => 10_000,
      setTimer: (fire, delayMs) => {
        let cancelled = false
        const timer = { delayMs, cancel: () => { cancelled = true } }
        timers.push(timer)
        void cancelled
        void fire
        return timer.cancel
      },
    } satisfies NonNullable<Parameters<typeof createSubscriptionUsageService>[0]["scheduler"]>
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry(definitions, new Map([["supported", readerFor("supported")]])),
      thresholds: () => [],
      scheduler,
      random: () => 0,
      monitor: true,
    })
    let publications = 0
    service.onPublished(() => { publications += 1 })

    service.start()
    await Bun.sleep(0)
    expect(publications).toBe(1)
    expect(timers).toHaveLength(1)
    expect(timers[0]?.delayMs).toBe(SUBSCRIPTION_USAGE_CHECK_INTERVAL_MS * 0.75)
    service.closeAdmission()
    await service.settled()
  })

  test("forces the initial generation to refresh provider billing evidence after restart", async () => {
    const directory = profile("restart-billing-evidence")
    const definitions = [definition("supported")]
    writeAccounts(directory, definitions)
    const store = createSubscriptionUsageStore({ profileDir: directory, profileId: "default" })
    store.record({ ...report("supported", 10_000), spendSources: [{ kind: "prepaid", availability: "funded", remaining: { kind: "count", value: 4, unit: "credits", provenance: "provider", precision: "exact" } }] })
    store.dispose()
    let providerReads = 0
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry(definitions, new Map([["supported", async () => {
        providerReads += 1
        return { kind: "success" as const, report: { ...report("supported", 10_001), spendSources: [{ kind: "prepaid" as const, availability: "empty" as const }] } }
      }]])),
      thresholds: () => [],
      now: () => 10_000,
    })

    await service.check()

    expect(providerReads).toBe(1)
    expect(service.snapshot()?.accounts[0]).toMatchObject({ kind: "supported", snapshot: { spendSources: [{ kind: "prepaid", availability: "empty" }] } })
    await service.settled()
  })

  test("proves each captured account independently", async () => {
    const directory = profile("per-account-generation-proof")
    const definitions = [definition("first"), definition("second")]
    writeAccounts(directory, definitions)
    const durable = createSubscriptionUsageStore({ profileDir: directory, profileId: "default" })
    durable.record(report("second", 10_000))
    durable.dispose()
    const reads = new Map<string, number>()
    const readers = new Map(definitions.map(({ id }) => [id, (async () => {
      reads.set(id, (reads.get(id) ?? 0) + 1)
      return id === "first" ? { kind: "success" as const, report: report(id, 10_000) } : { kind: "fetch-failure" as const }
    }) satisfies SubscriptionUsageReader]))
    let now = 10_000
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry(definitions, readers),
      thresholds: () => [],
      now: () => now,
    })

    await service.check()
    // The failed account is read again once the retry spacing has passed; the
    // proven account stays fresh and is not read again.
    now += 60_000
    const second = await service.check()
    expect(reads).toEqual(new Map([["first", 1], ["second", 2]]))
    expect(second?.accounts.map(({ kind }) => kind)).toEqual(["supported", "stale"])
    await service.settled()
  })

  test("does not treat a fresh competing snapshot as generation proof", async () => {
    const directory = profile("competing-snapshot-proof")
    const definitions = [definition("supported")]
    writeAccounts(directory, definitions)
    const durable = createSubscriptionUsageStore({ profileDir: directory, profileId: "default" })
    durable.record({ ...report("supported", 10_000), spendSources: [{ kind: "prepaid", availability: "empty" }] })
    durable.dispose()
    let providerReads = 0
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry(definitions, new Map([["supported", async () => {
        providerReads += 1
        return { kind: "success" as const, report: report("supported", 10_000) }
      }]])),
      thresholds: () => [],
      now: () => 10_000,
      openStore: (capturedProfile) => {
        const store = createUsageAuthority({ profileDir: capturedProfile.directory, profileId: capturedProfile.id })
        store.acquireFetch = async () => undefined
        return store
      },
    })

    expect((await service.check())?.accounts[0]).toMatchObject({ kind: "stale", message: "subscription usage fetch is busy; retained provider observation is inspection-only" })
    expect((await service.check())?.accounts[0]?.kind).toBe("stale")
    expect(providerReads).toBe(0)
    await service.settled()
  })

  test("reuses a fresh durable snapshot only after a committed reader success", async () => {
    const directory = profile("committed-generation-proof")
    const definitions = [definition("supported")]
    writeAccounts(directory, definitions)
    let providerReads = 0
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry(definitions, new Map([["supported", async () => {
        providerReads += 1
        return { kind: "success" as const, report: report("supported", 10_000) }
      }]])),
      thresholds: () => [],
      now: () => 10_000,
    })

    expect((await service.check())?.accounts[0]?.kind).toBe("supported")
    expect((await service.check())?.accounts[0]?.kind).toBe("supported")
    expect(providerReads).toBe(1)
    await service.settled()
  })

  test("refreshes provider evidence after definitive and stale reset outcomes", async () => {
    const directory = profile("reset-refresh")
    const provider = definition("chatgpt")
    writeAccounts(directory, [provider])
    let providerReads = 0
    const reader: SubscriptionUsageReader = async () => ({ kind: "success", report: {
      ...report("chatgpt", 10_000 + ++providerReads),
      resetCredits: { availableCount: 1, credits: [{ id: "credit", resetType: CHATGPT_RATE_LIMIT_RESET_TYPE, status: "available", expiresAtMs: 20_000 }] },
    } })
    const consumed: string[] = []
    const consumer: SubscriptionUsageResetConsumer = async ({ creditId }) => { consumed.push(creditId); return { kind: "nothingToReset" } }
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry([provider], new Map([[provider.id, reader]]), new Map([[provider.id, consumer]])),
      thresholds: () => [],
      now: () => 10_000,
    })
    await service.check({ forceRefresh: true })
    const authority = service.store()
    if (authority === undefined) throw new Error("Usage authority did not open")
    const reviewed = { authorityIncarnation: authority.incarnation(), revision: authority.revision() }

    expect(await service.applyReset({ providerId: provider.id, instanceId: "account", ...reviewed, actionId: "first" })).toEqual({ kind: "nothingToReset" })
    expect(providerReads).toBe(2)
    expect(consumed).toEqual(["credit"])
    expect(await service.applyReset({ providerId: provider.id, instanceId: "account", ...reviewed, actionId: "stale" })).toEqual({ kind: "stale" })
    expect(providerReads).toBe(3)
    expect(consumed).toEqual(["credit"])
    await service.settled()
  })

  test("does not route reset evidence through a provider without a reset contribution", async () => {
    const directory = profile("reset-provider-isolation")
    const provider = definition("github_copilot")
    writeAccounts(directory, [provider])
    let providerReads = 0
    const reader: SubscriptionUsageReader = async () => ({ kind: "success", report: {
      ...report(provider.id, 10_000 + ++providerReads),
      resetCredits: { availableCount: 1, credits: [{ id: "credit", resetType: CHATGPT_RATE_LIMIT_RESET_TYPE, status: "available" }] },
    } })
    const service = createSubscriptionUsageService({ profile: () => ({ id: "default", directory }), registry: () => registry([provider], new Map([[provider.id, reader]])), thresholds: () => [], now: () => 10_000 })
    await service.check({ forceRefresh: true })
    const authority = service.store()
    if (authority === undefined) throw new Error("Usage authority did not open")

    expect(await service.applyReset({ providerId: provider.id, instanceId: "account", authorityIncarnation: authority.incarnation(), revision: authority.revision(), actionId: "isolated" })).toEqual({ kind: "noCredit" })
    expect(providerReads).toBe(2)
    await service.settled()
  })

  test("aborts and joins reset consumption with its profile generation", async () => {
    const directory = profile("reset-lifecycle")
    const provider = definition("chatgpt")
    writeAccounts(directory, [provider])
    const reader: SubscriptionUsageReader = async () => ({ kind: "success", report: { ...report(provider.id, 10_000), resetCredits: { availableCount: 1, credits: [{ id: "credit", resetType: CHATGPT_RATE_LIMIT_RESET_TYPE, status: "available" }] } } })
    const started = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const consumer: SubscriptionUsageResetConsumer = async ({ signal }) => {
      signal.addEventListener("abort", () => aborted.resolve(), { once: true })
      started.resolve()
      await release.promise
      return { kind: "uncertain" }
    }
    const service = createSubscriptionUsageService({ profile: () => ({ id: "default", directory }), registry: () => registry([provider], new Map([[provider.id, reader]]), new Map([[provider.id, consumer]])), thresholds: () => [], now: () => 10_000 })
    await service.check({ forceRefresh: true })
    const authority = service.store()
    if (authority === undefined) throw new Error("Usage authority did not open")
    const operation = service.applyReset({ providerId: provider.id, instanceId: "account", authorityIncarnation: authority.incarnation(), revision: authority.revision(), actionId: "lifecycle" })
    await started.promise

    service.closeAdmission()
    let settled = false
    const shutdown = Promise.all([service.settled(), service.settled()]).then(() => { settled = true })
    await aborted.promise
    expect(settled).toBe(false)
    expect(() => authority.revision()).not.toThrow()
    release.resolve()
    await shutdown
    expect(await operation).toEqual({ kind: "uncertain" })
    expect(() => authority.revision()).toThrow("Usage authority is disposed")
  })
})

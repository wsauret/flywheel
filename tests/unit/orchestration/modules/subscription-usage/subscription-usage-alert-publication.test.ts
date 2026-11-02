import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AccessProviderDefinition } from "../../../../../src/infra/llm/access-provider.js"
import type { SubscriptionUsageReport } from "../../../../../src/infra/llm/subscription-usage.js"
import { createUsageAuthority } from "../../../../../src/infra/llm/usage-authority.js"
import { createUsageAppService as createFlywheelAppService } from "../../../../helpers/usage-app-service.js"
import { createFrontendProjection } from "../../../../../src/orchestration/app-service/frontend-projection.js"
import { createRuntimeUiBus } from "../../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { createSubscriptionUsageService } from "../../../../../src/orchestration/auth/provider-observations/subscription-usage-service.js"
import { createSubscriptionUsageServicePool } from "../../../../../src/orchestration/auth/provider-observations/subscription-usage-service-pool.js"
import { registry } from "../../auth/provider-observations/_service-fixtures.js"
import { fakeManager, fakeProjections, fakeSessionStore, runtimeSupervisor } from "../../app-service/app-service-doubles.js"

const roots: string[] = []

const provider: AccessProviderDefinition = {
  id: "test-subscription",
  displayName: "Test subscription",
  shortName: "Test",
  billing: "subscription",
  rank: 1,
  supportedFamilies: ["openai"],
  configHints: [],
  catalogId: undefined,
  auth: { kind: "oauth", credentialId: "test-subscription", flow: "device-code", statusRank: 1, start: async () => { throw new Error("test provider has no login") } },
  cli: { name: "test" },
  staticModelUnavailableReason: () => undefined,
}

function report(observedAtMs: number, usedFraction: number): SubscriptionUsageReport {
  return {
    providerId: provider.id,
    instanceId: "account",
    identity: "test-identity",
    providerStatus: "ok",
    observedAtMs,
    metrics: [{
      metricKey: "requests",
      label: "Requests",
      scope: { kind: "account" },
      rank: 0,
      timing: { kind: "exact", startMs: observedAtMs - 1_000, endMs: observedAtMs + 1_000 },
      remaining: { kind: "count", value: Math.round(100 * (1 - usedFraction)), unit: "requests", provenance: "provider", precision: "exact" },
      limit: { kind: "count", value: 100, unit: "requests", provenance: "provider", precision: "exact" },
      usedFraction,
    }],
  }
}


const openStores: Array<{ dispose(): void }> = []
function trackStore<T extends { dispose(): void }>(store: T): T {
  openStores.push(store)
  return store
}

afterEach(() => {
  // Stores first: an open database file keeps its directory undeletable on
  // Windows, so a store outliving its profile directory fails the teardown.
  for (const store of openStores.splice(0)) store.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function appService(profileDir: string, subscriptionUsage: ReturnType<typeof createSubscriptionUsageService>, now: () => number) {
  const sessionStore = fakeSessionStore(new Map())
  const manager = fakeManager()
  const projections = fakeProjections()
  const configView = { ...projections.config.view(), diagnostics: [] }
  return createFlywheelAppService({
    projection: createFrontendProjection({ sessionStore, manager, projectRoot: profileDir }),
    projectRoot: profileDir,
    runtimeSupervisor: runtimeSupervisor(),
    bus: createRuntimeUiBus(),
    subscriptionUsage: {
      acquireScope: async () => ({ profile: { id: "default", directory: profileDir }, service: subscriptionUsage, release: async () => {} }),
      subscribePublications: () => () => {},
    },
    now,
    ...projections,
    config: { ...projections.config, view: () => configView, refresh: async () => configView },
  })
}
describe("subscription usage current query", () => {
  test("keeps durable data pending until the current generation polls and honors query freshness", async () => {
    const profileDir = mkdtempSync(join(realpathSync(tmpdir()), "flywheel-current-freshness-"))
    roots.push(profileDir)
    writeFileSync(join(profileDir, "auth.json"), JSON.stringify({
      [provider.id]: [{ id: "account", identity: "test-identity", lineageId: "11111111-1111-4111-8111-111111111111", credential: { type: "oauth", access: "access", refresh: "refresh", expires: 9_999_999_999 } }],
    }))
    let now = 10_000
    const providerRegistry = registry([provider], new Map([[provider.id, async () => ({ kind: "success" as const, report: report(now, 0.5) })]]))
    const subscriptionUsage = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory: profileDir }), registry: () => providerRegistry, thresholds: () => [], now: () => now,
      openStore: () => trackStore(createUsageAuthority({ profileDir, profileId: "default", now: () => now })),
    })
    const service = appService(profileDir, subscriptionUsage, () => now)
    const pool = createSubscriptionUsageServicePool({ create: () => subscriptionUsage })
    await pool.acquire({ id: "default", directory: profileDir })

    expect((await service.query({ type: "usage.accounts", scope: { kind: "defaults" } })).sources.find((source) => source.kind === "subscription")?.observation.state).toBe("pending")
    await subscriptionUsage.check({ forceRefresh: true })
    await subscriptionUsage.refresh()
    const generationStore = subscriptionUsage.store()
    if (!generationStore) throw new Error("expected a generation-owned usage store")
    expect((await service.query({ type: "usage.accounts", scope: { kind: "defaults" }, freshnessMs: 1_000 })).sources.find((source) => source.kind === "subscription")?.observation.state).toBe("pending")
    now += 1
    expect((await service.query({ type: "usage.accounts", scope: { kind: "defaults" }, freshnessMs: 0 })).sources.find((source) => source.kind === "subscription")?.observation.state).toBe("stale")

    const finishRemoval = await pool.closeProfile("default")
    finishRemoval()
    expect(() => generationStore.revision()).toThrow("disposed")
  })
})

describe("subscription usage history query", () => {
  test("selects the lowest remaining-only sample as peak usage and preserves its native values", async () => {
    const profileDir = mkdtempSync(join(realpathSync(tmpdir()), "flywheel-history-peak-"))
    roots.push(profileDir)
    writeFileSync(join(profileDir, "auth.json"), JSON.stringify({
      [provider.id]: [{ id: "account", identity: "test-identity", lineageId: "11111111-1111-4111-8111-111111111111", credential: { type: "oauth", access: "access", refresh: "refresh", expires: 9_999_999_999 } }],
    }))
    const now = Date.UTC(2026, 0, 2, 12)
    const providerRegistry = registry([provider], new Map([[provider.id, async () => ({ kind: "success" as const, report: report(now - 3 * 60 * 60_000, 0.5) })]]))
    const usageStore = trackStore(createUsageAuthority({ profileDir, profileId: "default", now: () => now }))
    const subscriptionUsage = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory: profileDir }), registry: () => providerRegistry, thresholds: () => [], now: () => now,
      openStore: () => usageStore,
    })
    await subscriptionUsage.check({ forceRefresh: true })
    const native = (remaining: number, observedAtMs: number) => ({
      providerId: provider.id, instanceId: "account", identity: "test-identity", providerStatus: "ok" as const, observedAtMs,
      metrics: [{ metricKey: "requests", label: "Requests", scope: { kind: "account" as const }, rank: 0, timing: { kind: "exact" as const, startMs: now - 86_400_000, endMs: now + 1 }, remaining: { kind: "count" as const, value: remaining, unit: "requests", provenance: "provider" as const, precision: "exact" as const }, limit: { kind: "count" as const, value: 100, unit: "requests", provenance: "provider" as const, precision: "exact" as const } }],
    })
    usageStore.record(native(80, now - 2 * 60 * 60_000))
    usageStore.record(native(20, now - 60 * 60_000))
    const service = appService(profileDir, subscriptionUsage, () => now)

    const result = await service.query({ type: "usage.history", scope: { kind: "defaults" }, range: "24h" })
    expect(result.sources[0]?.peak[0]?.remaining?.value).toBe(20)
    expect(result.sources[0]?.peak[0]?.limit?.value).toBe(100)

    subscriptionUsage.closeAdmission()
    await subscriptionUsage.settled()
  })
})

import { afterEach, describe, expect, test, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { UsageAccountsResultSchema } from "../../../../../src/protocol/modules/subscription-usage.js"
import { createUsageAppService as createFlywheelAppService, type UsageAppServiceDeps as FlywheelAppServiceDeps } from "../../../../helpers/usage-app-service.js"
import { RuntimeProtocolRpc } from "../../../../../src/protocol/runtime-protocol-schemas.js"
import { createFrontendProjection } from "../../../../../src/orchestration/app-service/frontend-projection.js"
import { createRuntimeUiBus } from "../../../../../src/orchestration/app-service/runtime-ui-bus.js"
import type { SubscriptionUsageService } from "../../../../../src/orchestration/auth/provider-observations/subscription-usage-service.js"
import { createUsageAuthority, type UsageAuthority } from "../../../../../src/infra/llm/usage-authority.js"
import type { UsageEntry } from "../../../../../src/infra/llm/usage-entry.js"
import { createInertSubscriptionUsageService } from "../../../../helpers/subscription-usage-service-fixture.js"
import { projectUsageAccounts } from "../../../../../src/orchestration/modules/subscription-usage/usage-projection.js"
import { fakeManager, fakeProjections, fakeSessionStore, runtimeSupervisor } from "../../app-service/app-service-doubles.js"
import { CHATGPT_RATE_LIMIT_RESET_TYPE } from "../../../../../src/infra/llm/subscription-usage.js"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function entry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    attemptId: crypto.randomUUID(), occurredAt: "2025-01-15T12:00:00.000Z", profileId: "default", currency: "USD", coverage: "complete",
    attribution: { kind: "candidate", providerId: "openai_api" }, spendMode: "direct_api",
    credentialLineage: "00000000-0000-4000-8000-000000000010", model: "gpt-5",
    tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 0 }, classification: "real_spend",
    price: { kind: "priced", estimatedUsd: 3, rateCard: { inputPerMillionUsd: 1 }, provenance: "live" },
    ...overrides,
  }
}

function usageService(authority: UsageAuthority, profileId = "default", onCheck: () => void = () => {}) {
  const generation = {
    generation: 1, profileId, profileDirectory: authority.dbFile, providerIds: ["chatgpt"], enabledModuleIds: [], readerProviderIds: ["chatgpt"],
    accounts: [{ providerId: "chatgpt", instanceId: "account-a", identity: "subject-a", label: "Personal" }], thresholds: [], identity: `generation:${profileId}`,
  }
  return createInertSubscriptionUsageService({ generation, authority, onCheck })
}

function serviceFor(authority: UsageAuthority, onCheck: () => void = () => {}, incomplete = false, service?: SubscriptionUsageService) {
  const store = fakeSessionStore(new Map())
  const manager = fakeManager()
  const usage = service ?? usageService(authority, "default", onCheck)
  const deps = {
    projectRoot: "/project",
    projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: "/project" }),
    bus: createRuntimeUiBus(),
    ...fakeProjections(),
    runtimeSupervisor: runtimeSupervisor(),
    subscriptionUsage: {
      acquireScope: async () => ({ profile: { id: "default", directory: authority.dbFile }, service: usage, release: async () => {} }),
      subscribePublications: () => () => {},
    },
    meteredUsageSources: () => [{ kind: "metered", sourceId: "00000000-0000-4000-8000-000000000010", providerId: "openai_api", label: "OpenAI", spendMode: "direct_api" }],
    usageProviderDisplayName: (providerId: string) => providerId === "chatgpt" ? "ChatGPT" : "OpenAI",
    usageIncomplete: async () => incomplete,
  } satisfies FlywheelAppServiceDeps
  return createFlywheelAppService(deps)
}

describe("unified Usage protocol", () => {
  test("reads the current revision without aggregating activity or checking providers", async () => {
    const root = mkdtempSync(join(tmpdir(), "usage-protocol-")); roots.push(root)
    const authority = createUsageAuthority({ profileDir: root, profileId: "default" })
    const aggregate = spyOn(authority, "rangeEntries")
    const quotas = spyOn(authority, "accountsQuotaAccounting")
    let checks = 0
    const service = serviceFor(authority, () => { checks += 1 })
    try {
      const before = await service.query({ type: "usage.metadata", scope: { kind: "defaults" } })
      authority.append(entry())
      const after = await service.query({ type: "usage.metadata", scope: { kind: "defaults" } })
      expect(after).toMatchObject({ kind: "usage.metadata", profileId: "default", authorityIncarnation: before.authorityIncarnation, revision: before.revision + 1 })
      expect(aggregate).not.toHaveBeenCalled()
      expect(quotas).not.toHaveBeenCalled()
      expect(checks).toBe(0)
    } finally { aggregate.mockRestore(); quotas.mockRestore(); authority.dispose() }
  })

  test("returns empty account activity at and before tracking began", async () => {
    const root = mkdtempSync(join(tmpdir(), "usage-protocol-")); roots.push(root)
    const trackingStart = Date.parse("2025-01-20T00:00:00.000Z")
    const authority = createUsageAuthority({ profileDir: root, profileId: "default", now: () => trackingStart })
    const service = serviceFor(authority)
    for (const asOf of [trackingStart, trackingStart - 1]) {
      const result = await service.query({ type: "usage.accounts", scope: { kind: "defaults" }, asOf })
      expect(result.sources).toHaveLength(2)
      for (const source of result.sources) expect(source.activity).toMatchObject({
        state: "available", startMs: new Date(new Date(asOf).getFullYear(), new Date(asOf).getMonth(), 1).getTime(), endMs: asOf,
        trackingStartMs: trackingStart, partial: true, attempts: 0, estimatedBilledUsd: 0, includedValueUsd: 0,
      })
      expect(Schema.decodeUnknownSync(UsageAccountsResultSchema)(result)).toEqual(result)
    }
    authority.dispose()
  })

  test("keeps unknown prices visible without marking the period incomplete", async () => {
    const root = mkdtempSync(join(tmpdir(), "usage-protocol-")); roots.push(root)
    const authority = createUsageAuthority({ profileDir: root, profileId: "default", now: () => Date.parse("2025-01-01T00:00:00.000Z") })
    authority.append(entry())
    authority.append(entry({ attemptId: crypto.randomUUID(), attribution: { kind: "candidate", providerId: "chatgpt", instanceId: "account-a" }, spendMode: "included", credentialLineage: "00000000-0000-4000-8000-000000000020", model: "gpt-4o", classification: "subscription_equivalent", price: { kind: "priced", estimatedUsd: 2, rateCard: { inputPerMillionUsd: 1 }, provenance: "live" } }))
    authority.append(entry({ attemptId: crypto.randomUUID(), model: "unknown-model", price: { kind: "unavailable", reason: "missing catalog price" } }))
    let checkCalls = 0
    const service = serviceFor(authority, () => { checkCalls += 1 })

    const accounts = await service.query({ type: "usage.accounts", scope: { kind: "defaults" }, asOf: Date.parse("2025-01-20T00:00:00.000Z") })
    const spend = await service.query({ type: "usage.spend", scope: { kind: "defaults" }, asOf: Date.parse("2025-01-20T00:00:00.000Z") })

    expect(accounts).toMatchObject({
      kind: "usage.accounts",
      profileId: "default",
      sources: [
        { kind: "subscription", label: "Personal", quotaAccounting: { state: "window-unavailable" }, activity: { state: "available", includedValueUsd: 2, estimatedBilledUsd: 0, attempts: 1 } },
        { kind: "metered", label: "OpenAI", activity: { state: "available", includedValueUsd: 0, estimatedBilledUsd: 3, attempts: 2, priceUnavailable: true } },
      ],
    })
    expect(accounts.sources[0]?.activity).toMatchObject({ startMs: Date.parse(authority.trackingStart), endMs: Date.parse("2025-01-20T00:00:00.000Z") })
    expect(accounts.sources[1]).not.toHaveProperty("quotaAccounting")
    expect(accounts).not.toHaveProperty("startMs")
    expect(spend).toMatchObject({ kind: "usage.spend", profileId: "default", range: "Month", estimatedBilledUsd: 3, includedValueUsd: 2, incomplete: false })
    const metered = spend.sources.find((source) => source.sourceId === "00000000-0000-4000-8000-000000000010")
    expect(metered).toMatchObject({ priceUnavailable: true })
    expect(metered?.models.find((model) => model.model === "unknown-model")).toMatchObject({ priceUnavailable: true, estimatedBilledUsd: 0, includedValueUsd: 0 })
    expect((await service.query({ type: "usage.history", scope: { kind: "defaults" }, range: "24h" })).sources[0]?.samples).toBeArray()
    expect((await service.query({ type: "usage.history", scope: { kind: "defaults" }, range: "Month" })).sources[0]?.samples).toBeArray()
    expect((await service.query({ type: "usage.history", scope: { kind: "defaults" }, range: "All" })).range).toBe("All")
    expect(checkCalls).toBe(0)
    await expect(service.dispatch({ type: "usage.refresh", scope: { kind: "defaults" } })).resolves.toMatchObject({ ok: true, usage: { profileId: "default" } })
    expect(checkCalls).toBe(1)
    authority.dispose()
  })

  test("account activity is local calendar-month-to-date with an exclusive end", async () => {
    const root = mkdtempSync(join(tmpdir(), "usage-protocol-")); roots.push(root)
    const asOf = new Date(2025, 1, 20, 12).getTime()
    const authority = createUsageAuthority({ profileDir: root, profileId: "default", now: () => new Date(2025, 0, 1).getTime() })
    authority.append(entry({ attemptId: crypto.randomUUID(), occurredAt: new Date(2025, 0, 31, 23, 59).toISOString() }))
    authority.append(entry({ attemptId: crypto.randomUUID(), occurredAt: new Date(2025, 1, 1).toISOString() }))
    authority.append(entry({ attemptId: crypto.randomUUID(), occurredAt: new Date(asOf).toISOString() }))
    const accounts = await serviceFor(authority).query({ type: "usage.accounts", scope: { kind: "defaults" }, asOf })
    expect(accounts.sources.find((source) => source.kind === "metered")?.activity).toMatchObject({
      state: "available", startMs: new Date(2025, 1, 1).getTime(), endMs: asOf, attempts: 1,
    })
    authority.dispose()
  })

  test("recaptures sources before settling a missing reset target as stale", async () => {
    const root = mkdtempSync(join(tmpdir(), "usage-reset-recapture-")); roots.push(root)
    const authority = createUsageAuthority({ profileDir: root, profileId: "default" })
    const base = usageService(authority)
    const initial = base.generation()
    if (initial === undefined) throw new Error("Usage generation missing")
    const recaptured = { ...initial, generation: 2, identity: "generation:default:2", accounts: [...initial.accounts, { providerId: "chatgpt", instanceId: "account-b", identity: "subject-b", label: "New Account" }] }
    let active = initial; let checks = 0
    const usage: SubscriptionUsageService = {
      ...base,
      generation: () => active,
      refresh: async () => { active = recaptured; return recaptured },
      check: async () => { checks += 1; return undefined },
    }
    const service = serviceFor(authority, () => {}, false, usage)

    await expect(service.dispatch({ type: "usage.apply_reset", scope: { kind: "defaults" }, sourceId: "missing", authorityIncarnation: authority.incarnation(), revision: authority.revision(), redeemRequestId: "request" })).resolves.toEqual({ kind: "stale" })
    expect(checks).toBe(1)
    expect((await service.query({ type: "usage.accounts", scope: { kind: "defaults" } })).sources.map((source) => source.label)).toContain("New Account")
    authority.dispose()
  })

  test("rejects unsafe usage protocol integers and invalid quota windows", () => {
    const decode = Schema.decodeUnknownSync(UsageAccountsResultSchema, { onExcessProperty: "error" })
    const result = {
      kind: "usage.accounts", profileId: "default", authorityIncarnation: "authority", revision: 1, generation: 1, asOf: 1,
      sources: [{ kind: "subscription", sourceId: "chatgpt:a", providerId: "chatgpt", label: "Personal", active: true, activity: { state: "ledger-unavailable" }, observation: { state: "pending" }, quotaAccounting: { state: "available", windows: [{ state: "available", metricKey: "window", startMs: 1, endMs: 2, trackingStartMs: 1, partial: false, attempts: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 }, includedValueUsd: 0, priceUnavailable: false }] } }],
    }
    expect(() => decode({ ...result, asOf: Number.MAX_SAFE_INTEGER + 1 })).toThrow()
    expect(() => decode({ ...result, revision: Number.MAX_SAFE_INTEGER + 1 })).toThrow()
    for (const [startMs, endMs] of [[1, Number.MAX_SAFE_INTEGER + 1], [1, 1], [2, 1]]) {
      expect(() => decode({ ...result, sources: [{ ...result.sources[0], quotaAccounting: { state: "available", windows: [{ ...result.sources[0]!.quotaAccounting.windows[0], startMs, endMs }] } }] })).toThrow()
    }
  })

  test("strict wire operations reject a caller-supplied profile id", () => {
    const queryRpc = RuntimeProtocolRpc.requests.get("RuntimeQuery")
    if (!queryRpc) throw new Error("RuntimeQuery RPC is missing")
    expect(Schema.decodeUnknownSync(queryRpc.payloadSchema)({ type: "usage.spend", scope: { kind: "defaults" } })).toEqual({ type: "usage.spend", scope: { kind: "defaults" } })
    expect(() => Schema.decodeUnknownSync(queryRpc.payloadSchema)({ type: "usage.spend", scope: { kind: "defaults" }, profileId: "other" }, { onExcessProperty: "error" })).toThrow()
  })

  test("projects every available reset in expiry order without provider identifiers on the strict wire", () => {
    const value = projectUsageAccounts({
      current: { profileId: "default", authorityIncarnation: "authority", revision: 1, generation: 1, asOf: 1, accounts: [{
        state: "supported", providerId: "chatgpt", instanceId: "account", identity: "me@example.com",
        providerStatus: "ok", observedAtMs: 1, readerGeneration: 1, metrics: [], spendSources: [], crossedThresholds: [],
        resetCredits: { availableCount: 2, credits: [
          { id: "later", resetType: CHATGPT_RATE_LIMIT_RESET_TYPE, status: "available", expiresAtMs: null, title: "Reset" },
          { id: "spent", resetType: CHATGPT_RATE_LIMIT_RESET_TYPE, status: "redeemed", expiresAtMs: 1 },
          { id: "first", resetType: CHATGPT_RATE_LIMIT_RESET_TYPE, status: "available", expiresAtMs: 2, title: "Reset" },
        ] },
      }] },
      metered: [], providerDisplayName: () => "Personal", metricDetail: () => false, quotaBySource: new Map(), allowanceCaps: new Map(), activity: undefined,
    })
    const projected = value.sources[0]
    if (projected?.kind !== "subscription") throw new Error("Expected subscription")
    expect(projected.bankedResets).toEqual({ availableCount: 2, credits: [{ expiresAtMs: 2, title: "Reset" }, { expiresAtMs: null, title: "Reset" }] })
    expect(Schema.decodeUnknownSync(UsageAccountsResultSchema, { onExcessProperty: "error" })(value)).toEqual(value)
    expect(() => Schema.decodeUnknownSync(UsageAccountsResultSchema, { onExcessProperty: "error" })({ ...value, sources: [{ ...projected, bankedResets: { ...projected.bankedResets, credits: [{ expiresAtMs: 2, id: "raw" }] } }] })).toThrow()
  })

  test("a metered key's balance reading joins its metered row and never appears as a subscription", () => {
    const lineage = "00000000-0000-4000-8000-000000000020"
    const balance = { kind: "prepaid" as const, availability: "funded" as const, remaining: { kind: "money" as const, value: 20, currency: "USD", provenance: "provider" as const, precision: "exact" as const } }
    const metered = [
      { kind: "metered" as const, sourceId: lineage, providerId: "deepseek", label: "DeepSeek", spendMode: "direct_api" as const, identity: "••••1234" },
      { kind: "metered" as const, sourceId: "00000000-0000-4000-8000-000000000021", providerId: "openai_api", label: "OpenAI", spendMode: "direct_api" as const },
    ]
    const value = projectUsageAccounts({
      current: { profileId: "default", authorityIncarnation: "authority", revision: 1, generation: 1, asOf: 1, accounts: [{
        state: "supported", providerId: "deepseek", instanceId: lineage, identity: "••••1234",
        providerStatus: "ok", observedAtMs: 1, readerGeneration: 1, metrics: [], spendSources: [balance], crossedThresholds: [],
      }] },
      metered, providerDisplayName: () => "DeepSeek", metricDetail: () => false, quotaBySource: new Map(), allowanceCaps: new Map(), activity: undefined,
    })

    expect(value.sources.map((source) => [source.kind, source.providerId])).toEqual([["metered", "deepseek"], ["metered", "openai_api"]])
    expect(value.sources[0]).toMatchObject({ observation: { state: "supported", providerStatus: "ok", spendSources: [balance] } })
    expect(value.sources[1]).not.toHaveProperty("observation")
    const decode = Schema.decodeUnknownSync(UsageAccountsResultSchema, { onExcessProperty: "error" })
    expect(decode(value)).toEqual(value)
  })
})

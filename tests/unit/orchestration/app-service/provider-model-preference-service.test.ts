import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ProviderModelViewSchema } from "../../../../src/protocol/provider-model-preference-protocol-schemas.js"
import { accessProviderAccountKey } from "../../../../src/infra/llm/access-provider.js"
import { createProviderModelPreferenceService } from "../../../../src/orchestration/app-service/provider-model-preference-service.js"
import type { ResolvedProviderModels } from "../../../../src/infra/llm/provider-model-preferences.js"
import type { ProviderModelInventoryCandidate, ProviderModelPreferenceServiceDeps } from "../../../../src/orchestration/app-service/provider-model-preference-service.js"
import { subscriptionSpendAccountCorrelationId } from "../../../../src/protocol/subscription-spend-consent-protocol-types.js"

function catalog(effective = new Set(["gpt-5"])): ReadonlyMap<string, ResolvedProviderModels> {
  return new Map([["openai_api", {
    catalog: new Set(["gpt-5", "gpt-5-mini"]),
    curatedDefault: new Set(["gpt-5"]),
    enabled: new Set<string>(),
    disabled: new Set<string>(),
    effective,
  }]])
}

const SINGLETON_CANDIDATE = { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" } as const
const standardOffering = (wireModelId: string) => [{ wireModelId, metadata: null, dataUse: "standard" as const }]
const DEFAULT_CANDIDATE_CATALOGS: ReadonlyMap<string, ProviderModelInventoryCandidate> = new Map([[accessProviderAccountKey(SINGLETON_CANDIDATE), {
  candidate: SINGLETON_CANDIDATE,
  configured: true,
  currentConnection: true,
  enabledOfferings: new Map([["gpt-5", standardOffering("gpt-5")], ["gpt-5-mini", standardOffering("gpt-5-mini")]]),
  inventoryOfferings: new Map([["gpt-5", standardOffering("gpt-5")], ["gpt-5-mini", standardOffering("gpt-5-mini")]]),
  catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" },
}]])
const NO_DATES: ReadonlyMap<string, string> = new Map()
const INPUT_REVISIONS = { authRevision: "auth-revision", preferenceRevision: "preference-revision" }

const persistRevision = async (): Promise<string> => "preference-revision-next"
const trainingRoutesDisabled = (): boolean => false

function input(profileId: string, catalogs: ReadonlyMap<string, ResolvedProviderModels>, inventoryCandidates: ReadonlyMap<string, ProviderModelInventoryCandidate> = DEFAULT_CANDIDATE_CATALOGS, releaseDates: ReadonlyMap<string, string> = NO_DATES) {
  const accountCatalogs = new Map([...inventoryCandidates].flatMap(([key, candidate]) => {
    const models = catalogs.get(candidate.candidate.providerId)
    return models === undefined ? [] : [[key, models] as const]
  }))
  return { ...INPUT_REVISIONS, profileId, autoEnableNewModels: true, catalogs, accountCatalogs, inventoryCandidates, releaseDates }
}

describe("provider-model preference service", () => {
  test("edits and persists fallback preferences for an auth-rejected exact account without making it eligible", async () => {
    const persisted: string[] = []
    const service = createProviderModelPreferenceService({
      displayName: (id) => id,
      allowTrainingRoutes: () => false,
      persist: async ({ modelId, checked }) => { persisted.push(`${modelId}:${checked}`); return "next" },
      persistAllDeselected: async ({ modelIds }) => { persisted.push(`all:${modelIds.join(",")}`); return "next-all" },
    })
    const account = { kind: "subscription", providerId: "github_copilot", instanceId: "rejected", spendMode: "included" } as const
    const models: ResolvedProviderModels = { catalog: new Set(["gpt-5"]), curatedDefault: new Set(["gpt-5"]), enabled: new Set(), disabled: new Set(), effective: new Set(["gpt-5"]) }
    const state = service.prepare(input("work", new Map([["github_copilot", models]]), new Map([
      [accessProviderAccountKey(account), {
        candidate: account,
        configured: true,
        currentConnection: false,
        enabledOfferings: null,
        inventoryOfferings: new Map([["gpt-5", standardOffering("gpt-5")]]),
        catalog: { kind: "unavailable", reason: "authentication-invalid" },
      }],
    ])))
    expect(state.picker.has("gpt-5")).toBe(false)
    service.publish(state)
    const target = { kind: "subscription", providerId: "github_copilot", accountCorrelationId: subscriptionSpendAccountCorrelationId("work", "github_copilot", "rejected") } as const

    const rejectedRequestReason = (current: NonNullable<ReturnType<typeof service.state>>) => current.worker.candidateModelUnavailableReason?.(account, "gpt-5")
    expect(rejectedRequestReason(state)).toContain("no current connection")

    expect((await service.query("work", target)).rows).toEqual([
      expect.objectContaining({ modelId: "gpt-5", checked: true, optInAvailable: true }),
    ])
    const unchecked = await service.set({ queriedProfileId: "work", queriedEligibilityRevision: state.revision, target, modelId: "gpt-5", checked: false })
    expect(unchecked).toEqual(expect.objectContaining({ row: expect.objectContaining({ modelId: "gpt-5", checked: false }) }))
    const afterSet = service.state("work")!
    const rechecked = await service.set({ queriedProfileId: "work", queriedEligibilityRevision: afterSet.revision, target, modelId: "gpt-5", checked: true })
    expect(rechecked).toEqual(expect.objectContaining({ row: expect.objectContaining({ modelId: "gpt-5", checked: true }) }))
    const afterRecheck = service.state("work")!
    expect(await service.deselectAll({ queriedProfileId: "work", queriedEligibilityRevision: afterRecheck.revision, target })).toEqual(expect.objectContaining({
      rows: [expect.objectContaining({ modelId: "gpt-5", checked: false })],
    }))

    const final = service.state("work")!
    expect(persisted).toEqual(["gpt-5:false", "gpt-5:true", "all:gpt-5"])
    expect(final.picker.has("gpt-5")).toBe(false)
    expect(final.enabledCandidates.get(accessProviderAccountKey(account))?.enabledOfferings).toBeNull()
    expect(final.worker.modelUnavailableReason("github_copilot", "gpt-5")).toBeDefined()
    expect(rejectedRequestReason(final)).toContain("no current connection")
    await service.dispose()
  })

  test("persists before replacing the immutable profile-bound membership", async () => {
    let releaseWrite: (() => void) | undefined
    const writeStarted = Promise.withResolvers<void>()
    const writes: string[] = []
    const publications: string[] = []
    const service = createProviderModelPreferenceService({
      displayName: (providerId) => providerId === "openai_api" ? "OpenAI" : providerId,
      allowTrainingRoutes: trainingRoutesDisabled,
      persist: async ({ profileId, account, expectedAuthRevision, expectedPreferenceRevision, modelId, checked }) => {
        writes.push(`${profileId}:${account.providerId}:${modelId}:${checked}:${expectedAuthRevision}:${expectedPreferenceRevision}`)
        writeStarted.resolve()
        await new Promise<void>((resolve) => { releaseWrite = resolve })
        return "preference-revision-next"
      },
      persistAllDeselected: persistRevision,
      publish: (state) => { publications.push(`${state.profileId}:${state.revision}`) },
    })
    service.publish(service.prepare(input("work", catalog())))

    const pending = service.set({ queriedProfileId: "work", queriedEligibilityRevision: 1, target: { kind: "singleton", providerId: "openai_api" }, modelId: "gpt-5", checked: false })
    await writeStarted.promise
    expect((await service.query("work", { kind: "singleton", providerId: "openai_api" })).rows[0]?.checked).toBe(true)
    expect(publications).toEqual(["work:1"])

    releaseWrite?.()
    expect(await pending).toEqual(expect.objectContaining({
      profileId: "work",
      eligibilityRevision: 2,
      target: { kind: "singleton", providerId: "openai_api" },
      row: expect.objectContaining({ modelId: "gpt-5", checked: false, optInAvailable: true, configured: true }),
    }))
    expect(writes).toEqual(["work:openai_api:gpt-5:false:auth-revision:preference-revision"])
    expect(publications).toEqual(["work:1", "work:2"])
  })

  test("publishes and mutates free routes only for the exact OpenRouter account", async () => {
    const candidate = { kind: "singleton", providerId: "openrouter", spendMode: "aggregator" } as const
    const accountKey = accessProviderAccountKey(candidate)
    const models: ResolvedProviderModels = {
      catalog: new Set(["model"]),
      curatedDefault: new Set(["model"]),
      enabled: new Set(),
      disabled: new Set(),
      effective: new Set(["model"]),
    }
    const paid = { wireModelId: "vendor/model", metadata: null, dataUse: "standard" as const }
    const free = { wireModelId: "vendor/model:free", metadata: null, dataUse: "standard" as const, routeKind: "free" as const }
    const writes: boolean[] = []
    const service = createProviderModelPreferenceService({
      displayName: (id) => id,
      allowTrainingRoutes: trainingRoutesDisabled,
      persist: persistRevision,
      persistAllDeselected: persistRevision,
      persistFreeRoutes: async ({ account, enabled }) => {
        expect(accessProviderAccountKey(account)).toBe(accountKey)
        writes.push(enabled)
        return "preference-revision-next"
      },
    })
    service.publish(service.prepare(input("work", new Map([["openrouter", models]]), new Map([[accountKey, {
      candidate,
      configured: true,
      currentConnection: true,
      enabledOfferings: new Map([["model", [paid]]]),
      inventoryOfferings: new Map([["model", [paid, free]]]),
      preferFreeRoutes: false,
      catalog: { kind: "available", provenance: "models-dev-bundled", liveOutcome: "valid" },
    }]]))))

    const target = { kind: "singleton", providerId: "openrouter" } as const
    expect((await service.query("work", target)).freeRoutes).toEqual({ enabled: false })
    const result = await service.setFreeRoutes({ queriedProfileId: "work", queriedEligibilityRevision: 1, target, enabled: true })
    if ("hidden" in result) throw new Error("OpenRouter target unexpectedly disappeared")
    expect(result.freeRoutes).toEqual({ enabled: true })
    expect(service.state("work")?.worker.candidateOfferings?.(candidate, "model", false).map(({ wireModelId }) => wireModelId)).toEqual(["vendor/model:free", "vendor/model"])
    expect(writes).toEqual([true])
    await service.dispose()
  })

  test("changes the exact account new-model policy without changing current checks", async () => {
    const writes: Array<{ enabled: boolean; effective: readonly string[]; catalog: readonly string[] }> = []
    const service = createProviderModelPreferenceService({
      displayName: (id) => id,
      allowTrainingRoutes: trainingRoutesDisabled,
      persist: persistRevision,
      persistAllDeselected: persistRevision,
      persistAutoEnableNewModels: async ({ enabled, accountCatalogs }) => {
        const snapshot = accountCatalogs.values().next().value
        if (snapshot) writes.push({ enabled, effective: snapshot.effectiveModelIds, catalog: snapshot.catalogModelIds })
        return "preference-revision-next"
      },
    })
    const models = new Map([["openai_api", {
      catalog: new Set(["gpt-5", "gpt-5-mini"]),
      curatedDefault: new Set(["gpt-5", "gpt-5-mini"]),
      enabled: new Set<string>(),
      disabled: new Set(["gpt-5-mini"]),
      effective: new Set(["gpt-5"]),
    }]])
    service.publish(service.prepare(input("work", models)))
    const target = { kind: "singleton", providerId: "openai_api" } as const

    const result = await service.setAutoEnableNewModels({ queriedProfileId: "work", queriedEligibilityRevision: 1, enabled: false })

    expect(result.autoEnableNewModels).toBe(false)
    expect((await service.query("work", target)).rows.map(({ modelId, checked }) => [modelId, checked])).toEqual([["gpt-5", true], ["gpt-5-mini", false]])
    expect(writes).toEqual([{ enabled: false, effective: ["gpt-5"], catalog: ["gpt-5", "gpt-5-mini"] }])
    expect([...service.state("work")?.picker.keys() ?? []]).toEqual(["gpt-5"])
    await service.dispose()
  })

  test("reports success after a concurrent eligibility publication follows durable persistence", async () => {
    const writeStarted = Promise.withResolvers<void>()
    const releaseWrite = Promise.withResolvers<void>()
    const service = createProviderModelPreferenceService({
      displayName: (id) => id,
      allowTrainingRoutes: trainingRoutesDisabled,
      persist: async () => {
        writeStarted.resolve()
        await releaseWrite.promise
        return "preference-revision-next"
      },
      persistAllDeselected: persistRevision,
    })
    service.publish(service.prepare(input("work", catalog())))
    const pending = service.set({ queriedProfileId: "work", queriedEligibilityRevision: 1, target: { kind: "singleton", providerId: "openai_api" }, modelId: "gpt-5", checked: false })
    await writeStarted.promise
    service.publish(service.prepare(input("work", catalog())))
    releaseWrite.resolve()

    expect(await pending).toMatchObject({ profileId: "work", eligibilityRevision: 3, row: { modelId: "gpt-5", checked: false } })
    await service.dispose()
  })

  test("reports a committed mutation as hidden when a concurrent refresh removes its account", async () => {
    const writeStarted = Promise.withResolvers<void>()
    const releaseWrite = Promise.withResolvers<void>()
    const service = createProviderModelPreferenceService({
      displayName: (id) => id,
      allowTrainingRoutes: trainingRoutesDisabled,
      persist: async () => {
        writeStarted.resolve()
        await releaseWrite.promise
        return "preference-revision-next"
      },
      persistAllDeselected: persistRevision,
    })
    service.publish(service.prepare(input("work", catalog())))
    const pending = service.set({ queriedProfileId: "work", queriedEligibilityRevision: 1, target: { kind: "singleton", providerId: "openai_api" }, modelId: "gpt-5", checked: false })
    await writeStarted.promise
    service.publish(service.prepare(input("work", new Map(), new Map())))
    releaseWrite.resolve()

    expect(await pending).toEqual({ profileId: "work", eligibilityRevision: 3, target: { kind: "singleton", providerId: "openai_api" }, hidden: true })
    await service.dispose()
  })

  test("rejects stale identity and revision before persistence", async () => {
    let writes = 0
    const service = createProviderModelPreferenceService({
      displayName: (id) => id,
      allowTrainingRoutes: trainingRoutesDisabled,
      persist: async () => { writes += 1; return "preference-revision-next" },
      persistAllDeselected: async () => { writes += 1; return "preference-revision-next" },
      publish: () => {},
    })
    service.publish(service.prepare(input("profile-b", catalog())))

    await expect(service.set({ queriedProfileId: "profile-a", queriedEligibilityRevision: 1, target: { kind: "singleton", providerId: "openai_api" }, modelId: "gpt-5", checked: false })).rejects.toThrow("stale")
    await expect(service.set({ queriedProfileId: "profile-b", queriedEligibilityRevision: 0, target: { kind: "singleton", providerId: "openai_api" }, modelId: "gpt-5", checked: false })).rejects.toThrow("stale")
    expect(writes).toBe(0)
  })

  test("precomputes membership and refuses publication from an older preparation", async () => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: trainingRoutesDisabled, persist: persistRevision, persistAllDeselected: persistRevision, publish: () => {} })
    const old = service.prepare(input("work", catalog()))
    const current = service.prepare(input("work", catalog(new Set(["gpt-5-mini"]))))
    service.publish(current)
    service.publish(old)

    expect((await service.query("work", { kind: "singleton", providerId: "openai_api" })).eligibilityRevision).toBe(2)
    expect((await service.query("work", { kind: "singleton", providerId: "openai_api" })).rows.map((row) => row.checked)).toEqual([false, true])
  })

  test("removes the live delta when a model returns to its curated default", async () => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: trainingRoutesDisabled, persist: persistRevision, persistAllDeselected: persistRevision, publish: () => {} })
    service.publish(service.prepare(input("work", catalog())))

    await service.set({ queriedProfileId: "work", queriedEligibilityRevision: 1, target: { kind: "singleton", providerId: "openai_api" }, modelId: "gpt-5", checked: false })
    expect(service.state()?.catalogs.get("openai_api")?.disabled).toEqual(new Set())

    await service.set({ queriedProfileId: "work", queriedEligibilityRevision: 2, target: { kind: "singleton", providerId: "openai_api" }, modelId: "gpt-5", checked: true })
    expect(service.state()?.catalogs.get("openai_api")?.disabled).toEqual(new Set())
    expect((await service.query("work", { kind: "singleton", providerId: "openai_api" })).rows[0]?.checked).toBe(true)
  })

  test("recomputes picker eligibility after enabling a catalog model", async () => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: trainingRoutesDisabled, persist: persistRevision, persistAllDeselected: persistRevision, publish: () => {} })
    const candidate = { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" } as const
    const catalogs = catalog()
    const candidateCatalogs = new Map([[accessProviderAccountKey(candidate), {
      candidate,
      configured: true,
      currentConnection: true,
      enabledOfferings: new Map([["gpt-5", standardOffering("gpt-5")]]),
      inventoryOfferings: new Map([["gpt-5", standardOffering("gpt-5")], ["gpt-5-mini", standardOffering("gpt-5-mini")]]),
      catalog: { kind: "available", provenance: "static", liveOutcome: "valid" } as const,
    }]])
    service.publish(service.prepare(input("work", catalogs, candidateCatalogs)))
    expect(service.state()?.picker.has("gpt-5-mini")).toBe(false)
    expect(service.state()?.enabledCandidates.get(accessProviderAccountKey(candidate))?.enabledOfferings?.has("gpt-5-mini")).toBe(false)
    expect(service.state()?.worker.candidateOffering?.(candidate, "gpt-5-mini", false)).toBeUndefined()
    expect((await service.query("work", { kind: "singleton", providerId: "openai_api" })).rows.find((row) => row.modelId === "gpt-5-mini")).toMatchObject({
      checked: false,
      optInAvailable: true,
      configured: true,
    })
    expect((await service.query("work", { kind: "singleton", providerId: "openai_api" })).catalog).toEqual({ kind: "available", provenance: "static", liveOutcome: "valid" })

    await service.set({ queriedProfileId: "work", queriedEligibilityRevision: 1, target: { kind: "singleton", providerId: "openai_api" }, modelId: "gpt-5-mini", checked: true })

    expect(service.state()?.picker?.get("gpt-5-mini")?.explicitlyEnabled).toBe(true)
    expect(service.state()?.worker.candidateOffering?.(candidate, "gpt-5-mini", false)?.wireModelId).toBe("gpt-5-mini")

    await service.set({ queriedProfileId: "work", queriedEligibilityRevision: 2, target: { kind: "singleton", providerId: "openai_api" }, modelId: "gpt-5-mini", checked: false })

    expect(service.state()?.picker.has("gpt-5-mini")).toBe(false)
    expect(service.state()?.worker.candidateOffering?.(candidate, "gpt-5-mini", false)).toBeUndefined()
  })

  test("deselects the complete exact-account catalog in one persistence call", async () => {
    const persisted: string[][] = []
    const candidate = { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" } as const
    const candidateCatalogs = new Map([[accessProviderAccountKey(candidate), {
      candidate,
      configured: true,
      currentConnection: true,
      enabledOfferings: new Map([["gpt-5", standardOffering("gpt-5")]]),
      inventoryOfferings: new Map([["gpt-5", standardOffering("gpt-5")], ["gpt-5-mini", standardOffering("gpt-5-mini")]]),
      catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" } as const,
    }]])
    const service = createProviderModelPreferenceService({
      displayName: (id) => id,
      allowTrainingRoutes: trainingRoutesDisabled,
      persist: persistRevision,
      persistAllDeselected: async ({ modelIds }) => { persisted.push([...modelIds]); return "preference-revision-next" },
      publish: () => {},
    })
    service.publish(service.prepare(input("work", catalog(), candidateCatalogs)))

    const view = await service.deselectAll({ queriedProfileId: "work", queriedEligibilityRevision: 1, target: { kind: "singleton", providerId: "openai_api" } })
    if ("hidden" in view) throw new Error("OpenAI target unexpectedly disappeared")

    expect(persisted).toEqual([["gpt-5", "gpt-5-mini"]])
    expect(view.rows.every((row) => !row.checked)).toBe(true)
    expect(service.state()?.picker.size).toBe(0)
  })

  test("rebuilds provider membership from the newly enabled exact-account offering", async () => {
    const candidate = { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" } as const
    const inventoryCandidates = new Map([[accessProviderAccountKey(candidate), {
      candidate,
      configured: true,
      currentConnection: true,
      enabledOfferings: new Map([["gpt-5", standardOffering("gpt-5")]]),
      inventoryOfferings: new Map([["gpt-5", standardOffering("gpt-5")], ["gpt-5-mini", standardOffering("gpt-5-mini")]]),
      catalog: { kind: "available", provenance: "static", liveOutcome: "valid" } as const,
    }]])
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: trainingRoutesDisabled, persist: persistRevision, persistAllDeselected: persistRevision })
    service.publish(service.prepare(input("work", catalog(), inventoryCandidates)))

    await service.deselectAll({ queriedProfileId: "work", queriedEligibilityRevision: 1, target: { kind: "singleton", providerId: "openai_api" } })
    await service.set({ queriedProfileId: "work", queriedEligibilityRevision: 2, target: { kind: "singleton", providerId: "openai_api" }, modelId: "gpt-5-mini", checked: true })

    const state = service.state()
    expect(state?.catalogs.get("openai_api")?.effective).toEqual(new Set(["gpt-5-mini"]))
    expect([...state?.picker.keys() ?? []]).toEqual(["gpt-5-mini"])
    expect(state?.worker.candidateOffering?.(candidate, "gpt-5", false)).toBeUndefined()
    expect(state?.worker.candidateOffering?.(candidate, "gpt-5-mini", false)?.wireModelId).toBe("gpt-5-mini")
  })

  test("deselects and restores only canonical provider models", async () => {
    const candidate = { kind: "singleton", providerId: "openrouter", spendMode: "aggregator" } as const
    const eligibleOfferings = new Map([["gpt-6.1-sol", standardOffering("openai/gpt-6.1-sol")]])
    const inventoryOfferings = eligibleOfferings
    const models: ResolvedProviderModels = {
      catalog: new Set(inventoryOfferings.keys()),
      curatedDefault: new Set(inventoryOfferings.keys()),
      enabled: new Set(),
      disabled: new Set(),
      effective: new Set(inventoryOfferings.keys()),
    }
    const candidates = new Map([[accessProviderAccountKey(candidate), {
      candidate,
      configured: true,
      currentConnection: true,
      enabledOfferings: eligibleOfferings,
      inventoryOfferings,
      catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" } as const,
    }]])
    const service = createProviderModelPreferenceService({
      displayName: (id) => id,
      allowTrainingRoutes: trainingRoutesDisabled,
      persist: persistRevision,
      persistAllDeselected: persistRevision,
    })
    service.publish(service.prepare(input("work", new Map([["openrouter", models]]), candidates)))

    expect([...service.state()?.picker.keys() ?? []]).toEqual(["gpt-6.1-sol"])
    expect((await service.query("work", { kind: "singleton", providerId: "openrouter" })).rows.map((row) => row.modelId)).toEqual(["gpt-6.1-sol"])

    await service.deselectAll({ queriedProfileId: "work", queriedEligibilityRevision: 1, target: { kind: "singleton", providerId: "openrouter" } })
    expect(service.state()?.picker.size).toBe(0)

    await service.set({ queriedProfileId: "work", queriedEligibilityRevision: 2, target: { kind: "singleton", providerId: "openrouter" }, modelId: "gpt-6.1-sol", checked: true })

    expect([...service.state()?.picker.keys() ?? []]).toEqual(["gpt-6.1-sol"])
    expect(service.state()?.worker.candidateOffering?.(candidate, "gpt-6.1-sol", false)?.wireModelId).toBe("openai/gpt-6.1-sol")
    expect(service.state()?.catalogs.get("openrouter")?.effective).toEqual(new Set(["gpt-6.1-sol"]))
    expect(service.state()?.catalogs.get("openrouter")?.curatedDefault).toEqual(new Set(["gpt-6.1-sol"]))
    await service.dispose()
  })

  test("exposes exact opaque subscription targets and rejects foreign targets before persistence", async () => {
    const writes: string[] = []
    const service = createProviderModelPreferenceService({
      displayName: (id) => id,
      allowTrainingRoutes: trainingRoutesDisabled,
      persist: async ({ account }) => { writes.push(account.kind === "subscription" ? account.instanceId : account.providerId); return "preference-revision-next" },
      persistAllDeselected: persistRevision,
      publish: () => {},
    })
    const candidateA = { kind: "subscription", providerId: "chatgpt", instanceId: "secret-a", spendMode: "included" } as const
    const candidateB = { kind: "subscription", providerId: "chatgpt", instanceId: "secret-b", spendMode: "included" } as const
    const candidates = new Map([
      [accessProviderAccountKey(candidateA), { candidate: candidateA, configured: true, currentConnection: true, enabledOfferings: new Map([["gpt-5", standardOffering("gpt-5")]]), inventoryOfferings: new Map([["gpt-5", standardOffering("gpt-5")]]), catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" } as const }],
      [accessProviderAccountKey(candidateB), { candidate: candidateB, configured: true, currentConnection: true, enabledOfferings: new Map([["gpt-5-mini", standardOffering("gpt-5-mini")]]), inventoryOfferings: new Map([["gpt-5-mini", standardOffering("gpt-5-mini")]]), catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" } as const }],
    ])
    const targetA = { kind: "subscription", providerId: "chatgpt", accountCorrelationId: subscriptionSpendAccountCorrelationId("work", "chatgpt", "secret-a") } as const
    const targetB = { kind: "subscription", providerId: "chatgpt", accountCorrelationId: subscriptionSpendAccountCorrelationId("work", "chatgpt", "secret-b") } as const
    service.publish(service.prepare(input("work", new Map([["chatgpt", { ...catalog().get("openai_api")! }]]), candidates)))

    expect((await service.query("work", targetA)).rows.map((row) => row.optInAvailable)).toEqual([true, false])
    expect((await service.query("work", targetB)).rows.map((row) => row.optInAvailable)).toEqual([false, true])
    expect(JSON.stringify(await service.query("work", targetA))).not.toContain("secret-a")
    await expect(service.set({ queriedProfileId: "work", queriedEligibilityRevision: 1, target: { ...targetA, accountCorrelationId: "foreign" }, modelId: "gpt-5", checked: false })).rejects.toThrow("target")
    expect(writes).toEqual([])
  })

  test("orders rows by release date descending, undated last, ties alphabetical", async () => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: trainingRoutesDisabled, persist: persistRevision, persistAllDeselected: persistRevision, publish: () => {} })
    const models: ResolvedProviderModels = {
      catalog: new Set(["gpt-4.1", "gpt-5", "gpt-5-mini", "gpt-3.5-turbo", "babbage-002"]),
      curatedDefault: new Set(["gpt-5"]),
      enabled: new Set<string>(),
      disabled: new Set<string>(),
      effective: new Set(["gpt-5"]),
    }
    const releaseDates = new Map([
      ["gpt-4.1", "2025-04-14"],
      ["gpt-5", "2025-08-07"],
      ["gpt-5-mini", "2025-08-07"],
      ["gpt-3.5-turbo", "2023-03-01"],
    ])
    service.publish(service.prepare(input("work", new Map([["openai_api", models]]), DEFAULT_CANDIDATE_CATALOGS, releaseDates)))

    expect((await service.query("work", { kind: "singleton", providerId: "openai_api" })).rows.map((row) => row.modelId)).toEqual([
      "gpt-5",
      "gpt-5-mini",
      "gpt-4.1",
      "gpt-3.5-turbo",
      "babbage-002",
    ])
  })

  test("groups contributor routes under one canonical selectable membership row", async () => {
    let allowTrainingRoutes = false
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => allowTrainingRoutes, persist: persistRevision, persistAllDeselected: persistRevision, publish: () => {} })
    const candidate = { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" } as const
    const contributor = { wireModelId: "gpt-5-contributor", metadata: null, dataUse: "contributor" as const }
    const candidateCatalogs = new Map([[accessProviderAccountKey(candidate), {
      candidate,
      configured: true,
      currentConnection: true,
      enabledOfferings: new Map([["gpt-5", [contributor]]]),
      inventoryOfferings: new Map([["gpt-5", [contributor]]]),
      catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" } as const,
    }]])
    service.publish(service.prepare(input("work", catalog(), candidateCatalogs)))

    const view = await service.query("work", { kind: "singleton", providerId: "openai_api" })
    expect(view.rows.filter((row) => row.modelId === "gpt-5")).toEqual([{
      modelId: "gpt-5",
      checked: true,
      optInAvailable: true,
      configured: true,
      unavailableReason: "Allow training routes",
    }])
    allowTrainingRoutes = true
    expect((await service.query("work", { kind: "singleton", providerId: "openai_api" })).rows[0]?.unavailableReason).toBeUndefined()
  })
  test("allocates one monotonic revision sequence across toggles and refreshes", async () => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: trainingRoutesDisabled, persist: persistRevision, persistAllDeselected: persistRevision, publish: () => {} })
    const initial = service.prepare(input("work", catalog()))
    service.publish(initial)
    const toggled = await service.set({ queriedProfileId: "work", queriedEligibilityRevision: initial.revision, target: { kind: "singleton", providerId: "openai_api" }, modelId: "gpt-5", checked: false })
    const refreshed = service.prepare(input("work", catalog()))

    expect(refreshed.revision).toBeGreaterThan(toggled.eligibilityRevision)
  })

  test("keeps the latest immutable snapshot for each profile", async () => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: trainingRoutesDisabled, persist: persistRevision, persistAllDeselected: persistRevision, publish: () => {} });
    const work = service.prepare(input("work", catalog()));
    const personal = service.prepare(input("personal", catalog(new Set(["gpt-5-mini"]))));
    service.publish(work);
    service.publish(personal);

    expect((await service.query("work", { kind: "singleton", providerId: "openai_api" })).rows[0]?.checked).toBe(true);
    expect((await service.query("personal", { kind: "singleton", providerId: "openai_api" })).rows[0]?.checked).toBe(false);
    expect(service.state()?.profileId).toBe("personal");
  });

  test("isolates same-model account toggles and accepts the returned revision", async () => {
    const accountA = { kind: "subscription", providerId: "chatgpt", instanceId: "a", spendMode: "included" } as const
    const accountB = { kind: "subscription", providerId: "chatgpt", instanceId: "b", spendMode: "included" } as const
    const models = { ...catalog().get("openai_api")! }
    const candidates = new Map([accountA, accountB].map((candidate) => [accessProviderAccountKey(candidate), { candidate, configured: true, currentConnection: true, enabledOfferings: new Map([["gpt-5", standardOffering("gpt-5")]]), inventoryOfferings: new Map([["gpt-5", standardOffering("gpt-5")], ["gpt-5-mini", standardOffering("gpt-5-mini")]]), catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" } as const }]))
    let revision = 0
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: trainingRoutesDisabled, persist: async () => `preference-${++revision}`, persistAllDeselected: async () => `preference-${++revision}` })
    service.publish(service.prepare({ ...INPUT_REVISIONS, profileId: "work", catalogs: new Map([["chatgpt", models]]), accountCatalogs: new Map([[accessProviderAccountKey(accountA), models], [accessProviderAccountKey(accountB), models]]), inventoryCandidates: candidates, releaseDates: NO_DATES }))
    const targetA = { kind: "subscription", providerId: "chatgpt", accountCorrelationId: subscriptionSpendAccountCorrelationId("work", "chatgpt", "a") } as const
    const targetB = { kind: "subscription", providerId: "chatgpt", accountCorrelationId: subscriptionSpendAccountCorrelationId("work", "chatgpt", "b") } as const
    const first = await service.set({ queriedProfileId: "work", queriedEligibilityRevision: 1, target: targetA, modelId: "gpt-5", checked: false })
    expect((await service.query("work", targetB)).rows.find((row) => row.modelId === "gpt-5")?.checked).toBe(true)
    expect(service.state()?.worker.candidateModelUnavailableReason?.(accountB, "gpt-5")).toBeUndefined()
    const second = await service.set({ queriedProfileId: "work", queriedEligibilityRevision: first.eligibilityRevision, target: targetA, modelId: "gpt-5", checked: true })
    expect(second.eligibilityRevision).toBeGreaterThan(first.eligibilityRevision)
  })

  test("queues a recheck for one audited account against the current revision without changing preferences or the published view", async () => {
    const audited = { kind: "subscription", providerId: "supergrok", instanceId: "a", spendMode: "included" } as const
    const unaudited = { kind: "subscription", providerId: "chatgpt", instanceId: "b", spendMode: "included" } as const
    const models = { ...catalog().get("openai_api")! }
    const candidates = new Map([audited, unaudited].map((candidate) => [accessProviderAccountKey(candidate), {
      candidate, configured: true, currentConnection: true,
      enabledOfferings: new Map([["gpt-5", standardOffering("gpt-5")]]),
      inventoryOfferings: new Map([["gpt-5", standardOffering("gpt-5")]]),
      catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" } as const,
      ...(candidate === audited ? { audit: { remaining: 0, refused: 1 } } : {}),
    }]))
    const requests: unknown[] = []
    const writes: string[] = []
    const build = (recheckAccount?: ProviderModelPreferenceServiceDeps["recheckAccount"]) => createProviderModelPreferenceService({
      displayName: (id) => id,
      allowTrainingRoutes: trainingRoutesDisabled,
      persist: async () => { writes.push("persist"); return "next" },
      persistAllDeselected: async () => { writes.push("deselect"); return "next" },
      ...(recheckAccount === undefined ? {} : { recheckAccount }),
    })
    const service = build((request) => { requests.push(request) })
    const state = service.prepare({ ...INPUT_REVISIONS, profileId: "work", catalogs: new Map([["supergrok", models], ["chatgpt", models]]), accountCatalogs: new Map([[accessProviderAccountKey(audited), models], [accessProviderAccountKey(unaudited), models]]), inventoryCandidates: candidates, releaseDates: NO_DATES })
    service.publish(state)
    const target = (providerId: string, instanceId: string) => ({ kind: "subscription", providerId, accountCorrelationId: subscriptionSpendAccountCorrelationId("work", providerId, instanceId) }) as const

    await expect(service.recheck({ queriedProfileId: "work", queriedEligibilityRevision: state.revision + 1, target: target("supergrok", "a") })).rejects.toThrow("stale")
    await expect(service.recheck({ queriedProfileId: "work", queriedEligibilityRevision: state.revision, target: target("chatgpt", "b") })).rejects.toThrow("unavailable")
    expect(requests).toEqual([])

    const view = await service.recheck({ queriedProfileId: "work", queriedEligibilityRevision: state.revision, target: target("supergrok", "a") })
    expect(view).toEqual(await service.query("work", target("supergrok", "a")))
    expect(view).toEqual(expect.objectContaining({ recheckAvailable: true, audit: { remaining: 0, refused: 1 }, rows: expect.arrayContaining([expect.objectContaining({ modelId: "gpt-5", accessState: "pending" })]) }))
    expect(view).toEqual(Schema.decodeUnknownSync(ProviderModelViewSchema)(view))
    expect(await service.query("work", target("chatgpt", "b"))).not.toHaveProperty("recheckAvailable")
    expect(requests).toEqual([{ profileId: "work", account: { kind: "subscription", providerId: "supergrok", instanceId: "a" }, expectedAuthRevision: "auth-revision", expectedPreferenceRevision: "preference-revision" }])
    expect(service.state("work")).toBe(state)
    expect(writes).toEqual([])

    const unwired = build()
    const unwiredState = unwired.prepare({ ...INPUT_REVISIONS, profileId: "work", catalogs: new Map([["supergrok", models]]), accountCatalogs: new Map([[accessProviderAccountKey(audited), models]]), inventoryCandidates: new Map([[accessProviderAccountKey(audited), candidates.get(accessProviderAccountKey(audited))!]]), releaseDates: NO_DATES })
    unwired.publish(unwiredState)
    await expect(unwired.recheck({ queriedProfileId: "work", queriedEligibilityRevision: unwiredState.revision, target: target("supergrok", "a") })).rejects.toThrow("unavailable")

    const clean = build((request) => { requests.push(request) })
    const cleanCandidate = { ...candidates.get(accessProviderAccountKey(audited))!, audit: { remaining: 0, refused: 0 }, verifiedModelIds: new Set(["gpt-5"]) }
    const cleanState = clean.prepare({ ...INPUT_REVISIONS, profileId: "work", catalogs: new Map([["supergrok", models]]), accountCatalogs: new Map([[accessProviderAccountKey(audited), models]]), inventoryCandidates: new Map([[accessProviderAccountKey(audited), cleanCandidate]]), releaseDates: NO_DATES })
    clean.publish(cleanState)
    expect(await clean.query("work", target("supergrok", "a"))).toEqual(expect.objectContaining({ recheckAvailable: true, rows: expect.arrayContaining([expect.objectContaining({ modelId: "gpt-5", accessState: "verified" })]) }))
  })
})

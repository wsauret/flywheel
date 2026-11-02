import { describe, expect, test } from "bun:test"
import { authDir } from "../../../../src/infra/paths.js"
import { createEligibilityPreparation } from "../../../../src/orchestration/app-service/eligibility-preparation.js"
import { createProviderModelPreferenceService } from "../../../../src/orchestration/app-service/provider-model-preference-service.js"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { accessProviderAccountKey } from "../../../../src/infra/llm/access-provider.js"
import type { CatalogModelOffering } from "../../../../src/infra/llm/model-catalog-resolution.js"
import type { ResolvedProviderModels } from "../../../../src/infra/llm/provider-model-preferences.js"
import type { ResolvedProviderModelCatalogs } from "../../../../src/orchestration/config/model-assignment-providers.js"
import { testDirectories } from "../../../helpers/directories.js"
import { modelInfo } from "../../../helpers/model-tier-fixtures.js"
import { testAuthContext } from "../../../helpers/auth-context.js"

const DIRECTORIES = testDirectories(process.cwd())
const PROFILE = { id: "work", directory: authDir(DIRECTORIES.userDataRoot, "work") }
describe("eligibility preparation", () => {
  test.each([false, true])("schedules warm discovery once per profile per five minutes, including failure=%s", async (fails) => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
    const other = { id: "personal", directory: authDir(DIRECTORIES.userDataRoot, "personal") }
    for (const profile of [PROFILE, other]) service.publish(service.prepare({
      profileId: profile.id, authRevision: "auth-v1", preferenceRevision: "preferences-v1",
      catalogs: new Map(), accountCatalogs: new Map(), inventoryCandidates: new Map(), releaseDates: new Map(),
    }))
    let now = 0
    const held = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    const calls: string[] = []
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot, resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]), prepare: service.prepare, publish: service.publish, current: service.state,
      inputRevision: () => ({ auth: "auth-v1", preferences: "preferences-v1" }),
      resolveAuth: async () => testAuthContext(), now: () => now,
      resolveCatalog: async ({ authDirectory }) => {
        calls.push(authDirectory())
        entered.resolve()
        await held.promise
        finished.resolve()
        if (fails) throw new Error("discovery unavailable")
        return { providers: new Map(), accounts: new Map(), inventoryCandidates: new Map(), modelInfos: new Map(), enabledModels: new Map() }
      },
    })
    const saved = service.state(PROFILE.id)
    if (saved === undefined) throw new Error("saved profile is missing")
    expect(prepare.scheduleRefresh(PROFILE)).toBeUndefined()
    await entered.promise
    prepare.scheduleRefresh(PROFILE)
    expect(await prepare(PROFILE)).toBe(saved)
    expect(calls).toHaveLength(1)
    prepare.scheduleRefresh(other)
    held.resolve()
    await finished.promise
    // Read capture crosses the same owner after discovery's publication and release.
    await prepare.capture(PROFILE, (state) => state)
    if (fails) expect(service.state(PROFILE.id)).toBe(saved)
    else expect(service.state(PROFILE.id)!.revision).toBeGreaterThan(saved!.revision)
    now = 299_999
    prepare.scheduleRefresh(PROFILE)
    expect(calls).toEqual([PROFILE.directory, other.directory])
    now = 300_000
    prepare.scheduleRefresh(PROFILE)
    await prepare.capture(PROFILE, (state) => state)
    expect(calls).toHaveLength(3)
    await prepare.dispose()
    expect(() => prepare.scheduleRefresh(PROFILE)).toThrow("disposed")
    await service.dispose()
  })

  test("uses explicit discovery modes while legacy force maps to refresh", async () => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
    const modes: string[] = []
    const candidate = { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" } as const
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]),
      prepare: service.prepare,
      publish: service.publish,
      current: service.state,
      inputRevision: () => ({ auth: "auth-v1", preferences: "preferences-v1" }),
      resolveAuth: async () => testAuthContext(),
      resolveCatalog: async ({ discoveryMode }) => {
        modes.push(discoveryMode ?? "missing")
        const models: ResolvedProviderModels = { catalog: new Set(), curatedDefault: new Set(), enabled: new Set(), disabled: new Set(), effective: new Set() }
        return {
          providers: new Map(),
          accounts: new Map([[accessProviderAccountKey(candidate), models]]),
          inventoryCandidates: new Map([[accessProviderAccountKey(candidate), {
            candidate,
            configured: false,
            currentConnection: true,
            enabledOfferings: new Map(),
            inventoryOfferings: new Map(),
            outcome: { kind: "catalog", provenance: discoveryMode === "fresh" ? "first-party" : "first-party-cached", liveOutcome: "valid", rows: [] },
          }]]),
          modelInfos: new Map(),
          enabledModels: new Map(),
        }
      },
    })

    await prepare(PROFILE)
    await prepare(PROFILE, { mode: "fresh" })
    await prepare(PROFILE, { force: true })

    expect(modes).toEqual(["cached-first", "refresh", "fresh", "refresh"])
    await prepare.dispose()
    await service.dispose()
  })

  test("refreshes initial saved catalogs once, but not after credential rotation", async () => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
    const events: string[] = []
    const refreshed = Promise.withResolvers<void>()
    let authRevision = "auth-v1"
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]),
      prepare: service.prepare,
      publish: service.publish,
      current: service.state,
      inputRevision: () => ({ auth: authRevision, preferences: "preferences-v1" }),
      resolveAuth: async () => testAuthContext(),
      refreshMetadata: async () => { events.push("metadata") },
      resolveCatalog: async ({ discoveryMode }) => {
        events.push(`providers:${discoveryMode}`)
        if (discoveryMode === "refresh") refreshed.resolve()
        return { providers: new Map(), accounts: new Map(), inventoryCandidates: new Map(), modelInfos: new Map(), enabledModels: new Map() }
      },
    })

    await prepare(PROFILE)
    await prepare.capture(PROFILE, (state) => state)
    expect(events).toContain("metadata")
    await refreshed.promise
    authRevision = "auth-v2"
    await prepare.capture(PROFILE, (state) => state)
    await prepare.dispose()

    expect(events).toEqual(["providers:cached-first", "metadata", "providers:refresh", "providers:cached-first"])
    await service.dispose()
  })

  test("preserves static custom and Vertex grouped offerings as eligibility authority", async () => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
    const custom = { kind: "singleton", providerId: "local_llama", spendMode: "direct_api" } as const
    const vertex = { kind: "singleton", providerId: "google_vertex", spendMode: "direct_api" } as const
    const customOfferings: ReadonlyMap<string, readonly CatalogModelOffering[]> = new Map([
      ["gpt-4o", [
        Object.freeze({ wireModelId: "gpt-4o", metadata: null, dataUse: "standard" as const }),
        Object.freeze({ wireModelId: "gpt-4o-contributor", metadata: null, dataUse: "contributor" as const }),
      ]],
      ["local", [Object.freeze({ wireModelId: "local-contributor", metadata: null, dataUse: "contributor" as const })]],
    ])
    const vertexOfferings: ReadonlyMap<string, readonly CatalogModelOffering[]> = new Map([["gemini-3.8-flash", [Object.freeze({ wireModelId: "gemini-3.8-flash", metadata: null, dataUse: "standard" })]]])
    const resolvedModels = (...models: string[]): ResolvedProviderModels => ({ catalog: new Set(models), curatedDefault: new Set(models), enabled: new Set(), disabled: new Set(), effective: new Set(models) })
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]),
      prepare: service.prepare,
      publish: service.publish,
      current: service.state,
      inputRevision: () => ({ auth: "auth-v1", preferences: "preferences-v1" }),
      resolveCatalog: async (): Promise<ResolvedProviderModelCatalogs> => ({
        providers: new Map([
          ["local_llama", resolvedModels("gpt-4o", "local")],
          ["google_vertex", resolvedModels("gemini-3.8-flash")],
        ]),
        accounts: new Map([
          [accessProviderAccountKey(custom), resolvedModels("gpt-4o", "local")],
          [accessProviderAccountKey(vertex), resolvedModels("gemini-3.8-flash")],
        ]),
        inventoryCandidates: new Map([
          [accessProviderAccountKey(custom), { candidate: custom, configured: true, currentConnection: true, enabledOfferings: customOfferings, inventoryOfferings: customOfferings }],
          [accessProviderAccountKey(vertex), { candidate: vertex, configured: true, currentConnection: true, enabledOfferings: vertexOfferings, inventoryOfferings: vertexOfferings }],
        ]),
        modelInfos: new Map(),
        enabledModels: new Map(),
      }),
    })

    const state = await prepare(PROFILE)

    const candidateOffering = state.worker.candidateOffering
    expect(candidateOffering).toBeDefined()
    if (!candidateOffering) throw new Error("candidate offering selector is unavailable")
    const enabledOffering = state.enabledCandidates.get(accessProviderAccountKey(custom))?.enabledOfferings?.get("gpt-4o")?.[0]
    const inventoryOffering = state.inventoryCandidates.get(accessProviderAccountKey(custom))?.inventoryOfferings?.get("gpt-4o")?.[0]
    const enabledCandidate = state.enabledCandidates.get(accessProviderAccountKey(custom))
    const selectedOffering = candidateOffering(custom, "gpt-4o", false)
    expect(enabledOffering).toBe(customOfferings.get("gpt-4o")?.[0])
    expect(inventoryOffering).toBe(enabledOffering)
    expect(enabledCandidate).not.toHaveProperty("inventoryOfferings")
    expect(selectedOffering?.candidate).toBe(state.enabledCandidates.get(accessProviderAccountKey(custom))?.candidate)
    expect(selectedOffering?.catalogMetadata).toBe(enabledOffering?.metadata)
    expect(Object.isFrozen(enabledOffering)).toBe(true)
    expect(candidateOffering(custom, "gpt-4o", false)?.wireModelId).toBe("gpt-4o")
    expect(candidateOffering(custom, "gpt-4o", true)?.wireModelId).toBe("gpt-4o")
    expect(candidateOffering(custom, "local", false)).toBeUndefined()
    expect(candidateOffering(custom, "local", true)?.wireModelId).toBe("local-contributor")
    expect(candidateOffering(vertex, "gemini-3.8-flash", false)?.wireModelId).toBe("gemini-3.8-flash")
    await service.dispose()
  })

  test("reuses eligibility only while profile inputs are unchanged", async () => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "preference-revision-next", persistAllDeselected: async () => "preference-revision-next" })
    let inputRevision = { auth: "auth-v1", preferences: "preferences-v1" }
    let replaceAuthDuringCapture = false
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]),
      prepare: service.prepare,
      publish: service.publish,
      current: service.state,
      inputRevision: () => inputRevision,
      resolveAuth: async () => {
        if (replaceAuthDuringCapture) {
          replaceAuthDuringCapture = false
          inputRevision = { ...inputRevision, auth: "auth-v3" }
        }
        return testAuthContext()
      },
    })

    const first = await prepare(PROFILE)
    const reused = await prepare(PROFILE)
    inputRevision = { auth: "auth-v2", preferences: "preferences-v1" }
    const refreshed = await prepare(PROFILE)

    expect(reused).toBe(first)
    expect(refreshed.revision).toBeGreaterThan(first.revision)
    expect(service.state("work")?.revision).toBe(refreshed.revision)
    replaceAuthDuringCapture = true
    const captured = await prepare.capture(PROFILE, (state) => state)
    expect(captured.authRevision).toBe("auth-v3")
    expect(captured.authRevision).toBe(service.state("work")!.authRevision)
    await prepare.dispose()
    await service.dispose()
  })

  test("reuses a canonically published snapshot after its preference revision changes", async () => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "preferences-v2", persistAllDeselected: async () => "preferences-v2" })
    let inputRevision = { auth: "auth-v1", preferences: "preferences-v1" }
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]),
      prepare: service.prepare,
      publish: service.publish,
      current: service.state,
      inputRevision: () => inputRevision,
    })

    const first = await prepare(PROFILE)
    inputRevision = { auth: "auth-v1", preferences: "preferences-v2" }
    const canonical = service.prepare({ ...first, preferenceRevision: inputRevision.preferences })
    service.publish(canonical)

    expect(await prepare(PROFILE)).toBe(canonical)
    await service.dispose()
  })

  test("queues a forced refresh without failing callers of the active preparation", async () => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
    let releaseFirst: (() => void) | undefined
    const firstCatalog = new Promise<void>((resolve) => { releaseFirst = resolve })
    let catalogCalls = 0
    let activeCatalogs = 0
    let maximumActiveCatalogs = 0
    let now = 0
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]),
      prepare: service.prepare,
      publish: service.publish,
      current: service.state,
      inputRevision: () => ({ auth: "auth-v1", preferences: "preferences-v1" }),
      now: () => now,
      resolveCatalog: async () => {
        catalogCalls += 1
        activeCatalogs += 1
        maximumActiveCatalogs = Math.max(maximumActiveCatalogs, activeCatalogs)
        if (catalogCalls === 1) await firstCatalog
        await Promise.resolve()
        activeCatalogs -= 1
        return { providers: new Map(), accounts: new Map(), inventoryCandidates: new Map(), modelInfos: new Map(), enabledModels: new Map() }
      },
    })

    const first = prepare(PROFILE)
    const waiter = prepare(PROFILE)
    const forced = prepare(PROFILE, { force: true })
    now = 300_000
    prepare.scheduleRefresh(PROFILE)
    releaseFirst?.()

    const [firstState, waiterState, forcedState] = await Promise.all([first, waiter, forced])
    expect(waiterState).toBe(firstState)
    expect(forcedState.revision).toBeGreaterThan(firstState.revision)
    expect(catalogCalls).toBe(3)
    expect(maximumActiveCatalogs).toBe(1)
    await prepare.dispose()
    await service.dispose()
  })

  test("publishes cached account A before uncached account B discovery settles", async () => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
    const refresh = Promise.withResolvers<void>()
    const refreshEntered = Promise.withResolvers<void>()
    const cached = { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" } as const
    const pending = { kind: "singleton", providerId: "anthropic_api", spendMode: "direct_api" } as const
    const offering: CatalogModelOffering = { wireModelId: "gpt-5.5", metadata: null, dataUse: "standard", transport: "openai-responses" }
    let refreshSettled = false
    let authRevision = "auth-v1"
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]),
      prepare: service.prepare,
      publish: service.publish,
      current: service.state,
      inputRevision: () => ({ auth: authRevision, preferences: "preferences-v1" }),
      resolveCatalog: async ({ discoveryMode }) => {
        if (discoveryMode === "refresh") {
          refreshEntered.resolve()
          try {
            await refresh.promise
          } finally {
            refreshSettled = true
          }
        }
        const enabled = new Map([["gpt-5.5", [offering] as const]])
        const cachedModels = { catalog: new Set(["gpt-5.5"]), curatedDefault: new Set(["gpt-5.5"]), enabled: new Set<string>(), disabled: new Set<string>(), effective: new Set(["gpt-5.5"]) }
        const pendingModels = { catalog: new Set<string>(), curatedDefault: new Set<string>(), enabled: new Set<string>(), disabled: new Set<string>(), effective: new Set<string>() }
        return {
          providers: new Map(),
          accounts: new Map([[accessProviderAccountKey(cached), cachedModels], [accessProviderAccountKey(pending), pendingModels]]),
          inventoryCandidates: new Map([
            ["cached", { candidate: cached, configured: true, currentConnection: true, enabledOfferings: enabled, inventoryOfferings: enabled, outcome: { kind: "catalog", provenance: "first-party-cached", liveOutcome: "valid", rows: [{ modelId: "gpt-5.5", offerings: [offering] }] } }],
            ["pending", { candidate: pending, configured: true, currentConnection: true, enabledOfferings: null, inventoryOfferings: null, outcome: { kind: "unavailable", reason: discoveryMode === "refresh" ? "discovery-failed" : "discovery-pending" } }],
          ]),
          modelInfos: new Map(),
          enabledModels: new Map(),
        }
      },
    })

    const initial = await prepare(PROFILE)
    await refreshEntered.promise
    expect(refreshSettled).toBe(false)
    expect(initial.inventoryCandidates.get("cached")?.enabledOfferings?.has("gpt-5.5")).toBe(true)
    expect(initial.inventoryCandidates.get("pending")?.enabledOfferings).toBeNull()
    expect(await prepare.capture(PROFILE, (state) => state)).toBe(initial)
    authRevision = "account-B-changed"
    const forced = prepare(PROFILE, { force: true })
    try {
      const captured = await Promise.race([
        prepare.capture(PROFILE, (state) => state),
        new Promise<undefined>((resolve) => setTimeout(resolve, 20)),
      ])
      expect(captured?.authRevision).toBe(authRevision)
      expect(captured?.inventoryCandidates.get("cached")?.enabledOfferings?.has("gpt-5.5")).toBe(true)
    } finally {
      refresh.resolve()
      await forced
    }
    let settled = false
    const settlement = prepare(PROFILE, { settled: true }).then(() => { settled = true })
    expect(settled).toBe(false)
    refresh.resolve()
    await settlement
    expect(settled).toBe(true)
    await prepare.dispose()
    expect(refreshSettled).toBe(true)
    await service.dispose()
  })

  test("keeps a refreshed catalog when an overlapping cached capture finishes later", async () => {
    const publications: number[] = []
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next", publish: (state) => { publications.push(state.revision) } })
    const refreshEntered = Promise.withResolvers<void>()
    const refresh = Promise.withResolvers<void>()
    const cachedEntered = Promise.withResolvers<void>()
    const cached = Promise.withResolvers<void>()
    const candidate = { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" } as const
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]),
      prepare: service.prepare,
      publish: service.publish,
      current: service.state,
      inputRevision: () => ({ auth: "auth-v1", preferences: "preferences-v1" }),
      resolveAuth: async () => testAuthContext(),
      resolveCatalog: async ({ discoveryMode }) => {
        const modelId = discoveryMode === "refresh" ? "gpt-5.5" : "gpt-5"
        const offering: CatalogModelOffering = { wireModelId: modelId, metadata: null, dataUse: "standard", transport: "openai-responses" }
        const offerings = new Map([[modelId, [offering]]])
        const models = { catalog: new Set([modelId]), curatedDefault: new Set([modelId]), enabled: new Set<string>(), disabled: new Set<string>(), effective: new Set([modelId]) }
        if (discoveryMode === "refresh") {
          refreshEntered.resolve()
          await refresh.promise
        } else {
          cachedEntered.resolve()
          await cached.promise
        }
        return {
          providers: new Map(), accounts: new Map([[accessProviderAccountKey(candidate), models]]), modelInfos: new Map(), enabledModels: new Map(),
          inventoryCandidates: new Map([["account", { candidate, configured: true, currentConnection: true, enabledOfferings: offerings, inventoryOfferings: offerings, outcome: { kind: "catalog", provenance: "first-party-cached", liveOutcome: "valid", rows: [{ modelId, offerings: [offering] }] } }]]),
        }
      },
    })
    try {
      const forced = prepare(PROFILE, { force: true })
      await refreshEntered.promise
      const capture = prepare.capture(PROFILE, (state) => state)
      await cachedEntered.promise
      refresh.resolve()
      const fresh = await forced
      cached.resolve()
      const captured = await capture
      expect(captured).toBe(fresh)
      expect(captured.inventoryCandidates.get("account")?.inventoryOfferings?.has("gpt-5.5")).toBe(true)
      expect(service.state(PROFILE.id)).toBe(fresh)
      expect(publications).toEqual([fresh.revision])
    } finally {
      refresh.resolve()
      cached.resolve()
      await prepare.dispose()
      await service.dispose()
    }
  })

  test("lets a second waiter finish when the initiating caller cancels", async () => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]),
      prepare: service.prepare,
      publish: service.publish,
      current: service.state,
      inputRevision: () => ({ auth: "auth-v1", preferences: "preferences-v1" }),
      resolveCatalog: async () => {
        await blocked
        return { providers: new Map(), accounts: new Map(), inventoryCandidates: new Map(), modelInfos: new Map(), enabledModels: new Map() }
      },
    })
    const controller = new AbortController()
    const initiator = prepare(PROFILE, { signal: controller.signal })
    const waiter = prepare(PROFILE)
    const reason = new Error("initiator stopped")
    controller.abort(reason)
    release?.()

    await expect(initiator).rejects.toBe(reason)
    expect((await waiter).profileId).toBe("work")
    await prepare.dispose()
    await service.dispose()
  })

  test("owner disposal aborts and joins catalog settlement without late publication", async () => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
    const settlement = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    let ownerSignal: AbortSignal | undefined
    let publications = 0
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]),
      prepare: service.prepare,
      publish: (state) => { publications += 1; service.publish(state) },
      current: service.state,
      inputRevision: () => ({ auth: "auth-v1", preferences: "preferences-v1" }),
      resolveCatalog: async ({ signal }) => {
        ownerSignal = signal
        entered.resolve()
        await settlement.promise
        return { providers: new Map(), accounts: new Map(), inventoryCandidates: new Map(), modelInfos: new Map(), enabledModels: new Map() }
      },
    })
    const operation = prepare(PROFILE)
    await entered.promise
    let disposed = false
    const disposal = prepare.dispose().then(() => { disposed = true })

    expect(ownerSignal?.aborted).toBe(true)
    await Promise.resolve()
    expect(disposed).toBe(false)
    settlement.resolve()
    await disposal
    await expect(operation).rejects.toMatchObject({ name: "AbortError" })
    expect(publications).toBe(0)
    await service.dispose()
  })

  test("bounds preparation retries when profile inputs keep changing", async () => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "preference-revision-next", persistAllDeselected: async () => "preference-revision-next" })
    let revisionReads = 0
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]),
      prepare: service.prepare,
      publish: service.publish,
      current: service.state,
      inputRevision: () => {
        revisionReads += 1
        return { auth: `auth-v${revisionReads}`, preferences: "preferences-v1" }
      },
    })

    await expect(prepare(PROFILE)).rejects.toThrow("auth profile inputs did not stabilize")
    expect(revisionReads).toBe(4)
    await service.dispose()
  })

  test("retains release-date order after deselect-all and a complete re-preparation", async () => {
    let preferenceRevision = "preferences-1"
    const candidate = { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" } as const
    const accountKey = accessProviderAccountKey(candidate)
    const datedOffering = (modelId: string, releaseDate: string): readonly CatalogModelOffering[] => [{
      wireModelId: modelId,
      metadata: null,
      resolvedMetadata: modelInfo("openai", modelId, "shared", 1, 2, releaseDate),
      dataUse: "standard",
      transport: "openai-responses",
    }]
    const availableModels = new Map([
      ["older", datedOffering("older", "2025-01-01")],
      ["newer", datedOffering("newer", "2026-01-01")],
    ])
    const resolvedModels = (effective: ReadonlySet<string>): ResolvedProviderModels => ({
      catalog: new Set(["older", "newer"]),
      curatedDefault: new Set(["older", "newer"]),
      enabled: new Set(),
      disabled: effective.size === 0 ? new Set(["older", "newer"]) : new Set(),
      effective,
    })
    const service = createProviderModelPreferenceService({
      displayName: (id) => id,
      allowTrainingRoutes: () => false,
      persist: async () => preferenceRevision,
      persistAllDeselected: async () => {
        preferenceRevision = "preferences-2"
        return preferenceRevision
      },
    })
    const resolveCatalog = async (): Promise<ResolvedProviderModelCatalogs> => {
      const models = resolvedModels(preferenceRevision === "preferences-1" ? new Set(["older", "newer"]) : new Set())
      return {
        providers: new Map([["openai_api", models]]),
        accounts: new Map([[accountKey, models]]),
        inventoryCandidates: new Map([[accountKey, {
          candidate,
          configured: true,
          currentConnection: true,
          enabledOfferings: preferenceRevision === "preferences-1" ? availableModels : new Map(),
          inventoryOfferings: availableModels,
        }]]),
        modelInfos: new Map(),
        enabledModels: new Map(),
      }
    }
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules(),
      prepare: service.prepare,
      publish: service.publish,
      current: service.state,
      inputRevision: () => ({ auth: "auth-1", preferences: preferenceRevision }),
      resolveCatalog,
    })

    const initial = await prepare(PROFILE)
    await service.deselectAll({
      queriedProfileId: PROFILE.id,
      queriedEligibilityRevision: initial.revision,
      target: { kind: "singleton", providerId: "openai_api" },
    })
    await prepare(PROFILE, { force: true })

    expect((await service.query(PROFILE.id, { kind: "singleton", providerId: "openai_api" })).rows.map(({ modelId }) => modelId))
      .toEqual(["newer", "older"])
    await service.dispose()
  })
})

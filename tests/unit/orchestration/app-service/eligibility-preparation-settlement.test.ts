import { describe, expect, test } from "bun:test"

import { accessProviderAccountKey } from "../../../../src/infra/llm/access-provider.js"
import type { CatalogModelOffering } from "../../../../src/infra/llm/model-catalog-resolution.js"
import type { ResolvedProviderModels } from "../../../../src/infra/llm/provider-model-preferences.js"
import { authDir } from "../../../../src/infra/paths.js"
import { createEligibilityPreparation } from "../../../../src/orchestration/app-service/eligibility-preparation.js"
import { createProviderModelPreferenceService, type ProviderModelEligibilityState } from "../../../../src/orchestration/app-service/provider-model-preference-service.js"
import type { ResolvedProviderModelCatalogs } from "../../../../src/orchestration/config/model-assignment-providers.js"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { testDirectories } from "../../../helpers/directories.js"

const DIRECTORIES = testDirectories(process.cwd())
const PROFILE = { id: "work", directory: authDir(DIRECTORIES.userDataRoot, "work") }
const PENDING = { kind: "singleton", providerId: "anthropic_api", spendMode: "direct_api" } as const
const PENDING_KEY = accessProviderAccountKey(PENDING)
const OFFERING: CatalogModelOffering = { wireModelId: "claude-fable-5-1", metadata: null, dataUse: "standard", transport: "anthropic-messages" }

type InventoryCandidate = ResolvedProviderModelCatalogs["inventoryCandidates"] extends ReadonlyMap<string, infer Candidate> ? Candidate : never

const emptyModels = (): ResolvedProviderModels => ({ catalog: new Set(), curatedDefault: new Set(), enabled: new Set(), disabled: new Set(), effective: new Set() })

const grok = { kind: "subscription", providerId: "supergrok", instanceId: "primary", spendMode: "included" } as const
const grokKey = accessProviderAccountKey(grok)
const grokIds = ["grok-a", "grok-b"]
interface AuditedOptions {
  readonly auditFailure?: Error
  readonly settlementTimeoutMs?: number
  /** Holds the listing of a discovery mode until the promise resolves. */
  readonly listings?: { readonly refresh?: Promise<void>; readonly fresh?: Promise<void> }
}
/** One account whose listing leaves two models for the audit; each probe waits for its resolver. `modes` records
 *  each catalog resolution's discovery mode as it starts. */
const audited = (options: AuditedOptions = {}) => {
  const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
  const probes = grokIds.map(() => Promise.withResolvers<void>())
  const modes: string[] = []
  let listed = false
  let verified = 0
  const prepare = createEligibilityPreparation({
    userDataRoot: DIRECTORIES.userDataRoot,
    allowTrainingRoutes: () => false,
    resolveKey: async () => undefined,
    moduleSelection: () => composeFirstPartyModules([]),
    prepare: service.prepare,
    publish: service.publish,
    current: service.state,
    inputRevision: () => ({ auth: "auth-v1", preferences: "preferences-v1" }),
    ...options.settlementTimeoutMs === undefined ? {} : { settlementTimeoutMs: options.settlementTimeoutMs },
    resolveCatalog: async ({ discoveryMode, onAccessAudit }) => {
      modes.push(discoveryMode ?? "missing")
      if (discoveryMode === "refresh" || discoveryMode === "fresh") await options.listings?.[discoveryMode]
      if (discoveryMode === "refresh") listed = true
      if (discoveryMode === "audit") {
        for (const [index, modelId] of grokIds.entries()) {
          await probes[index]!.promise
          if (options.auditFailure !== undefined) throw options.auditFailure
          verified += 1
          await onAccessAudit?.({ account: grok, remaining: grokIds.length - verified, modelId, outcome: "completed" })
        }
      }
      const offerings = new Map(grokIds.slice(0, verified).map((id) => [id, [{ wireModelId: id, metadata: null, dataUse: "standard" as const }] as const]))
      const models: ResolvedProviderModels = { ...emptyModels(), catalog: new Set(offerings.keys()), curatedDefault: new Set(offerings.keys()), effective: new Set(offerings.keys()) }
      return {
        providers: new Map(),
        accounts: new Map([[grokKey, models]]),
        inventoryCandidates: new Map<string, InventoryCandidate>([[grokKey, {
          candidate: grok, configured: true, currentConnection: true, enabledOfferings: offerings, inventoryOfferings: offerings,
          ...listed ? { audit: { remaining: grokIds.length - verified, refused: 0 } } : {},
          ...verified === 0 ? { outcome: { kind: "unavailable", reason: "discovery-pending" } } : {},
        }]]),
        modelInfos: new Map(),
        enabledModels: new Map(),
      }
    },
  })
  const dispose = async () => {
    for (const probe of probes) probe.resolve()
    await prepare.dispose()
    await service.dispose()
  }
  return { service, probes, prepare, modes, dispose }
}
const turns = async () => { for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve)) }

describe("eligibility preparation settlement", () => {
  test("a login listing keeps its admitted composition after the live selection changes", async () => {
    const captured = composeFirstPartyModules(undefined, []);
    const live = composeFirstPartyModules();
    const seen: boolean[] = [];
    const service = createProviderModelPreferenceService({
      displayName: (id) => id,
      allowTrainingRoutes: () => false,
      persist: async () => "next",
      persistAllDeselected: async () => "next",
    })
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot,
      resolveKey: async () => undefined,
      moduleSelection: () => live,
      prepare: service.prepare,
      publish: service.publish,
      current: service.state,
      inputRevision: () => ({ auth: "auth-v1", preferences: "preferences-v1" }),
      resolveCatalog: async ({ moduleSelection }) => {
        seen.push(moduleSelection?.() === captured)
        return { providers: new Map(), accounts: new Map(), inventoryCandidates: new Map(), modelInfos: new Map(), enabledModels: new Map() }
      },
    })
    try {
      await prepare(PROFILE, { mode: "fresh", composition: captured })
      expect(seen).toEqual([true])
    } finally {
      await prepare.dispose()
      await service.dispose()
    }
  })

  test.each(["cached-first", "saved-only"] as const)("publishes the discovery that resolves a pending account after a %s read", async (mode) => {
    const publications: ProviderModelEligibilityState[] = []
    const service = createProviderModelPreferenceService({
      displayName: (id) => id,
      allowTrainingRoutes: () => false,
      persist: async () => "next",
      persistAllDeselected: async () => "next",
      publish: (state) => { publications.push(state) },
    })
    const refresh = Promise.withResolvers<void>()
    const modes: string[] = []
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]),
      prepare: service.prepare,
      publish: service.publish,
      current: service.state,
      inputRevision: () => ({ auth: "auth-v1", preferences: "preferences-v1" }),
      resolveCatalog: async ({ discoveryMode }) => {
        modes.push(discoveryMode ?? "missing")
        const discovered = discoveryMode === "refresh"
        if (discovered) await refresh.promise
        const enabled = new Map([["claude-fable-5.1", [OFFERING] as const]])
        const models: ResolvedProviderModels = discovered
          ? { catalog: new Set(["claude-fable-5.1"]), curatedDefault: new Set(["claude-fable-5.1"]), enabled: new Set(), disabled: new Set(), effective: new Set(["claude-fable-5.1"]) }
          : emptyModels()
        return {
          providers: new Map(),
          accounts: new Map([[PENDING_KEY, models]]),
          inventoryCandidates: new Map([[PENDING_KEY, discovered
            ? { candidate: PENDING, configured: true, currentConnection: true, enabledOfferings: enabled, inventoryOfferings: enabled, outcome: { kind: "catalog", provenance: "first-party", liveOutcome: "valid", rows: [{ modelId: "claude-fable-5.1", offerings: [OFFERING] }] } }
            : { candidate: PENDING, configured: true, currentConnection: true, enabledOfferings: null, inventoryOfferings: null, outcome: { kind: "unavailable", reason: "discovery-pending" } }]]),
          modelInfos: new Map(),
          enabledModels: new Map(),
        }
      },
    })

    try {
      if (mode === "saved-only") {
        const saved = await prepare.capture(PROFILE, (state) => state, undefined, "saved-only")
        expect(saved.inventoryCandidates.get(PENDING_KEY)?.catalog).toEqual({ kind: "unavailable", reason: "discovery-pending" })
        expect(modes).toEqual(["cached-first"])
      } else {
        await prepare(PROFILE)
      }
      const order: string[] = []
      const admissions = [0, 1].map(() => prepare(PROFILE, { settled: true }).then((state) => {
        order.push("settled")
        return state
      }))
      const captured = prepare.capture(PROFILE, (state) => {
        order.push("capture")
        return state
      })
      await new Promise((resolve) => setImmediate(resolve))
      expect(order).toEqual([])
      order.push("release")
      refresh.resolve()
      for (const state of await Promise.all(admissions)) {
        expect(state.inventoryCandidates.get(PENDING_KEY)?.catalog.kind).toBe("available")
      }
      expect((await captured).inventoryCandidates.get(PENDING_KEY)?.catalog.kind).toBe("available")
      expect(order[0]).toBe("release")

      expect(modes).toEqual(["cached-first", "refresh"])
      expect(publications.map((state) => state.inventoryCandidates.get(PENDING_KEY)?.catalog)).toEqual([
        { kind: "unavailable", reason: "discovery-pending" },
        { kind: "available", provenance: "first-party", liveOutcome: "valid" },
      ])
    } finally {
      refresh.resolve()
      await prepare.dispose()
      await service.dispose()
    }
  })

  test.each(["another account serves", "a contributor account cannot serve", "a contributor account is permitted", "the first model passes", "the deadline passes"] as const)("settled admission waits for the access audit only while no account can serve, at most until the listing deadline, and the finished audit reaches sessions: %s", async (ending) => {
    const contributor = ending.startsWith("a contributor")
    const otherAccount = ending === "another account serves" || contributor
    const allowTrainingRoutes = () => ending === "a contributor account is permitted"
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes, persist: async () => "next", persistAllDeselected: async () => "next" })
    const offering: CatalogModelOffering = { ...OFFERING, dataUse: contributor ? "contributor" : "standard" }
    const anthropicOfferings = new Map([["claude-fable-5.1", [offering] as const]])
    const probes = grokIds.map(() => Promise.withResolvers<void>())
    const applied = Promise.withResolvers<string>()
    let listed = false
    let verified = 0
    const prepare = createEligibilityPreparation({
      userDataRoot: DIRECTORIES.userDataRoot,
      allowTrainingRoutes,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]),
      prepare: service.prepare,
      publish: service.publish,
      current: service.state,
      inputRevision: () => ({ auth: "auth-v1", preferences: "preferences-v1" }),
      apply: async (profileId) => { applied.resolve(profileId) },
      ...ending === "the deadline passes" ? { settlementTimeoutMs: 1 } : {},
      resolveCatalog: async ({ discoveryMode, onAccessAudit }) => {
        if (discoveryMode === "refresh") listed = true
        if (discoveryMode === "audit") {
          for (const [index, modelId] of grokIds.entries()) {
            await probes[index]!.promise
            verified += 1
            await onAccessAudit?.({ account: grok, remaining: grokIds.length - verified, modelId, outcome: "completed" })
          }
        }
        const grokOfferings = new Map(grokIds.slice(0, verified).map((id) => [id, [{ wireModelId: id, metadata: null, dataUse: "standard" as const }] as const]))
        const grokModels: ResolvedProviderModels = { ...emptyModels(), catalog: new Set(grokOfferings.keys()), curatedDefault: new Set(grokOfferings.keys()), effective: new Set(grokOfferings.keys()) }
        const anthropicModels: ResolvedProviderModels = listed ? { ...emptyModels(), catalog: new Set(["claude-fable-5.1"]), curatedDefault: new Set(["claude-fable-5.1"]), effective: new Set(["claude-fable-5.1"]) } : emptyModels()
        const accounts = new Map([[grokKey, grokModels]])
        const inventoryCandidates = new Map<string, InventoryCandidate>([[grokKey, {
          candidate: grok, configured: true, currentConnection: true, enabledOfferings: grokOfferings, inventoryOfferings: grokOfferings,
          ...listed ? { audit: { remaining: grokIds.length - verified, refused: 0 } } : {},
          ...verified === 0 ? { outcome: { kind: "unavailable", reason: "discovery-pending" } } : {},
        }]])
        if (otherAccount) {
          accounts.set(PENDING_KEY, anthropicModels)
          inventoryCandidates.set(PENDING_KEY, listed
            ? { candidate: PENDING, configured: true, currentConnection: true, enabledOfferings: anthropicOfferings, inventoryOfferings: anthropicOfferings, outcome: { kind: "catalog", provenance: "first-party", liveOutcome: "valid", rows: [{ modelId: "claude-fable-5.1", offerings: [offering] }] } }
            : { candidate: PENDING, configured: true, currentConnection: true, enabledOfferings: null, inventoryOfferings: null, outcome: { kind: "unavailable", reason: "discovery-pending" } })
        }
        return { providers: new Map(), accounts, inventoryCandidates, modelInfos: new Map(), enabledModels: new Map() }
      },
    })
    try {
      let admitted: ProviderModelEligibilityState | undefined
      const admission = prepare(PROFILE, { settled: true }).then((state) => { admitted = state })
      for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve))
      expect(listed).toBe(true)
      if (otherAccount && ending !== "a contributor account cannot serve") {
        // Another account serves at once, so admission ends at the listing while every probe is still held.
        await admission
        expect(verified).toBe(0)
        expect(admitted?.inventoryCandidates.get(PENDING_KEY)?.catalog.kind).toBe("available")
        expect(admitted?.inventoryCandidates.get(grokKey)?.catalog).toEqual({ kind: "unavailable", reason: "discovery-pending" })
      } else if (ending === "the first model passes" || ending === "a contributor account cannot serve") {
        // No account serves after the listing, so admission waits until the first verified model, not the whole audit.
        expect(admitted).toBeUndefined()
        probes[0]!.resolve()
        await admission
        expect(admitted?.inventoryCandidates.get(grokKey)?.inventoryOfferings?.size).toBe(1)
      } else {
        // Every probe is held, so admission proceeds at the deadline with what the listing published.
        await admission
        expect(verified).toBe(0)
        expect(admitted?.inventoryCandidates.get(grokKey)?.catalog).toEqual({ kind: "unavailable", reason: "discovery-pending" })
      }
      probes[0]!.resolve()
      probes[1]!.resolve()
      expect(await applied.promise).toBe(PROFILE.id)
      expect(service.state(PROFILE.id)?.inventoryCandidates.get(grokKey)?.inventoryOfferings?.size).toBe(2)
    } finally {
      for (const probe of probes) probe.resolve()
      await prepare.dispose()
      await service.dispose()
    }
  })

  test("a forced run that arrives while the discovery lists waits for the listing and never for its audit, and a settled caller that came first still waits for an account that can serve", async () => {
    const refresh = Promise.withResolvers<void>()
    const fresh = Promise.withResolvers<void>()
    const { service, probes, prepare, modes, dispose } = audited({ listings: { refresh: refresh.promise, fresh: fresh.promise } })
    try {
      await prepare(PROFILE)
      let early: ProviderModelEligibilityState | undefined
      const admission = prepare(PROFILE, { settled: true }).then((state) => { early = state })
      await turns()
      let forced = false
      const login = prepare(PROFILE, { mode: "fresh" }).then(() => { forced = true })

      refresh.resolve()
      await turns()
      expect(modes).toEqual(["cached-first", "refresh", "fresh"])
      expect(early).toBeUndefined()

      fresh.resolve()
      await turns()
      expect(forced).toBe(true)
      expect(modes).toEqual(["cached-first", "refresh", "fresh", "audit"])
      expect(early).toBeUndefined()

      probes[0]!.resolve()
      await admission
      expect(early?.inventoryCandidates.get(grokKey)?.inventoryOfferings?.size).toBe(1)

      probes[1]!.resolve()
      await login
      await prepare.awaitDiscovery(PROFILE, new AbortController().signal)
      expect(modes.filter((mode) => mode !== "cached-first")).toEqual(["refresh", "fresh", "audit"])
      expect(service.state(PROFILE.id)?.inventoryCandidates.get(grokKey)?.inventoryOfferings?.size).toBe(2)
    } finally {
      refresh.resolve()
      fresh.resolve()
      await dispose()
    }
  })

  describe("awaitDiscovery", () => {
    test("resolves after the audit's last publication", async () => {
      const { service, probes, prepare, dispose } = audited()
      try {
        await prepare(PROFILE)
        let settled = false
        const discovery = prepare.awaitDiscovery(PROFILE, new AbortController().signal).then(() => { settled = true })
        probes[0]!.resolve()
        await turns()
        expect(settled).toBe(false)
        probes[1]!.resolve()
        await discovery
        expect(service.state(PROFILE.id)?.inventoryCandidates.get(grokKey)?.inventoryOfferings?.size).toBe(2)
      } finally {
        await dispose()
      }
    })

    test("resolves at once when no discovery runs", async () => {
      const { prepare, dispose } = audited()
      try {
        await prepare.awaitDiscovery(PROFILE, new AbortController().signal)
      } finally {
        await dispose()
      }
    })

    test("rejects when the listing reaches its deadline and the audit then rejects", async () => {
      const failure = new Error("audit probe failed")
      const { probes, prepare, dispose } = audited({ auditFailure: failure, settlementTimeoutMs: 1 })
      try {
        await prepare(PROFILE, { settled: true })
        const discovery = prepare.awaitDiscovery(PROFILE, new AbortController().signal)
        probes[0]!.resolve()
        await expect(discovery).rejects.toBe(failure)
      } finally {
        await dispose()
      }
    })

    test("ends on an abort of its signal while the audit runs", async () => {
      const { prepare, dispose } = audited()
      try {
        await prepare(PROFILE)
        const controller = new AbortController()
        const discovery = prepare.awaitDiscovery(PROFILE, controller.signal)
        const reason = new DOMException("Stopped", "AbortError")
        controller.abort(reason)
        await expect(discovery).rejects.toBe(reason)
      } finally {
        await dispose()
      }
    })
  })

  test("publishes a failed discovery and preserves the waiter error", async () => {
    const publications: ProviderModelEligibilityState[] = []
    const service = createProviderModelPreferenceService({
      displayName: (id) => id,
      allowTrainingRoutes: () => false,
      persist: async () => "next",
      persistAllDeselected: async () => "next",
      publish: (state) => { publications.push(state) },
    })
    const refresh = Promise.withResolvers<void>()
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]),
      prepare: service.prepare,
      publish: service.publish,
      current: service.state,
      inputRevision: () => ({ auth: "auth-v1", preferences: "preferences-v1" }),
      resolveCatalog: async ({ discoveryMode }) => {
        if (discoveryMode === "refresh") {
          await refresh.promise
          throw new Error("provider unreachable")
        }
        return {
          providers: new Map(),
          accounts: new Map([[PENDING_KEY, emptyModels()]]),
          inventoryCandidates: new Map([[PENDING_KEY, { candidate: PENDING, configured: true, currentConnection: true, enabledOfferings: null, inventoryOfferings: null, outcome: { kind: "unavailable", reason: "discovery-pending" } }]]),
          modelInfos: new Map(),
          enabledModels: new Map(),
        }
      },
    })

    await prepare(PROFILE)
    const settled = prepare(PROFILE, { settled: true })
    refresh.resolve()

    await expect(settled).rejects.toThrow("provider unreachable")
    expect(publications.map((state) => state.inventoryCandidates.get(PENDING_KEY)?.catalog)).toEqual([
      { kind: "unavailable", reason: "discovery-pending" },
      { kind: "unavailable", reason: "discovery-failed" },
    ])
    await prepare.dispose()
    await service.dispose()
  })

  test("settles the latest preferences when their discovery fails", async () => {
    const available = { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" } as const
    const availableKey = accessProviderAccountKey(available)
    const availableOffering: CatalogModelOffering = { wireModelId: "gpt-5", metadata: null, dataUse: "standard", transport: "openai-responses" }
    const availableOfferings = new Map([["gpt-5", [availableOffering] as const]])
    const availableModels: ResolvedProviderModels = { catalog: new Set(["gpt-5"]), curatedDefault: new Set(["gpt-5"]), enabled: new Set(), disabled: new Set(), effective: new Set(["gpt-5"]) }
    let preferenceRevision = "preferences-v1"
    const service = createProviderModelPreferenceService({
      displayName: (id) => id,
      allowTrainingRoutes: () => false,
      persist: async () => {
        preferenceRevision = "preferences-v2"
        return preferenceRevision
      },
      persistAllDeselected: async () => preferenceRevision,
    })
    const refresh = Promise.withResolvers<void>()
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]),
      prepare: service.prepare,
      publish: service.publish,
      current: service.state,
      inputRevision: () => ({ auth: "auth-v1", preferences: preferenceRevision }),
      resolveCatalog: async ({ discoveryMode }) => {
        if (discoveryMode === "refresh") {
          await refresh.promise
          throw new Error("provider unreachable")
        }
        return {
          providers: new Map(),
          accounts: new Map([[availableKey, availableModels], [PENDING_KEY, emptyModels()]]),
          inventoryCandidates: new Map([
            [availableKey, { candidate: available, configured: true, currentConnection: true, enabledOfferings: availableOfferings, inventoryOfferings: availableOfferings, outcome: { kind: "catalog", provenance: "first-party-cached", liveOutcome: "valid", rows: [{ modelId: "gpt-5", offerings: [availableOffering] }] } }],
            [PENDING_KEY, { candidate: PENDING, configured: true, currentConnection: true, enabledOfferings: null, inventoryOfferings: null, outcome: { kind: "unavailable", reason: "discovery-pending" } }],
          ]),
          modelInfos: new Map(),
          enabledModels: new Map(),
        }
      },
    })

    const displayed = await prepare(PROFILE)
    await service.set({ queriedProfileId: PROFILE.id, queriedEligibilityRevision: displayed.revision, target: { kind: "singleton", providerId: "openai_api" }, modelId: "gpt-5", checked: false })
    const captured = prepare.capture(PROFILE, (state) => state)
    const settled = prepare(PROFILE, { settled: true })
    const failures = Promise.allSettled([captured, settled])
    refresh.resolve()

    expect(await failures).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: "provider unreachable" }) },
      { status: "rejected", reason: expect.objectContaining({ message: "provider unreachable" }) },
    ])
    expect(service.state()?.worker.candidateOffering?.(available, "gpt-5", false)).toBeUndefined()
    expect(service.state()?.preferenceRevision).toBe("preferences-v2")
    expect(service.state()?.inventoryCandidates.get(PENDING_KEY)?.catalog).toEqual({ kind: "unavailable", reason: "discovery-failed" })
    expect(service.state()?.accountCatalogs.get(availableKey)?.disabled).toEqual(new Set(["gpt-5"]))
    await prepare.dispose()
    await service.dispose()
  })
})

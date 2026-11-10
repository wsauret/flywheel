import { describe, expect, test } from "bun:test"
import { AuthProfileStore } from "../../../../src/infra/auth/auth-profile-store.js"
import { authDir } from "../../../../src/infra/paths.js"
import { accessProviderAccountKey, createAccessProviderSelection } from "../../../../src/infra/llm/access-provider.js"
import type { ResolvedProviderModels } from "../../../../src/infra/llm/provider-model-preferences.js"
import { createModelListingClient } from "../../../../src/infra/llm/model-listing.js"
import { createEligibilityPreparation } from "../../../../src/orchestration/app-service/eligibility-preparation.js"
import { createProviderModelPreferenceService, type ProviderModelEligibilityState } from "../../../../src/orchestration/app-service/provider-model-preference-service.js"
import { credentialSlotClassifier } from "../../../../src/orchestration/auth/credential-slot-classifier.js"
import { resolveProviderModelCatalog } from "../../../../src/orchestration/config/model-assignment-providers.js"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { testAuthContext } from "../../../helpers/auth-context.js"
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js"
import { modelInfo } from "../../../helpers/model-tier-fixtures.js"
import { testCapabilityModules, testProviderSelection } from "../../../helpers/provider-authority.js"
import { countStateRequests } from "../../../helpers/state-requests.js"
import type { SubscriptionUsagePublishedSnapshot } from "../../../../src/orchestration/auth/provider-observations/subscription-usage-service.js"
import { Redacted } from "effect"

const DIRECTORIES = testDirectories(process.cwd())
const PROFILE = { id: "work", directory: authDir(DIRECTORIES.userDataRoot, "work") }
const temporaryDirectory = temporaryDirectories()

describe("eligibility preparation with a models.dev catalog source", () => {
  test("settles a Vertex-only session target from the held models.dev catalog when the metadata refresh fails", async () => {
    const userDataRoot = temporaryDirectory("flywheel-vertex-held-catalog-")
    const access = await new AuthProfileStore(userDataRoot).create("work")
    const profile = { id: "work", directory: access.authDirectory }
    const lineage = "00000000-0000-4000-8000-000000000012"
    access.writeFile("auth.json", JSON.stringify({ google_vertex: { type: "api_key", key: "vertex", lineageId: lineage } }))
    access.close()
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
    const vertex = { kind: "singleton", providerId: "google_vertex", spendMode: "direct_api" } as const
    const auth = testAuthContext({ apiKeys: { google_vertex: "vertex" }, credentialLineages: { google_vertex: lineage } })
    let probes = 0
    let refreshes = 0
    const listingClient = createModelListingClient({
      classifySlot: credentialSlotClassifier(testCapabilityModules()),
      authDir: profile.directory,
      providers: createAccessProviderSelection(testProviderSelection().definitions.map((definition) =>
        definition.id !== "google_vertex" || definition.dynamicCatalog === undefined ? definition : {
          ...definition,
          dynamicCatalog: {
            ...definition.dynamicCatalog,
            probeAccess: async () => { probes += 1; return "completed" },
          },
        })),
      modelsClient: {
        refresh: async () => {},
        getTokenizerIdentity: () => undefined,
        getProviderCatalog: (providers) => providers.includes("google-vertex")
          ? [{
              providerId: "google-vertex",
              providerName: "Vertex",
              wireModelId: "gemini-3.8-flash",
              metadata: modelInfo("google", "gemini-3.8-flash", "gemini", 1, 2, "2026-01-01"),
              provenance: "bundled" as const,
              canonical: { providerId: "google", modelId: "gemini-3.8-flash" },
              transport: { npm: "@ai-sdk/google-vertex" },
            }]
          : [],
      },
    })
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]),
      prepare: service.prepare,
      publish: service.publish,
      current: service.state,
      inputRevision: () => ({ auth: "auth-v1", preferences: "preferences-v1" }),
      resolveAuth: async () => auth,
      resolveCatalog: (deps) => resolveProviderModelCatalog({ ...deps, listingClient }),
      // A failed models.dev fetch resolves without replacing the held catalog.
      refreshMetadata: async () => { refreshes += 1 },
    })

    const state = await prepare(profile, { settled: true })

    expect(refreshes).toBe(1)
    expect(probes).toBe(1)
    expect(state.picker.has("gemini-3.8-flash")).toBe(true)
    expect(state.inventoryCandidates.get(accessProviderAccountKey(vertex))?.catalog).toEqual({ kind: "available", provenance: "models-dev-bundled", liveOutcome: "discovery-failed" })
    await prepare.dispose()
    await service.dispose()
  })

  test.each(["unchanged", "auth", "preferences"] as const)("an audit preserves settled first-party fallback at every publication only for unchanged inputs: %s", async (changed) => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
    const candidate = { kind: "subscription", providerId: "supergrok", instanceId: "primary", spendMode: "included" } as const
    const key = accessProviderAccountKey(candidate)
    const published: (number | undefined)[] = []
    const modes: string[] = []
    const held = Promise.withResolvers<void>()
    const snapshots: ProviderModelEligibilityState[] = []
    const unaffected = { kind: "singleton", providerId: "anthropic_api", spendMode: "direct_api" } as const
    const unaffectedKey = accessProviderAccountKey(unaffected)
    const modelId = "claude-sonnet-4.5"
    let revision = { auth: "auth-v1", preferences: "preferences-v1" }
    let fetches = 0
    const listingClient = createModelListingClient({
      classifySlot: credentialSlotClassifier(testCapabilityModules()),
      authDir: PROFILE.directory,
      oauthPersistence: "access-only",
      providers: createAccessProviderSelection(testProviderSelection().definitions.map((definition) =>
        definition.id !== "anthropic_api" || definition.dynamicCatalog === undefined ? definition : {
          ...definition,
          dynamicCatalog: {
            ...definition.dynamicCatalog,
            fetch: async ({ credential }) => {
              fetches += 1
              return { credential, discovery: { kind: "failed", reason: "transport" } }
            },
          },
        })),
      modelsClient: {
        refresh: async () => {},
        getTokenizerIdentity: () => undefined,
        getProviderCatalog: (providers) => providers.includes("anthropic") ? [{
          providerId: "anthropic", providerName: "Anthropic", wireModelId: modelId,
          metadata: modelInfo("anthropic", modelId, "anthropic", 1, 2, "2026-01-01"),
          provenance: "bundled" as const,
          canonical: { providerId: "anthropic", modelId },
          transport: { npm: "@ai-sdk/anthropic" },
        }] : [],
      },
    })
    let remaining = 2
    const audited = Promise.withResolvers<void>()
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]),
      prepare: service.prepare,
      publish: (state) => {
        published.push(state.inventoryCandidates.get(key)?.audit?.remaining)
        snapshots.push(state)
        service.publish(state)
      },
      current: service.state,
      inputRevision: () => revision,
      apply: async () => { audited.resolve() },
      resolveAuth: async () => testAuthContext({ apiKeys: { anthropic_api: revision.auth }, credentialLineages: { anthropic_api: revision.auth } }),
      resolveCatalog: async (deps) => {
        const { discoveryMode, onAccessAudit } = deps
        modes.push(discoveryMode ?? "missing")
        if (discoveryMode === "audit") {
          await held.promise
          for (const auditedModelId of ["grok-a", "grok-b"].slice(2 - remaining)) {
            remaining -= 1
            if (remaining === 0) expect(published).toContain(1)
            await onAccessAudit?.({ account: candidate, remaining, modelId: auditedModelId, outcome: "completed" })
          }
        }
        const resolved = await resolveProviderModelCatalog({ ...deps, listingClient })
        const verified = ["grok-a", "grok-b"].slice(0, 2 - remaining)
        const offerings = new Map(verified.map((id) => [id, [{ wireModelId: id, metadata: null, dataUse: "standard" as const }]]))
        const models: ResolvedProviderModels = { catalog: new Set(verified), curatedDefault: new Set(verified), enabled: new Set(), disabled: new Set(), effective: new Set(verified) }
        return {
          ...resolved,
          providers: new Map([...resolved.providers, ["supergrok", models]]),
          accounts: new Map([...resolved.accounts, [key, models]]),
          inventoryCandidates: new Map([...resolved.inventoryCandidates, [key, {
            candidate, configured: true, currentConnection: true, enabledOfferings: offerings, inventoryOfferings: offerings,
            ...(remaining === 2 ? { outcome: { kind: "unavailable" as const, reason: "discovery-pending" as const } } : {}),
            audit: { remaining, refused: 0 },
            verifiedModelIds: new Set(verified),
          }]]),
        }
      },
    })

    await prepare(PROFILE, { mode: "fresh" })
    expect(modes).toEqual(["fresh"])
    expect(snapshots[0]?.picker.has(modelId)).toBe(true)
    expect(snapshots[0]?.inventoryCandidates.get(unaffectedKey)?.catalog).toEqual({ kind: "available", provenance: "models-dev-bundled", liveOutcome: "discovery-failed" })
    if (changed !== "unchanged") revision = { ...revision, [changed]: `${changed}-v2` }
    held.resolve()
    // The audit is background work, so its end is observed where it reaches sessions.
    await audited.promise
    expect(fetches).toBe(1)
    expect(modes.filter((mode) => mode === "fresh" || mode === "refresh")).toEqual(["fresh"])
    expect(published).toContain(1)
    expect(published[0]).toBe(2)
    expect(published.at(-1)).toBe(0)
    for (const state of snapshots.slice(1)) {
      const admitted = changed === "unchanged"
      const verified = 2 - (state.inventoryCandidates.get(key)?.audit?.remaining ?? 2)
      for (const [index, id] of ["grok-a", "grok-b"].entries()) {
        expect(state.picker.has(id)).toBe(index < verified)
        expect(state.worker.candidateOffering?.(candidate, id, false) !== undefined).toBe(index < verified)
      }
      expect(state.picker.has(modelId)).toBe(admitted)
      expect(state.catalogs.get("anthropic_api")?.effective.has(modelId)).toBe(admitted)
      expect(state.worker.candidateOffering?.(unaffected, modelId, false) !== undefined).toBe(admitted)
      if (admitted) {
        expect(state.picker.get(modelId)).toEqual(snapshots[0]?.picker.get(modelId))
        expect(state.accountCatalogs.get(unaffectedKey)?.effective.has(modelId)).toBe(true)
        expect(state.releaseDates.get(modelId)).toBe("2026-01-01")
      }
    }
    await prepare.dispose()
    await service.dispose()
  })

  test("a free-plan account serves only alone, and a reading that changes a plan republishes once (PI-MODEL-038)", async () => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
    const harness = freePlanHarness(service, ["paid", "free"])
    harness.plans.set("free", "free").set("paid", "pro")

    const beside = await harness.prepare(PROFILE, { mode: "fresh" })
    const paid = harness.candidate("paid")
    const free = harness.candidate("free")
    expect(beside.worker.candidateOffering?.(paid, "gpt-a", false)?.wireModelId).toBe("gpt-a")
    expect(beside.worker.candidateOffering?.(free, "gpt-a", false)).toBeUndefined()
    expect(beside.worker.candidateModelUnavailableReason?.(free, "gpt-a")).toContain("only paid accounts rotate")

    // A usage publication that changes no plan publishes nothing, and one that cannot read the plan keeps the mark.
    const published = harness.publications()
    await harness.prepare.reconcileFreePlans(PROFILE, harness.publication({ paid: "pro", free: "free" }))
    await harness.prepare.reconcileFreePlans(PROFILE, harness.publication({ paid: "pro" }))
    expect(harness.publications()).toBe(published)

    // A preparation that cannot read the plan of the same identity keeps the mark.
    harness.plans.delete("free")
    const unread = await harness.prepare(PROFILE, { mode: "fresh" })
    expect(unread.worker.candidateOffering?.(free, "gpt-a", false)).toBeUndefined()

    // The plan turns paid: the account serves again beside its sibling.
    const beforePaid = harness.publications()
    await harness.prepare.reconcileFreePlans(PROFILE, harness.publication({ paid: "pro", free: "plus" }))
    expect(harness.publications()).toBe(beforePaid + 1)
    expect(service.state(PROFILE.id)?.worker.candidateOffering?.(free, "gpt-a", false)?.wireModelId).toBe("gpt-a")

    // The idle account reconnects as another identity whose plan is not read yet: the mark of the identity it
    // replaced does not follow it, and a publication that does not read the new identity leaves it serving.
    await harness.prepare.reconcileFreePlans(PROFILE, harness.publication({ paid: "pro", free: "free" }))
    expect(service.state(PROFILE.id)?.worker.candidateOffering?.(free, "gpt-a", false)).toBeUndefined()
    harness.plans.set("free", "free")
    harness.identities.set("free", "someone-else@example.com")
    const reconnected = await harness.prepare(PROFILE, { mode: "fresh" })
    expect(reconnected.worker.candidateOffering?.(free, "gpt-a", false)?.wireModelId).toBe("gpt-a")
    await harness.prepare.reconcileFreePlans(PROFILE, harness.publication({ paid: "pro" }))
    expect(service.state(PROFILE.id)?.worker.candidateOffering?.(free, "gpt-a", false)?.wireModelId).toBe("gpt-a")

    // A free-plan account alone in the profile serves, and the usage authority is never opened.
    harness.identities.delete("free")
    harness.accounts.splice(0, 1)
    const opened = harness.opened()
    const alone = await harness.prepare(PROFILE, { mode: "fresh" })
    expect(alone.worker.candidateOffering?.(free, "gpt-a", false)?.wireModelId).toBe("gpt-a")
    expect(harness.opened()).toBe(opened)
    await harness.prepare.dispose()
    await service.dispose()
  })

  test("a usage publication reconciles free-plan accounts without a durable read, for any number of accounts (PI-MODEL-038)", async () => {
    for (const members of [2, 12]) {
      const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
      const ids = Array.from({ length: members }, (_, index) => `account-${index}`)
      const harness = freePlanHarness(service, ids)
      await harness.prepare(PROFILE, { mode: "fresh" })
      harness.counter.take()
      const opened = harness.opened()
      for (let change = 0; change < 3; change += 1) {
        await harness.prepare.reconcileFreePlans(PROFILE, harness.publication(Object.fromEntries(ids.map((id, index) => [id, index === 0 && change % 2 === 1 ? "free" : "plus"]))))
      }
      expect(harness.opened()).toBe(opened)
      expect(harness.counter.take()).toEqual([])
      await harness.prepare.dispose()
      await service.dispose()
    }
  })

  test("a manual recheck queues an exact-account audit inside the cooldown, supersedes an active audit, and drops when its inputs changed, and a refused model audits after every discovery", async () => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
    const candidate = { kind: "subscription", providerId: "supergrok", instanceId: "primary", spendMode: "included" } as const
    const key = accessProviderAccountKey(candidate)
    let auth = "auth-v1"
    const revision = () => ({ auth, preferences: "preferences-v1" })
    const modes: string[] = []
    const rechecks: (string | undefined)[] = []
    let refused = 0
    let holdAudit = false
    /** Held by the next listing only. */
    let listingHold: Promise<void> | undefined
    let entered = Promise.withResolvers<void>()
    let published = Promise.withResolvers<void>()
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]),
      prepare: service.prepare,
      publish: (state) => { service.publish(state); published.resolve() },
      current: service.state,
      inputRevision: revision,
      resolveAuth: async () => testAuthContext(),
      now: () => 0,
      resolveCatalog: async ({ discoveryMode, recheckAccount, signal }) => {
        modes.push(discoveryMode ?? "missing")
        if (discoveryMode === "fresh" && listingHold !== undefined) {
          const held = listingHold
          listingHold = undefined
          await held
        }
        if (discoveryMode === "audit") {
          rechecks.push(recheckAccount === undefined ? undefined : accessProviderAccountKey(recheckAccount))
          if (holdAudit) {
            entered.resolve()
            await new Promise<never>((_, reject) => { signal?.addEventListener("abort", () => reject(signal.reason), { once: true }) })
          }
        }
        const models: ResolvedProviderModels = { catalog: new Set(), curatedDefault: new Set(), enabled: new Set(), disabled: new Set(), effective: new Set() }
        return {
          providers: new Map(),
          accounts: new Map([[key, models]]),
          inventoryCandidates: new Map([[key, {
            candidate, configured: true, currentConnection: true, enabledOfferings: new Map(), inventoryOfferings: new Map(),
            outcome: { kind: "unavailable" as const, reason: "discovery-pending" as const },
            audit: { remaining: 0, refused },
          }]]),
          modelInfos: new Map(),
          enabledModels: new Map(),
        }
      },
    })

    // Nothing is due or refused, so only a manual recheck audits; the fresh listing's own hold does not delay it.
    await prepare(PROFILE, { mode: "fresh" })
    published = Promise.withResolvers()
    prepare.recheckAccount(PROFILE, candidate, revision())
    await published.promise
    expect(modes).toEqual(["fresh", "audit"])
    expect(rechecks).toEqual([key])

    // A request against inputs that already changed is refused before any work is queued.
    expect(() => prepare.recheckAccount(PROFILE, candidate, { auth: "auth-old", preferences: "preferences-v1" })).toThrow("stale")
    expect(rechecks).toEqual([key])

    // A recheck supersedes the active audit and runs after it.
    holdAudit = true
    prepare.recheckAccount(PROFILE, candidate, revision())
    await entered.promise
    published = Promise.withResolvers()
    prepare.recheckAccount(PROFILE, candidate, revision())
    holdAudit = false
    await published.promise
    expect(rechecks).toEqual([key, key, key])

    // A forced run supersedes a recheck that waits behind a listing before its audit started, so the recheck
    // queues again behind the forced run instead of being lost.
    const listing = Promise.withResolvers<void>()
    listingHold = listing.promise
    const login = prepare(PROFILE, { mode: "fresh" })
    prepare.recheckAccount(PROFILE, candidate, revision())
    const relogin = prepare(PROFILE, { mode: "fresh" })
    listing.resolve()
    await Promise.all([login, relogin])
    await prepare.awaitDiscovery(PROFILE, new AbortController().signal)
    expect(modes.slice(-3)).toEqual(["fresh", "fresh", "audit"])
    expect(rechecks).toEqual([key, key, key, key])

    // Queued work whose inputs changed before it started writes, publishes, and probes nothing.
    holdAudit = true
    entered = Promise.withResolvers()
    prepare.recheckAccount(PROFILE, candidate, revision())
    await entered.promise
    prepare.recheckAccount(PROFILE, candidate, revision())
    auth = "auth-v2"
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(rechecks).toEqual([key, key, key, key, key])

    // A refused model is checked again after every discovery, with no manual recheck (PI-MODEL-084).
    holdAudit = false
    refused = 1
    await prepare(PROFILE, { mode: "fresh" })
    await prepare.awaitDiscovery(PROFILE, new AbortController().signal)
    expect(modes.slice(-2)).toEqual(["fresh", "audit"])
    expect(rechecks.at(-1)).toBeUndefined()
    await prepare.dispose()
    await service.dispose()
  })
})

/** An eligibility preparation over ChatGPT accounts named by `ids`, whose usage authority holds the plan in `plans`
 *  for each account's current identity, which is `<id>@example.com` unless `identities` names another. */
function freePlanHarness(service: ReturnType<typeof createProviderModelPreferenceService>, ids: readonly string[]) {
  const accounts = [...ids]
  const plans = new Map<string, string>()
  const identities = new Map<string, string>()
  const identity = (id: string) => identities.get(id) ?? `${id}@example.com`
  const candidate = (instanceId: string) => ({ kind: "subscription", providerId: "chatgpt", instanceId, spendMode: "included" }) as const
  const offerings = new Map([["gpt-a", [{ wireModelId: "gpt-a", metadata: null, dataUse: "standard" as const }]]])
  const models: ResolvedProviderModels = { catalog: new Set(["gpt-a"]), curatedDefault: new Set(["gpt-a"]), enabled: new Set(), disabled: new Set(), effective: new Set(["gpt-a"]) }
  const snapshot = (instanceId: string, plan: string) => ({ providerId: "chatgpt", instanceId, subjectDigest: identity(instanceId), plan, providerStatus: "ok" as const, observedAtMs: 1, readerGeneration: 1, metrics: [], spendSources: [] })
  // Readings are stored by the identity that was read, as the usage authority keys them.
  const counter = countStateRequests({
    current: (account: { readonly instanceId: string; readonly identity?: string }) => {
      const plan = plans.get(account.instanceId)
      return plan === undefined || account.identity !== `${account.instanceId}@example.com` ? undefined : snapshot(account.instanceId, plan)
    },
    dispose: () => {},
  })
  let opened = 0
  let publications = 0
  const prepare = createEligibilityPreparation({
    allowTrainingRoutes: () => false,
    userDataRoot: DIRECTORIES.userDataRoot,
    resolveKey: async () => undefined,
    moduleSelection: () => testCapabilityModules(),
    prepare: service.prepare,
    publish: (state) => { publications += 1; service.publish(state) },
    current: service.state,
    inputRevision: () => ({ auth: `auth-${accounts.join(",")}-${[...identities.values()].join(",")}`, preferences: "preferences-v1" }),
    resolveAuth: async () => ({
      ...testAuthContext(),
      subscriptionCredentials: new Map([["chatgpt", accounts.map((instanceId) => ({ instanceId, identity: identity(instanceId), credential: { type: "oauth" as const, access: Redacted.make("at"), expires: 0 } }))]]),
    }),
    openUsage: () => { opened += 1; return counter.reader },
    resolveCatalog: async () => ({
      providers: new Map([["chatgpt", models]]),
      accounts: new Map(accounts.map((id) => [accessProviderAccountKey(candidate(id)), models])),
      inventoryCandidates: new Map(accounts.map((id) => [accessProviderAccountKey(candidate(id)), { candidate: candidate(id), configured: true, currentConnection: true, enabledOfferings: offerings, inventoryOfferings: offerings }])),
      modelInfos: new Map(),
      enabledModels: new Map(),
    }),
  })
  return {
    prepare, plans, identities, accounts, counter,
    candidate,
    publications: () => publications,
    opened: () => opened,
    /** A usage publication that read the named accounts' plans; an account it does not name was not read. */
    publication: (read: { readonly [instanceId: string]: string }): SubscriptionUsagePublishedSnapshot => ({
      generation: 1, profileId: PROFILE.id, profileDirectory: PROFILE.directory, checkedAtMs: 1, thresholds: [],
      accounts: accounts.map((id) => {
        const account = { providerId: "chatgpt", instanceId: id, identity: identity(id) }
        const plan = read[id]
        return plan === undefined ? { kind: "identity-unavailable" as const, account } : { kind: "supported" as const, account, snapshot: snapshot(id, plan) }
      }),
    }),
  }
}

import { describe, expect, test } from "bun:test"
import { Redacted } from "effect"
import type { AuthContext, RuntimeCredential } from "../../../../src/infra/auth/auth-context.js"
import { accessProviderAccountKey, createAccessProviderSelection, type AccessProviderCandidate, type AccessProviderDefinition } from "../../../../src/infra/llm/access-provider.js"
import type { CatalogCanonicalRow, CatalogModelOffering } from "../../../../src/infra/llm/model-catalog-resolution.js"
import { authProviders } from "../../../helpers/auth-context.js"
import {
  providerModelEligibilityDecision,
  providerModelsCanServeRequest,
  workerProviderModelEligibilityFromState,
  type ProviderModelEnabledCandidate,
} from "../../../../src/orchestration/config/provider-model-eligibility.js"

const standard = (wireModelId: string, metadata: CatalogCanonicalRow["offerings"][number]["metadata"] = null) =>
  [Object.freeze({ wireModelId, metadata, dataUse: "standard" as const })]
const candidateState = (
  candidate: AccessProviderCandidate,
  offerings: readonly CatalogModelOffering[],
  provenance: "models-dev-live" | "models-dev-bundled" | "static",
  preferFreeRoutes = false,
): ProviderModelEnabledCandidate => {
  const models = new Map([["model", offerings]])
  return { candidate, configured: true, currentConnection: true, enabledOfferings: models, catalog: { kind: "available", provenance, liveOutcome: "valid" }, preferFreeRoutes }
}

describe("worker provider model eligibility", () => {
  test("prefers a standard offering within each exact candidate", () => {
    const first: AccessProviderCandidate = { kind: "subscription", providerId: "subscription", instanceId: "first", spendMode: "included" }
    const second: AccessProviderCandidate = { kind: "singleton", providerId: "api", spendMode: "direct_api" }
    const eligibility = workerProviderModelEligibilityFromState({
      profileId: "work",
      catalogs: new Map([
        ["subscription", { effective: new Set(["model"]), enabled: new Set(["model"]) }],
        ["api", { effective: new Set(["model"]), enabled: new Set(["model"]) }],
      ]),
      enabledCandidates: new Map([
        [accessProviderAccountKey(first), candidateState(first, [{ wireModelId: "model-contributor", metadata: { source: "first-contributor" }, dataUse: "contributor" }, { wireModelId: "model-standard", metadata: { source: "first-standard" }, dataUse: "standard" }], "models-dev-live")],
        [accessProviderAccountKey(second), candidateState(second, [{ wireModelId: "api-standard", metadata: { source: "api" }, dataUse: "standard" }], "models-dev-bundled")],
      ]),
    })

    expect(eligibility.candidateOffering?.(first, "model", true)).toEqual({
      candidate: first,
      wireModelId: "model-standard",
      dataUse: "standard",
      catalogMetadata: { source: "first-standard" },
      catalogProvenance: "live",
    })
    expect(eligibility.candidateOffering?.(second, "model", true)?.wireModelId).toBe("api-standard")
  })

  test("admits contributor-only offerings only when training routes are allowed", () => {
    const subscription: AccessProviderCandidate = { kind: "subscription", providerId: "subscription", instanceId: "first", spendMode: "included" }
    const api: AccessProviderCandidate = { kind: "singleton", providerId: "api", spendMode: "direct_api" }
    const eligibility = workerProviderModelEligibilityFromState({
      profileId: "work",
      catalogs: new Map([
        ["subscription", { effective: new Set(["model"]), enabled: new Set(["model"]) }],
        ["api", { effective: new Set(["model"]), enabled: new Set(["model"]) }],
      ]),
      enabledCandidates: new Map([
        [accessProviderAccountKey(subscription), candidateState(subscription, [{ wireModelId: "subscription-contributor", metadata: null, dataUse: "contributor" }], "models-dev-live")],
        [accessProviderAccountKey(api), candidateState(api, [{ wireModelId: "api-standard", metadata: null, dataUse: "standard" }], "static")],
      ]),
    })

    expect(eligibility.candidateOffering?.(subscription, "model", false)).toBeUndefined()
    expect(eligibility.candidateOffering?.(subscription, "model", true)?.wireModelId).toBe("subscription-contributor")
    expect(eligibility.candidateOffering?.(api, "model", false)?.wireModelId).toBe("api-standard")
  })

  test("keeps free routes out by default and prefers them before the paid sibling when enabled", () => {
    const openrouter: AccessProviderCandidate = { kind: "singleton", providerId: "openrouter", spendMode: "aggregator" }
    const offerings: readonly CatalogModelOffering[] = [
      { wireModelId: "vendor/model", metadata: null, dataUse: "standard" },
      { wireModelId: "vendor/model:free", metadata: null, dataUse: "standard", routeKind: "free" },
    ]
    const decision = (preferFreeRoutes: boolean) => workerProviderModelEligibilityFromState({
      catalogs: new Map([["openrouter", { effective: new Set(["model"]), enabled: new Set(["model"]) }]]),
      enabledCandidates: new Map([[accessProviderAccountKey(openrouter), candidateState(openrouter, offerings, "models-dev-live", preferFreeRoutes)]]),
    })

    expect(decision(false).candidateOfferings?.(openrouter, "model", false).map(({ wireModelId }) => wireModelId)).toEqual(["vendor/model"])
    expect(decision(true).candidateOfferings?.(openrouter, "model", false).map(({ wireModelId }) => wireModelId)).toEqual(["vendor/model:free", "vendor/model"])
  })

  test("keeps contributor-only fallback independent from the free-route preference", () => {
    const openrouter: AccessProviderCandidate = { kind: "singleton", providerId: "openrouter", spendMode: "aggregator" }
    const pending: AccessProviderCandidate = { kind: "singleton", providerId: "pending", spendMode: "direct_api" }
    const contributor = { wireModelId: "vendor/model-contributor", metadata: null, dataUse: "contributor" as const }
    const decision = (preferFreeRoutes: boolean) => workerProviderModelEligibilityFromState({
      catalogs: new Map([["openrouter", { effective: new Set(["model"]), enabled: new Set(["model"]) }]]),
      enabledCandidates: new Map([
        [accessProviderAccountKey(openrouter), candidateState(openrouter, [contributor], "models-dev-live", preferFreeRoutes)],
        [accessProviderAccountKey(pending), { candidate: pending, configured: true, currentConnection: true, enabledOfferings: new Map(), catalog: { kind: "unavailable", reason: "discovery-pending" } }],
      ]),
    })

    expect(decision(false).candidateOfferings?.(openrouter, "model", true).map(({ wireModelId }) => wireModelId)).toEqual(["vendor/model-contributor"])
    expect(decision(true).candidateOfferings?.(openrouter, "model", true).map(({ wireModelId }) => wireModelId)).toEqual(["vendor/model-contributor"])
    expect(decision(true).candidateOfferings?.(openrouter, "model", false)).toEqual([])
    expect(decision(false).accessPending?.(false)).toBe(true)
    expect(decision(false).accessPending?.(true)).toBe(false)
  })

  test("builds a profile-bound and account-bound eligibility predicate", () => {
    const eligibility = workerProviderModelEligibilityFromState({
      profileId: "work",
      catalogs: new Map([
        ["github_copilot", { effective: new Set(["gpt-a", "gpt-b"]), enabled: new Set(["gpt-a", "gpt-b"]) }],
      ]),
      enabledCandidates: new Map([
        [accessProviderAccountKey({ kind: "subscription", providerId: "github_copilot", instanceId: "account-a", spendMode: "included" }), {
          candidate: { kind: "subscription", providerId: "github_copilot", instanceId: "account-a", spendMode: "included" },
          configured: true,
          currentConnection: true,
          enabledOfferings: new Map([["gpt-a", standard("gpt-a")]]),
          catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" },
        }],
        [accessProviderAccountKey({ kind: "subscription", providerId: "github_copilot", instanceId: "account-b", spendMode: "included" }), {
          candidate: { kind: "subscription", providerId: "github_copilot", instanceId: "account-b", spendMode: "included" },
          configured: true,
          currentConnection: true,
          enabledOfferings: new Map([["gpt-b", standard("gpt-b")]]),
          catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" },
        }],
      ]),
    })

    expect(eligibility.profileId).toBe("work")
    expect(eligibility.modelUnavailableReason("github_copilot", "gpt-a")).toBeUndefined()
    expect(eligibility.candidateModelUnavailableReason?.({ kind: "subscription", providerId: "github_copilot", instanceId: "account-a", spendMode: "included" }, "gpt-a")).toBeUndefined()
    expect(eligibility.candidateModelUnavailableReason?.({ kind: "subscription", providerId: "github_copilot", instanceId: "account-b", spendMode: "included" }, "gpt-a")).toContain("cannot serve")
  })

  test("refuses an idle free-plan account and keeps its paid sibling serving (PI-MODEL-038)", () => {
    const paid: AccessProviderCandidate = { kind: "subscription", providerId: "chatgpt", instanceId: "paid", spendMode: "included" }
    const free: AccessProviderCandidate = { kind: "subscription", providerId: "chatgpt", instanceId: "free", spendMode: "included" }
    const idle: ProviderModelEnabledCandidate = { ...candidateState(free, standard("model"), "models-dev-live"), idleFreePlan: {} }
    const enabledCandidates = new Map([
      [accessProviderAccountKey(paid), candidateState(paid, standard("model"), "models-dev-live")],
      [accessProviderAccountKey(free), idle],
    ])
    const eligibility = workerProviderModelEligibilityFromState({ profileId: "work", catalogs: new Map([["chatgpt", { effective: new Set(["model"]), enabled: new Set(["model"]) }]]), enabledCandidates })

    expect(eligibility.candidateModelUnavailableReason?.(paid, "model")).toBeUndefined()
    expect(eligibility.candidateModelUnavailableReason?.(free, "model")).toContain("only paid accounts rotate")
    expect(providerModelsCanServeRequest([idle], false)).toBe(false)
  })

  test("separates provenance-aware picker evidence from exact runtime admission", () => {
    const decision = providerModelEligibilityDecision({
      profileId: "work",
      revision: 7,
      catalogs: new Map([
        ["github_copilot", { effective: new Set(["gpt-live", "gpt-lkg"]), enabled: new Set(["gpt-live"]) }],
      ]),
      enabledCandidates: new Map([
        [accessProviderAccountKey({ kind: "subscription", providerId: "github_copilot", instanceId: "current", spendMode: "included" }), {
          candidate: { kind: "subscription", providerId: "github_copilot", instanceId: "current", spendMode: "included" },
          configured: true,
          currentConnection: true,
          enabledOfferings: new Map([["gpt-live", standard("wire-gpt-live")]]),
          catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" },
        }],
        [accessProviderAccountKey({ kind: "subscription", providerId: "github_copilot", instanceId: "removed", spendMode: "included" }), {
          candidate: { kind: "subscription", providerId: "github_copilot", instanceId: "removed", spendMode: "included" },
          configured: true,
          currentConnection: false,
          enabledOfferings: new Map([["gpt-lkg", standard("gpt-lkg")]]),
          catalog: { kind: "available", provenance: "models-dev-archive", liveOutcome: "discovery-failed" },
        }],
      ]),
    })

    expect(decision.profileId).toBe("work")
    expect(decision.revision).toBe(7)
    expect(decision.picker.get("gpt-live")).toEqual(expect.objectContaining({ explicitlyEnabled: true, catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" } }))
    expect(decision.picker.has("gpt-lkg")).toBe(false)
    expect(decision.worker.candidateModelUnavailableReason?.({ kind: "subscription", providerId: "github_copilot", instanceId: "removed", spendMode: "included" }, "gpt-lkg")).toContain("current connection")
    expect(decision.worker.candidateOffering?.({ kind: "subscription", providerId: "github_copilot", instanceId: "current", spendMode: "included" }, "gpt-live", false)?.wireModelId).toBe("wire-gpt-live")
    expect(decision.enabledCandidates.get(accessProviderAccountKey({ kind: "subscription", providerId: "github_copilot", instanceId: "removed", spendMode: "included" }))?.catalog).toEqual({ kind: "available", provenance: "models-dev-archive", liveOutcome: "discovery-failed" })
  })

  test("preserves explicit picker provenance for contributor-only models", () => {
    const candidate: AccessProviderCandidate = { kind: "subscription", providerId: "opencode_go", instanceId: "account", spendMode: "included" }
    const contributor = [{ wireModelId: "muse-1.3-contributor", metadata: null, dataUse: "contributor" as const }]
    const decision = providerModelEligibilityDecision({
      profileId: "work",
      revision: 8,
      catalogs: new Map([["opencode_go", { effective: new Set(["muse-1.3"]), enabled: new Set(["muse-1.3"]) }]]),
      enabledCandidates: new Map([[accessProviderAccountKey(candidate), {
        candidate,
        configured: true,
        currentConnection: true,
        enabledOfferings: new Map([["muse-1.3", contributor]]),
        catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" },
      }]]),
    })

    expect(decision.picker.get("muse-1.3")).toEqual(expect.objectContaining({
      explicitlyEnabled: true,
    }))
    expect(decision.worker.candidateOffering?.(candidate, "muse-1.3", false)).toBeUndefined()
    expect(decision.worker.candidateOffering?.(candidate, "muse-1.3", true)?.wireModelId).toBe("muse-1.3-contributor")
  })

  test("consolidates Fable identity while retaining each provider wire id", () => {
    const anthropic: AccessProviderCandidate = { kind: "singleton", providerId: "anthropic_api", spendMode: "direct_api" }
    const openrouter: AccessProviderCandidate = { kind: "singleton", providerId: "openrouter", spendMode: "aggregator" }
    const canonical = "claude-fable-5.1"
    const available = { kind: "available", provenance: "first-party", liveOutcome: "valid" } as const
    const decision = providerModelEligibilityDecision({
      profileId: "work",
      revision: 8,
      catalogs: new Map([
        [anthropic.providerId, { effective: new Set([canonical]), enabled: new Set([canonical]) }],
        [openrouter.providerId, { effective: new Set([canonical]), enabled: new Set([canonical]) }],
      ]),
      enabledCandidates: new Map([
        [accessProviderAccountKey(anthropic), { candidate: anthropic, configured: true, currentConnection: true, enabledOfferings: new Map([[canonical, standard("claude-fable-5-1")]]), catalog: available }],
        [accessProviderAccountKey(openrouter), { candidate: openrouter, configured: true, currentConnection: true, enabledOfferings: new Map([[canonical, standard("anthropic/claude-fable-5.1")]]), catalog: available }],
      ]),
    })

    expect([...decision.picker.keys()]).toEqual([canonical])
    expect(decision.worker.candidateOffering?.(anthropic, canonical, false)?.wireModelId).toBe("claude-fable-5-1")
    expect(decision.worker.candidateOffering?.(openrouter, canonical, false)?.wireModelId).toBe("anthropic/claude-fable-5.1")
  })

  test("isolates exact-account decisions and derives provider availability as their union", () => {
    const accountA: AccessProviderCandidate = { kind: "subscription", providerId: "github_copilot", instanceId: "account-a", spendMode: "included" }
    const accountB: AccessProviderCandidate = { kind: "subscription", providerId: "github_copilot", instanceId: "account-b", spendMode: "included" }
    const decision = providerModelEligibilityDecision({
      profileId: "work",
      revision: 9,
      catalogs: new Map([["github_copilot", { effective: new Set(["gpt-x"]), enabled: new Set(["gpt-x"]) }]]),
      enabledCandidates: new Map([
        [accessProviderAccountKey(accountA), { candidate: accountA, configured: true, currentConnection: true, enabledOfferings: new Map([["gpt-x", standard("gpt-x")]]), catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" } }],
        [accessProviderAccountKey(accountB), { candidate: accountB, configured: true, currentConnection: true, enabledOfferings: new Map(), catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" } }],
      ]),
    })

    expect(decision.worker.candidateModelUnavailableReason?.(accountA, "gpt-x")).toBeUndefined()
    expect(decision.worker.candidateModelUnavailableReason?.(accountB, "gpt-x")).toContain("cannot serve")
    expect(decision.worker.modelUnavailableReason("github_copilot", "gpt-x")).toBeUndefined()
    expect(decision.availability.get("github_copilot")?.has("gpt-x")).toBe(true)
    expect(decision.picker.get("gpt-x")).toEqual(expect.objectContaining({ explicitlyEnabled: true, catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" } }))
  })

  test("binds immutable metadata and provenance to the exact provider and account attribution", () => {
    const model = "gpt-5.4"
    const providerA: AccessProviderCandidate = { kind: "singleton", providerId: "provider-a", spendMode: "direct_api" }
    const providerB: AccessProviderCandidate = { kind: "subscription", providerId: "provider-b", instanceId: "account-b", spendMode: "included" }
    const sibling: AccessProviderCandidate = { ...providerB, instanceId: "account-c" }
    const rowA = Object.freeze({ modelId: model, offerings: standard("wire-a", Object.freeze({ price: 1 })) })
    const rowB = Object.freeze({ modelId: model, offerings: standard("wire-b", Object.freeze({ price: 2 })) })
    const providerBRows = new Map<string, CatalogCanonicalRow>([[model, rowB]])
    const decision = providerModelEligibilityDecision({
      profileId: "profile",
      revision: 11,
      catalogs: new Map([
        [providerA.providerId, { effective: new Set([model]), enabled: new Set([model]) }],
        [providerB.providerId, { effective: new Set([model]), enabled: new Set([model]) }],
      ]),
      enabledCandidates: new Map([
        [accessProviderAccountKey(providerA), { candidate: providerA, configured: true, currentConnection: true, enabledOfferings: new Map([[model, rowA.offerings]]), catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" } }],
        [accessProviderAccountKey(providerB), { candidate: providerB, configured: true, currentConnection: true, enabledOfferings: new Map([[model, rowB.offerings]]), catalog: { kind: "available", provenance: "models-dev-archive", liveOutcome: "discovery-failed" } }],
      ]),
    })
    const definitions: AccessProviderDefinition[] = [
      { id: "provider-a", displayName: "A", shortName: "A", rank: 1, supportedFamilies: ["openai"], defaultChatTransport: "openai-responses", configHints: [], catalogId: undefined, auth: { kind: "api_key", statusRank: 1 }, cli: { name: "test" }, staticModelUnavailableReason: () => undefined, billing: "metered", spendMode: "direct_api" },
      { id: "provider-b", displayName: "B", shortName: "B", rank: 2, supportedFamilies: ["openai"], defaultChatTransport: "openai-responses", configHints: [], catalogId: undefined, auth: { kind: "api_key", statusRank: 1 }, cli: { name: "test" }, staticModelUnavailableReason: () => undefined, billing: "subscription" },
    ]
    providerBRows.set(model, Object.freeze({ modelId: model, offerings: standard("wire-b", Object.freeze({ price: 99 })) }))
    const auth: AuthContext = {
      providers: authProviders({ apiKeys: { "provider-a": "test-key" } }),
      credentialLineages: {},
      droppedCredentials: [],
    }
    const credential: RuntimeCredential = { type: "api_key", key: Redacted.make("test-key") }
    const plan = createAccessProviderSelection(definitions).plan(model, {
      id: "connection",
      profileId: "profile",
      authDir: "/unused",
      auth,
      subscriptionCredentials: new Map([["provider-b", [{ instanceId: "account-b", credential }, { instanceId: "account-c", credential }]]]),
      oauthPersistence: "profile",
    }, decision.worker)
    if (plan.kind !== "admitted") throw new Error(plan.reason)

    expect(plan.candidateAttributions.filter(({ candidate }) => candidate.spendMode === "included" || candidate.kind === "singleton")).toEqual([
      expect.objectContaining({ candidate: providerB, wireModelId: "wire-b", catalogProvenance: "last-known-good", catalogMetadata: rowB.offerings[0]?.metadata, eligibilityProfileId: "profile", eligibilityRevision: 11 }),
      expect.objectContaining({ candidate: providerA, wireModelId: "wire-a", catalogProvenance: "live", catalogMetadata: rowA.offerings[0]?.metadata, eligibilityProfileId: "profile", eligibilityRevision: 11 }),
    ])
    expect(decision.worker.candidateOffering?.(sibling, model, false)).toBeUndefined()
    expect(plan.candidateAttributions[0]?.catalogMetadata).toBe(rowB.offerings[0]?.metadata)
    expect(Object.isFrozen(plan.candidateAttributions[0])).toBe(true)
  })

  test("keeps delimiter-containing candidates distinct for picker and runtime admission", () => {
    const left: AccessProviderCandidate = { kind: "subscription", providerId: "provider:a", instanceId: "account", spendMode: "included" }
    const right: AccessProviderCandidate = { kind: "subscription", providerId: "provider", instanceId: "a:account", spendMode: "included" }
    const available = { kind: "available", provenance: "models-dev-live", liveOutcome: "valid" } as const
    const decision = providerModelEligibilityDecision({
      profileId: "work",
      revision: 8,
      catalogs: new Map([
        [left.providerId, { effective: new Set(["model-left"]), enabled: new Set(["model-left"]) }],
        [right.providerId, { effective: new Set(["model-right"]), enabled: new Set(["model-right"]) }],
      ]),
      enabledCandidates: new Map<string, ProviderModelEnabledCandidate>([
        [accessProviderAccountKey(left), { candidate: left, configured: true, currentConnection: true, enabledOfferings: new Map([["model-left", standard("model-left")]]), catalog: available }],
        [accessProviderAccountKey(right), { candidate: right, configured: true, currentConnection: true, enabledOfferings: new Map([["model-right", standard("model-right")]]), catalog: available }],
      ]),
    })

    expect(decision.enabledCandidates).toHaveLength(2)
    expect(decision.picker.get("model-left")).toEqual(expect.objectContaining({ explicitlyEnabled: true, catalog: available }))
    expect(decision.picker.get("model-right")).toEqual(expect.objectContaining({ explicitlyEnabled: true, catalog: available }))
    expect(decision.worker.candidateModelUnavailableReason?.(left, "model-left")).toBeUndefined()
    expect(decision.worker.candidateModelUnavailableReason?.(right, "model-right")).toBeUndefined()
    expect(decision.worker.candidateModelUnavailableReason?.(left, "model-right")).toContain("cannot serve")
  })
})

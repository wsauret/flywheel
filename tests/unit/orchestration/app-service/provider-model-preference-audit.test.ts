import { expect, test } from "bun:test"
import { accessProviderAccountKey } from "../../../../src/infra/llm/access-provider.js"
import { createProviderModelPreferenceService } from "../../../../src/orchestration/app-service/provider-model-preference-service.js"
import { subscriptionSpendAccountCorrelationId } from "../../../../src/protocol/subscription-spend-consent-protocol-types.js"
import { AuthProfileStore } from "../../../../src/infra/auth/auth-profile-store.js"
import { authStoreRevision } from "../../../../src/infra/auth/auth-store.js"
import { deselectAllProviderModels, providerModelPreferencesRevision, setProviderAutoEnableNewModels, setProviderModelPreference } from "../../../../src/infra/auth/provider-model-preference-store.js"
import { resolveProviderModelCatalog } from "../../../../src/orchestration/config/model-assignment-providers.js"
import { authDir } from "../../../../src/infra/paths.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { testAuthContext } from "../../../helpers/auth-context.js"
import { modelInfo } from "../../../helpers/model-tier-fixtures.js"

const temporaryDirectory = temporaryDirectories()

test("preserves pending selections through policy changes and audit publications without admitting them", async () => {
  const root = temporaryDirectory("pending-preferences-")
  const access = await new AuthProfileStore(root).create("work", "Work")
  const candidate = { kind: "subscription", providerId: "supergrok", instanceId: "primary", spendMode: "included" } as const
  const key = accessProviderAccountKey(candidate)
  const target = { kind: "subscription", providerId: "supergrok", accountCorrelationId: subscriptionSpendAccountCorrelationId("work", "supergrok", "primary") } as const
  const offering = (id: string) => [{
    wireModelId: id, metadata: null, dataUse: "standard" as const, transport: "openai-completions" as const,
    resolvedMetadata: modelInfo("openai", id, id, 1, 2, "2025-01-01"),
  }]
  const visible = new Map(["verified", "pending", "unselected"].map((id) => [id, offering(id)]))
  let verified = new Map([["verified", offering("verified")]])
  const service = createProviderModelPreferenceService({
    displayName: (id) => id,
    allowTrainingRoutes: () => false,
    persist: ({ account, modelId, state, currentAccounts, expectedAuthRevision, expectedPreferenceRevision }) =>
      setProviderModelPreference(access, account, modelId, state, currentAccounts, expectedAuthRevision, expectedPreferenceRevision),
    persistAllDeselected: ({ account, modelIds, currentAccounts, expectedAuthRevision, expectedPreferenceRevision }) =>
      deselectAllProviderModels(access, account, modelIds, currentAccounts, expectedAuthRevision, expectedPreferenceRevision),
    persistAutoEnableNewModels: ({ enabled, accountCatalogs, currentAccounts, expectedAuthRevision, expectedPreferenceRevision }) =>
      setProviderAutoEnableNewModels(access, enabled, accountCatalogs, currentAccounts, expectedAuthRevision, expectedPreferenceRevision),
  })
  const refresh = async () => {
    const resolved = await resolveProviderModelCatalog({
      userDataRoot: root, authDirectory: () => authDir(root, "work"), auth: testAuthContext(),
      listingClient: { recordModelRefusal: async () => false, async getModelCatalogs() {
        return { providers: new Map([["supergrok", new Set(verified.keys())]]), candidates: new Map([[key, {
          candidate, models: verified, visibleModels: visible, audit: { remaining: visible.size - verified.size, refused: 0 },
          outcome: { kind: "catalog" as const, provenance: "models-dev-bundled" as const, liveOutcome: "valid" as const, rows: [] },
        }]]) }
      } },
    })
    service.publish(service.prepare({
      profileId: "work", autoEnableNewModels: resolved.autoEnableNewModels,
      authRevision: authStoreRevision(access), preferenceRevision: providerModelPreferencesRevision(access),
      catalogs: resolved.providers, accountCatalogs: resolved.accounts,
      inventoryCandidates: new Map([...resolved.inventoryCandidates].map(([id, entry]) => [id, {
        ...entry, catalog: { kind: "available" as const, provenance: "models-dev-bundled" as const, liveOutcome: "valid" as const },
      }])), releaseDates: new Map(),
    }))
  }
  const mutation = () => ({ queriedProfileId: "work", queriedEligibilityRevision: service.state("work")!.revision })
  const assertPending = async (checked: boolean) => {
    expect((await service.query("work", target)).rows.find((row) => row.modelId === "pending")).toMatchObject({ checked, optInAvailable: true })
    expect(service.state("work")!.picker.has("pending")).toBe(false)
    expect(service.state("work")!.worker.candidateModelUnavailableReason?.(candidate, "pending")).toContain("cannot serve")
    expect(service.state("work")!.worker.candidateOffering?.(candidate, "pending", false)).toBeUndefined()
  }
  try {
    await refresh()
    await assertPending(false)
    await service.set({ ...mutation(), target, modelId: "pending", checked: true })
    await assertPending(true)
    await refresh()
    await assertPending(true)
    for (const checked of [false, true]) {
      await service.set({ ...mutation(), target, modelId: "verified", checked })
      expect(service.state("work")!.picker.has("verified")).toBe(checked)
      await assertPending(true)
    }
    for (const enabled of [false, true]) {
      await service.setAutoEnableNewModels({ ...mutation(), enabled })
      await assertPending(true)
      await refresh()
      await assertPending(true)
    }
    await service.deselectAll({ ...mutation(), target })
    await assertPending(false)
    await refresh()
    await assertPending(false)
    await service.set({ ...mutation(), target, modelId: "pending", checked: true })
    await assertPending(true)
    verified = visible
    await refresh()
    expect(service.state("work")!.picker.has("pending")).toBe(true)
    expect(service.state("work")!.picker.has("unselected")).toBe(false)
    expect(service.state("work")!.worker.candidateModelUnavailableReason?.(candidate, "pending")).toBeUndefined()
  } finally {
    await service.dispose()
    access.close()
  }
})

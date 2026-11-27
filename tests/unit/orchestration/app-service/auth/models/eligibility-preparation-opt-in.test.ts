import { describe, expect, test } from "bun:test"
import { authDir } from "../../../../../../src/infra/platform/files/paths.js"
import { createEligibilityPreparation } from "../../../../../../src/orchestration/app-service/auth/models/eligibility-preparation.js"
import { createProviderModelPreferenceService } from "../../../../../../src/orchestration/app-service/auth/models/provider-model-preference-service.js"
import { composeFirstPartyModules } from "../../../../../../src/orchestration/module-contract/module-composition.js"
import { accessProviderAccountKey } from "../../../../../../src/infra/providers/auth/provider-account.js"
import type { CatalogModelOffering } from "../../../../../../src/infra/providers/catalog-model-offering.js"
import type { ResolvedProviderModels } from "../../../../../../src/infra/providers/auth/provider-models/provider-model-preferences.js"
import type { ResolvedProviderModelCatalogs } from "../../../../../../src/orchestration/config/models/model-assignment-providers.js"
import { testDirectories } from "../../../../../helpers/directories.js"
import { testAuthContext } from "../../../../../helpers/auth-context.js"
import { unusedProviderModelWrites } from "../../../../../helpers/provider-model-writes.js"
import { diskAuthObservation } from "../../../../../helpers/profile-auth-observation.js"

const DIRECTORIES = testDirectories(process.cwd())
const PROFILE = { id: "work", directory: authDir(DIRECTORIES.userDataRoot, "work") }
describe("eligibility preparation of a provider that the profile keeps off (PI-MODEL-096)", () => {
  test("a provider that the profile keeps off lists only its saved catalog, serves nothing, and serves again once on", async () => {
    // An Antigravity login from before the setting existed: its account and saved listing stay, and the profile is off.
    const service = createProviderModelPreferenceService({ ...unusedProviderModelWrites(), displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
    const antigravity = { kind: "subscription", providerId: "google_antigravity", instanceId: "login-1", spendMode: "included" } as const
    const vertex = { kind: "singleton", providerId: "google_vertex", spendMode: "direct_api" } as const
    const offering = (model: string): ReadonlyMap<string, readonly CatalogModelOffering[]> => new Map([[model, [Object.freeze({ wireModelId: model, metadata: null, dataUse: "standard" as const })]]])
    const both = new Map([...offering("gemini-3.8-flash"), ...offering("gemini-3.8-pro")])
    const resolvedModels = (...models: string[]): ResolvedProviderModels => ({ catalog: new Set(models), curatedDefault: new Set(models), enabled: new Set(), disabled: new Set(), effective: new Set(models) })
    let turnedOff: ReadonlySet<string> = new Set(["google_antigravity"])
    const savedOnly: Array<readonly string[]> = []
    const prepare = createEligibilityPreparation({ turnedOffProviders: () => turnedOff,
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]), observeAuth: diskAuthObservation(() => composeFirstPartyModules([])),
      prepare: service.prepare,
      publish: service.publish,
      current: service.state,
      inputRevision: () => ({ auth: "auth-v1", preferences: "preferences-v1" }),
      resolveAuth: async () => testAuthContext(),
      resolveCatalog: async ({ savedOnlyProviders }): Promise<ResolvedProviderModelCatalogs> => {
        savedOnly.push([...savedOnlyProviders ?? []])
        return {
          providers: new Map([["google_antigravity", resolvedModels("gemini-3.8-flash", "gemini-3.8-pro")], ["google_vertex", resolvedModels("gemini-3.8-flash")]]),
          accounts: new Map([[accessProviderAccountKey(antigravity), resolvedModels("gemini-3.8-flash", "gemini-3.8-pro")], [accessProviderAccountKey(vertex), resolvedModels("gemini-3.8-flash")]]),
          inventoryCandidates: new Map([
            [accessProviderAccountKey(antigravity), { candidate: antigravity, configured: true, currentConnection: true, enabledOfferings: both, inventoryOfferings: both }],
            [accessProviderAccountKey(vertex), { candidate: vertex, configured: true, currentConnection: true, enabledOfferings: offering("gemini-3.8-flash"), inventoryOfferings: offering("gemini-3.8-flash") }],
          ]),
          modelInfos: new Map(),
          enabledModels: new Map(),
        }
      },
    })

    const off = await prepare(PROFILE)
    expect(savedOnly).toEqual([["google_antigravity"]])
    expect(off.worker.candidateOfferings(antigravity, "gemini-3.8-flash", false)).toEqual([])
    expect(off.worker.candidateOfferings(vertex, "gemini-3.8-flash", false)[0]?.wireModelId).toBe("gemini-3.8-flash")
    expect(off.worker.turnedOffProvider("gemini-3.8-pro")).toBe("google_antigravity")
    expect(off.inventoryCandidates.get(accessProviderAccountKey(antigravity))?.inventoryOfferings).toEqual(both)

    // The next request's preparation, with no refresh between, reads the changed setting: a state prepared while the
    // provider was off never serves after it turned on, nor the other way round.
    turnedOff = new Set()
    const on = await prepare(PROFILE)
    expect(savedOnly.at(-1)).toEqual([])
    expect(on.worker.candidateOfferings(antigravity, "gemini-3.8-pro", false)[0]?.wireModelId).toBe("gemini-3.8-pro")
    expect(on.worker.turnedOffProvider("gemini-3.8-pro")).toBeUndefined()
    turnedOff = new Set(["google_antigravity"])
    expect((await prepare(PROFILE)).worker.candidateOfferings(antigravity, "gemini-3.8-pro", false)).toEqual([])
    await prepare.dispose()
    await service.dispose()
  })
})

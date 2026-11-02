import { modelsDevBaseline } from "../../infra/llm/model-listing-rows.js"
import { getSharedModelsClient } from "../config/llm-clients.js"
import { installedAccessProviderDefinitions } from "../credential-provider-modules.js"
import type { ProviderModelEligibilityState } from "./provider-model-preference-service.js"

/** The catalog evidence migrateLegacyModelSpellings needs to tell a former model spelling apart: each model of a
 *  published eligibility state with the wires of its offerings, plus every model of every installed provider's
 *  models.dev rows. A published state holds only the models of accounts that are signed in and listed, so without
 *  the models.dev models a pin that names a model of a signed-out account would look like a former spelling and
 *  convert. Remove after 2027-01-24 with migrateLegacyModelSpellings. */
export function legacyModelSpellingCatalog(state: ProviderModelEligibilityState, userDataRoot: string): ReadonlyMap<string, ReadonlySet<string>> {
  const catalog = new Map([...state.catalogs.values()].flatMap((models) => [...models.catalog].map((model) => [model, new Set<string>()] as const)))
  for (const [model, offerings] of [...state.inventoryCandidates.values()].flatMap((candidate) => [...candidate.inventoryOfferings ?? []])) {
    for (const offering of offerings) catalog.get(model)?.add(offering.wireModelId)
  }
  const modelsClient = getSharedModelsClient(userDataRoot)
  for (const { dynamicCatalog } of installedAccessProviderDefinitions()) {
    if (dynamicCatalog === undefined) continue
    for (const row of modelsDevBaseline(dynamicCatalog, modelsClient).canonicalRows) {
      if (!catalog.has(row.modelId)) catalog.set(row.modelId, new Set())
    }
  }
  return catalog
}

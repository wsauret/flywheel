import type { ProviderConnection } from "../../infra/auth/auth-context.js"
import { createModelListingClient } from "../../infra/llm/model-listing.js"
import type { ModelsClient } from "../../infra/llm/models.js"
import { accessProviderRegistry } from "../agent-runtime/llm/access-provider-registry.js"
import { credentialSlotClassifier } from "../auth/credential-slot-classifier.js"
import { resolveProviderModelCatalog } from "../config/model-assignment-providers.js"
import type { FirstPartyModuleSnapshot } from "../modules.js"

/** The eligibility sources of a run that serves from a captured connection,
 *  such as a headless auth snapshot, instead of its profile's auth files. An
 *  access-only connection never writes preferences and lists models fresh,
 *  because no saved listing belongs to its credentials. */
export function connectionEligibilitySources(connection: ProviderConnection, profileDirectory: string, moduleSelection: FirstPartyModuleSnapshot, modelsClient: ModelsClient) {
  const accessOnly = connection.oauthPersistence === "access-only"
  return {
    resolveAuth: async () => ({ ...connection.auth, subscriptionCredentials: connection.subscriptionCredentials }),
    resolveCatalog: (deps: Parameters<typeof resolveProviderModelCatalog>[0]) => resolveProviderModelCatalog({
      ...deps,
      preferencePersistence: accessOnly ? "read-only" : "persist",
      discoveryMode: accessOnly && deps.discoveryMode === "cached-first" ? "fresh" : deps.discoveryMode,
      listingClient: createModelListingClient({
        authDir: connection.authDir ?? profileDirectory,
        classifySlot: credentialSlotClassifier(moduleSelection()),
        providers: accessProviderRegistry(moduleSelection()).selection,
        modelsClient,
        oauthPersistence: connection.oauthPersistence,
        modelAccess: connection.modelAccess,
        captureSubscriptions: () => connection.subscriptionCredentials,
        captureCredentialLineages: () => connection.auth.credentialLineages ?? {},
      }),
    }),
  }
}

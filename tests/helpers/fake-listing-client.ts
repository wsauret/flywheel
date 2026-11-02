import type { ModelListingClient } from "../../src/infra/llm/model-listing.js";
import type { ModelFamily } from "../../src/infra/llm/model-family.js";
import type { AccessProviderId } from "../../src/infra/llm/access-provider.js";

const FAMILY_TO_PROVIDER = {
  anthropic: "anthropic_api",
  openai: "openai_api",
  google: "google_api",
} satisfies { [family in ModelFamily]: AccessProviderId };

export function fakeListingClient(
  availableModels: ReadonlyMap<ModelFamily, ReadonlySet<string>>,
): ModelListingClient {
  const providers = new Map<AccessProviderId, ReadonlySet<string>>();
  for (const [family, models] of availableModels) {
    const providerId = FAMILY_TO_PROVIDER[family];
    if (providerId && models.size > 0) providers.set(providerId, models);
  }
  return {
    getModelCatalogs: async () => ({ providers, candidates: new Map() }),
    recordModelRefusal: async () => false,
  };
}

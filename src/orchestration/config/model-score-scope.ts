import { installedAccessProviderDefinitions } from "../credential-provider-modules.js";
import type { ModelsClient } from "../../infra/llm/models.js";
import { recentScoreModel } from "../../infra/llm/model-scores-document.js";

/** Benchmark scope comes from direct provider catalogs, never OpenRouter membership. */
export function scoreCatalogModels(now: Date, client: ModelsClient): string[] {
  const namespaces = [...new Set(installedAccessProviderDefinitions()
    .filter((provider) => provider.id !== "openrouter")
    .flatMap((provider) => provider.catalogId === undefined
      ? provider.dynamicCatalog?.modelsDevCatalogIds ?? []
      : [provider.catalogId]))];
  return [...new Set(client.getProviderCatalog(namespaces, Number.MAX_SAFE_INTEGER - 1)
    .filter((row) => row.canonical !== null && recentScoreModel(row.metadata.releaseDate, now))
    .flatMap((row) => row.canonical === null ? [] : [row.canonical.modelId]))].sort();
}

import { Redacted } from "effect";
import { apiKey } from "../../../infra/auth/auth-context.js";
import type { AccessProviderDefinition } from "../../../infra/llm/access-provider.js";
import { canonicalizeIdCatalogRow, DEFAULT_DYNAMIC_CATALOG_LIMITS, extractDataCatalogRows } from "../../../infra/llm/model-catalog-resolution.js";
import { fetchCatalog } from "../../../infra/llm/model-listing.js";
import { providerModelInfo } from "../../../infra/llm/provider-model-info.js";
import { currentOpenAiStandardPricing, openAiPricingFromMetadata, openAiPricingMetadata, refreshOpenAiStandardPricing } from "../../../infra/llm/openai-pricing.js";
import { isRecord } from "../../../infra/record.js";
import { ApiError } from "../../agent-runtime/errors.js";
import { stagedProviderClient, type AccessProviderFactory } from "../../agent-runtime/llm/client-factory.js";
import { describeProvider } from "../../agent-runtime/llm/provider-description.js";
import type { FirstPartyModule } from "../../modules.js";

const catalog = { limits: DEFAULT_DYNAMIC_CATALOG_LIMITS, extractRows: extractDataCatalogRows } as const;

function canonicalizeOpenAiRow(row: unknown) {
  const canonical = canonicalizeIdCatalogRow(row);
  if (canonical === undefined) return undefined;
  const pricing = isRecord(row) ? openAiPricingFromMetadata(row.standard_pricing, canonical.modelId) : undefined;
  return {
    ...canonical,
    resolvedMetadata: providerModelInfo({
      provider: "openai",
      id: canonical.modelId,
      ...(pricing === undefined ? {} : { pricing }),
    }),
  };
}

const definition = {
  id: "openai_api",
  displayName: "OpenAI API Key",
  shortName: "OpenAI",
  supportedFamilies: ["openai"],
  defaultChatTransport: "openai-responses",
  cacheRetentionPolicies: ["provider", "in_memory", "24h"],
  configHints: ["flywheel auth login --openai"],
  cli: { flag: "openai", name: "OpenAI" },
  billing: "metered",
  spendMode: "direct_api",
  rank: 60,
  catalogId: undefined,
  dynamicCatalog: {
    ...catalog,
    canonicalize: canonicalizeOpenAiRow,
    modelsDevCatalogIds: ["openai"],
    fetch: async ({ credential, signal }) => {
      if (credential.type !== "api_key") return { discovery: { kind: "not-attempted" }, credential };
      // Provider-call adapter: the key is unwrapped only into the header.
      void refreshOpenAiStandardPricing();
      const discovery = await fetchCatalog("https://api.openai.com/v1/models", { Authorization: `Bearer ${Redacted.value(credential.key)}` }, catalog, signal);
      const pricing = currentOpenAiStandardPricing();
      return {
        discovery: discovery.kind === "rows" && pricing.size > 0
          ? {
              kind: "rows",
              rows: discovery.rows.map((row) => {
                if (!isRecord(row) || typeof row.id !== "string") return row;
                const supplement = openAiPricingMetadata(row.id, pricing);
                return supplement === undefined ? row : { ...row, standard_pricing: supplement };
              }),
            }
          : discovery,
        credential,
      };
    },
  },
  // The broad "sk-" prefix claims a key only after every longer prefix declined it.
  auth: { kind: "api_key", statusRank: 20, keyPrefix: { prefix: "sk-", description: "an OpenAI API key" } },
} as const satisfies AccessProviderDefinition;

const createClient: AccessProviderFactory = async (build) => {
  const described = await describeProvider(build.model, { accessProvider: definition.id, protocol: "openai-responses", providerHint: "openai", resolvedModelMetadata: build.attribution.resolvedModelMetadata });
  return stagedProviderClient(build, described, async () => {
    const key = apiKey(build.connection.auth, definition.id);
    if (!key) throw new ApiError({ message: "No OpenAI API key in the active auth profile. Run: flywheel auth login --openai", recovery: { kind: "none" } });
    const { createOpenAIAdapter } = await import("../../agent-runtime/llm/openai.js");
    return createOpenAIAdapter({ kind: "apiKey", apiKey: key }, build.wireModelId, build.modelsClient, {
      availability: build.availability, candidate: build.candidate, resolvedModelMetadata: build.attribution.resolvedModelMetadata ?? null,
    });
  });
};

export const openaiApiModule = {
  id: "provider-openai-api",
  dependencies: [],
  availability: { kind: "available" },
  contributions: [
    { domain: "providers", id: "openai_api", value: { definition, createClient } },
    { domain: "settings", id: "provider-openai-api", value: { control: "binary", group: "Model providers", label: definition.displayName, description: "Allow OpenAI models through an API key" } },
  ],
  observers: [], transformers: [], gates: [],
} as const satisfies FirstPartyModule;

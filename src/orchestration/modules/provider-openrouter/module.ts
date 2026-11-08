import { Redacted } from "effect";
import { apiKey } from "../../../infra/auth/auth-context.js";
import type { AccessProviderDefinition } from "../../../infra/llm/access-provider.js";
import { DEFAULT_DYNAMIC_CATALOG_LIMITS, extractDataCatalogRows } from "../../../infra/llm/model-catalog-resolution.js";
import { fetchCatalog } from "../../../infra/llm/model-listing.js";
import { openRouterRequestHeaders } from "../../../infra/llm/provider-request-identity.js";
import { ApiError } from "../../agent-runtime/errors.js";
import { stagedProviderClient, type AccessProviderFactory } from "../../agent-runtime/llm/client-factory.js";
import { describeProvider } from "../../agent-runtime/llm/provider-description.js";
import type { ProviderAffordabilityFactory } from "../../agent-runtime/llm/provider-affordability.js";
import type { FirstPartyModule } from "../../modules.js";
import { createOpenRouterAffordability } from "./affordability.js";
import { OPENROUTER_API_BASE, OPENROUTER_API_HOST } from "./api.js";
import { canonicalizeOpenRouterCatalogRow, canonicalizeOpenRouterWireId, openRouterModelOutputCap } from "./model-support.js";

const catalog = { limits: DEFAULT_DYNAMIC_CATALOG_LIMITS, extractRows: extractDataCatalogRows } as const;

const definition = {
  id: "openrouter",
  displayName: "OpenRouter API Key",
  shortName: "OpenRouter",
  supportedFamilies: ["anthropic", "openai", "google"],
  defaultChatTransport: "openai-completions",
  configHints: ["flywheel auth login --openrouter"],
  cli: { flag: "openrouter", name: "OpenRouter" },
  billing: "metered",
  spendMode: "aggregator",
  rank: 80,
  catalogId: undefined,
  apiHosts: [OPENROUTER_API_HOST],
  dynamicCatalog: {
    ...catalog,
    canonicalize: canonicalizeOpenRouterCatalogRow,
    canonicalizeWireId: canonicalizeOpenRouterWireId,
    modelsDevCatalogIds: ["openrouter"],
    fetch: async ({ credential, signal }) => {
      if (credential.type !== "api_key") return { discovery: { kind: "not-attempted" }, credential };
      // Provider-call adapter: the key is unwrapped only into the header.
      const headers = { ...await openRouterRequestHeaders(), Authorization: `Bearer ${Redacted.value(credential.key)}` };
      const discovery = await fetchCatalog(`${OPENROUTER_API_BASE}/models`, headers, catalog, signal);
      return { discovery, credential };
    },
  },
  auth: { kind: "api_key", statusRank: 40, keyPrefix: { prefix: "sk-or-", description: "an OpenRouter API key" } },
} as const satisfies AccessProviderDefinition;

const createClient: AccessProviderFactory = async (build) => {
  const outputCap = build.attribution.catalogProvenance === "live"
    ? openRouterModelOutputCap(build.attribution.catalogMetadata)
    : undefined;
  const described = await describeProvider(build.model, { accessProvider: definition.id, protocol: "openai-completions", providerHint: "openrouter", resolvedModelMetadata: build.attribution.resolvedModelMetadata, ...(outputCap === undefined ? {} : { providerOutputCap: outputCap }) });
  return stagedProviderClient(build, described, async () => {
    const key = apiKey(build.connection.auth, definition.id);
    if (!key) throw new ApiError({ message: "No OpenRouter API key in the active auth profile. Run: flywheel auth login --openrouter", recovery: { kind: "none" } });
    const [{ default: OpenAI }, { createOpenAIChatCompletionsAdapter }] = await Promise.all([import("openai"), import("../../agent-runtime/llm/openai-completions.js")]);
    const client = new OpenAI({ apiKey: Redacted.value(key), baseURL: OPENROUTER_API_BASE, defaultHeaders: await openRouterRequestHeaders(), maxRetries: 0 });
    return createOpenAIChatCompletionsAdapter(client, build.model, build.modelsClient, {
      accessProvider: definition.id, providerHint: "openrouter", candidate: build.candidate, wireModelId: build.wireModelId,
      resolvedModelMetadata: build.attribution.resolvedModelMetadata ?? null,
      ...(outputCap === undefined ? {} : { providerOutputCap: outputCap }),
    });
  });
};

const createAffordability: ProviderAffordabilityFactory = (connection) => {
  const key = apiKey(connection.auth, definition.id);
  const credentialLineage = connection.auth.credentialLineages[definition.id];
  if (key === undefined || credentialLineage === undefined) return undefined;
  return createOpenRouterAffordability({ profileId: connection.profileId, credentialLineage, apiKey: key });
};

export const openrouterModule = {
  id: "provider-openrouter",
  dependencies: [],
  availability: { kind: "available" },
  contributions: [
    { domain: "providers", id: "openrouter", value: { definition, createClient, affordability: createAffordability } },
    { domain: "settings", id: "provider-openrouter", value: { control: "binary", group: "Model providers", label: definition.displayName, description: "Allow models through an OpenRouter API key" } },
  ],
  observers: [], transformers: [], gates: [],
} as const satisfies FirstPartyModule;

import { Redacted } from "effect";
import type { AccessProviderDefinition } from "../../../infra/llm/access-provider.js";
import { canonicalizeProviderIdCatalogRow, DEFAULT_DYNAMIC_CATALOG_LIMITS, extractDataCatalogRows } from "../../../infra/llm/model-catalog-resolution.js";
import { fetchCatalog } from "../../../infra/llm/model-listing.js";
import { providerRequestHeaders } from "../../../infra/llm/provider-request-identity.js";
import { apiKey } from "../../../infra/auth/auth-context.js";
import { ApiError } from "../../agent-runtime/errors.js";
import { stagedProviderClient, type AccessProviderFactory } from "../../agent-runtime/llm/client-factory.js";
import { describeProvider, requireModelMetadata } from "../../agent-runtime/llm/provider-description.js";
import type { FirstPartyModule } from "../../modules.js";
import { createDeepSeekUsageReader } from "./usage-reader.js";

const BASE_URL = "https://api.deepseek.com";
const catalog = { limits: DEFAULT_DYNAMIC_CATALOG_LIMITS, extractRows: extractDataCatalogRows } as const;

const definition = {
  id: "deepseek",
  displayName: "DeepSeek API Key",
  shortName: "DeepSeek",
  billingUrl: "https://platform.deepseek.com",
  supportedFamilies: ["openai"],
  defaultChatTransport: "openai-completions",
  configHints: ["flywheel auth login --deepseek"],
  cli: { flag: "deepseek", name: "DeepSeek" },
  billing: "metered",
  spendMode: "direct_api",
  // A first-party endpoint ahead of the aggregator that also serves its models.
  rank: 78,
  catalogId: undefined,
  dynamicCatalog: {
    ...catalog,
    canonicalize: (row) => canonicalizeProviderIdCatalogRow("deepseek", row),
    modelsDevCatalogIds: ["deepseek"],
    // deepseek-flash moves to each new Flash snapshot.
    modelIdentity: "models-dev-snapshot",
    fetch: async ({ credential, signal }) => {
      if (credential.type !== "api_key") return { discovery: { kind: "not-attempted" }, credential };
      // Provider-call adapter: the key is unwrapped only into the header.
      return { discovery: await fetchCatalog(`${BASE_URL}/models`, { Authorization: `Bearer ${Redacted.value(credential.key)}` }, catalog, signal), credential };
    },
  },
  // DeepSeek keys share OpenAI's broad "sk-" prefix, so no prefix can claim one.
  auth: { kind: "api_key", statusRank: 45 },
} as const satisfies AccessProviderDefinition;

const createClient: AccessProviderFactory = async (build) => {
  const info = requireModelMetadata(build.model, build.attribution.resolvedModelMetadata);
  const described = await describeProvider(build.model, { accessProvider: definition.id, protocol: "openai-completions", providerHint: "deepseek", resolvedModelMetadata: info });
  return stagedProviderClient(build, described, async () => {
    const key = apiKey(build.connection.auth, definition.id);
    if (!key) throw new ApiError({ message: "No DeepSeek API key in the active auth profile. Run: flywheel auth login --deepseek", recovery: { kind: "none" } });
    const [{ default: OpenAI }, { createOpenAIChatCompletionsAdapter }] = await Promise.all([import("openai"), import("../../agent-runtime/llm/openai-completions.js")]);
    const client = new OpenAI({ apiKey: Redacted.value(key), baseURL: BASE_URL, defaultHeaders: await providerRequestHeaders(), maxRetries: 0 });
    return createOpenAIChatCompletionsAdapter(client, build.wireModelId, info, {
      accessProvider: definition.id, providerHint: "deepseek", candidate: build.candidate,
    });
  });
};

export const deepseekModule = {
  id: "provider-deepseek",
  dependencies: [],
  availability: { kind: "available" },
  contributions: [
    { domain: "providers", id: "deepseek", value: { definition, createClient, usageReader: createDeepSeekUsageReader() } },
    { domain: "settings", id: "provider-deepseek", value: { control: "binary", group: "Model providers", label: definition.displayName, description: "Allow DeepSeek models through an API key" } },
  ],
  observers: [], transformers: [], gates: [],
} as const satisfies FirstPartyModule;

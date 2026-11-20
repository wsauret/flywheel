import { Redacted } from "effect";
import type { AccessProviderDefinition } from "../../../infra/llm/access-provider.js";
import { DEFAULT_DYNAMIC_CATALOG_LIMITS, extractDataCatalogRows } from "../../../infra/llm/model-catalog-resolution.js";
import { fetchCatalog } from "../../../infra/llm/model-listing.js";
import { providerRequestHeaders } from "../../../infra/llm/provider-request-identity.js";
import { apiKey } from "../../../infra/auth/auth-context.js";
import { ApiError } from "../../agent-runtime/errors.js";
import { providerAdapter, type AccessProviderFactory } from "../../agent-runtime/llm/client-factory.js";
import { describeProvider, requireModelMetadata } from "../../agent-runtime/llm/provider-description.js";
import type { FirstPartyModule } from "../../modules.js";
import { canonicalizeBasetenCatalogRow, canonicalizeBasetenWireId } from "./model-support.js";

const BASE_URL = "https://inference.baseten.co/v1";
interface RequestHeaders { readonly [name: string]: string }
const catalog = { limits: DEFAULT_DYNAMIC_CATALOG_LIMITS, extractRows: extractDataCatalogRows } as const;

const definition = {
  id: "baseten",
  displayName: "Baseten API Key",
  shortName: "Baseten",
  defaultChatTransport: "chat-completions",
  apiHosts: ["inference.baseten.co"],
  configHints: ["flywheel auth login --baseten"],
  cli: { flag: "baseten", name: "Baseten" },
  billing: "metered",
  spendMode: "direct_api",
  // A model host follows the developer's endpoint and precedes aggregators.
  rank: 79,
  catalogId: undefined,
  dynamicCatalog: {
    ...catalog,
    canonicalize: canonicalizeBasetenCatalogRow,
    canonicalizeWireId: canonicalizeBasetenWireId,
    modelsDevCatalogIds: ["baseten"],
    fetch: async ({ credential, signal }) => {
      if (credential.type !== "api_key") return { discovery: { kind: "not-attempted" }, credential };
      return { discovery: await fetchCatalog(`${BASE_URL}/models`, { Authorization: `Bearer ${Redacted.value(credential.key)}` }, catalog, signal), credential };
    },
  },
  auth: { kind: "api_key", statusRank: 46 },
} as const satisfies AccessProviderDefinition;

const createClient: AccessProviderFactory = async (build) => {
  const info = requireModelMetadata(build.model, build.attribution.resolvedModelMetadata);
  return providerAdapter(build, (attribution) => describeProvider(build.model, { accessProvider: definition.id, protocol: "chat-completions", providerHint: definition.id, resolvedModelMetadata: requireModelMetadata(build.model, attribution.resolvedModelMetadata) }), async () => {
    const key = apiKey(build.connection.auth, definition.id);
    if (!key) throw new ApiError({ message: "No Baseten API key in the active auth profile. Run: flywheel auth login --baseten", recovery: { kind: "none" } });
    const [{ default: OpenAI }, { createChatCompletionsAdapter }] = await Promise.all([import("openai"), import("../../agent-runtime/llm/chat-completions.js")]);
    const client = new OpenAI({ apiKey: Redacted.value(key), baseURL: BASE_URL, defaultHeaders: await providerRequestHeaders(), maxRetries: 0 });
    return createChatCompletionsAdapter(client, build.wireModelId, info, {
      accessProvider: definition.id, candidate: build.candidate,
      extraHeaders: (options): RequestHeaders => options.providerSessionKey === undefined ? {} : { "x-session-affinity": options.providerSessionKey },
    });
  }, (client, { attribution }) => client.withModelInfo(requireModelMetadata(build.model, attribution.resolvedModelMetadata)));
};

export const basetenModule = {
  id: "provider-baseten",
  dependencies: [],
  contributions: [
    { domain: "providers", id: "baseten", value: { definition, createClient } },
    { domain: "settings", id: "provider-baseten", value: { control: "binary", group: "Model providers", label: definition.displayName, description: "Allow Baseten models through an API key" } },
  ],
} as const satisfies FirstPartyModule;

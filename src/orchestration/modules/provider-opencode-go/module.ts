import { Redacted } from "effect";
import type { AccessProviderDefinition } from "../../../infra/providers/llm/access/access-provider.js";
import { canonicalizeProviderIdCatalogRow, extractDataCatalogRows } from "../../../infra/providers/llm/catalog/model-catalog-resolution.js";
import { DEFAULT_DYNAMIC_CATALOG_LIMITS } from "../../../infra/providers/model-catalog-rows.js";
import { openCodeGoRequestHeaders, providerRequestHeaders } from "../../../infra/providers/llm/provider-request-identity.js";
import { fetchCatalog } from "../../../infra/providers/llm/access/model-listing.js";
import { ApiError } from "../../agent-runtime/llm/routing/runtime-errors.js";
import { credentialForCandidate, providerAdapter, type AccessProviderFactory } from "../../agent-runtime/llm/routing/client-factory.js";
import { describeProvider, requireModelMetadata } from "../../agent-runtime/llm/provider-description.js";
import type { FirstPartyModule } from "../../module-contract/module-catalog.js";
import { createOpenCodeGoUsageReader } from "./usage-reader.js";
import { OPENCODE_GO_API_BASE, OPENCODE_GO_BILLING_URL, OPENCODE_GO_METADATA_PROVIDER, OPENCODE_GO_V1_BASE } from "./wire.js";

const definition = {
  id: "opencode_go",
  displayName: "OpenCode Go Subscription",
  shortName: "OpenCode Go",
  billingUrl: OPENCODE_GO_BILLING_URL,
 
  defaultChatTransport: "chat-completions",
  configHints: ["flywheel auth login --opencode-go"],
  cli: { flag: "opencode-go", name: "OpenCode Go" },
  billing: "subscription",
  paidModes: ["prepaid"],
  rank: 30,
  catalogId: "opencode-go",
  apiHosts: [new URL(OPENCODE_GO_API_BASE).host],
  dynamicCatalog: {
    limits: DEFAULT_DYNAMIC_CATALOG_LIMITS,
    extractRows: extractDataCatalogRows,
    canonicalize: (row) => canonicalizeProviderIdCatalogRow(OPENCODE_GO_METADATA_PROVIDER, row),
    modelsDevCatalogIds: ["opencode-go"],
    // OpenCode Go often serves an older revision of a model under its current name.
    modelIdentity: "models-dev-snapshot",
    isFreeWire: (wireModelId) => wireModelId.endsWith("-free"), // provider-model-literal-allow: identity -- OpenCode Go spells each free route with a -free suffix
    fetch: async ({ credential, signal }) => {
      if (credential.type !== "api_key") return { discovery: { kind: "not-attempted" }, credential };
      return {
        discovery: await fetchCatalog(
          `${OPENCODE_GO_V1_BASE}/models`,
          { Authorization: `Bearer ${Redacted.value(credential.key)}` },
          { limits: DEFAULT_DYNAMIC_CATALOG_LIMITS, extractRows: extractDataCatalogRows },
          signal,
        ),
        credential,
      };
    },
  },
  auth: { kind: "api_key", statusRank: 30 },
} as const satisfies AccessProviderDefinition;

const createClient: AccessProviderFactory = async (build) => {
  const endpoint = build.attribution.transport;
  if (endpoint === undefined || endpoint === "google") throw new ApiError({ message: `OpenCode Go has no supported transport for "${build.model}".`, recovery: { kind: "none" } });
  const protocol = endpoint === "anthropic-messages" ? "anthropic" : endpoint === "openai-responses" ? "openai-responses" : "chat-completions";
  const info = requireModelMetadata(build.model, build.attribution.resolvedModelMetadata);
  return providerAdapter(build, (attribution) => describeProvider(build.model, { accessProvider: definition.id, protocol, providerHint: definition.catalogId, resolvedModelMetadata: requireModelMetadata(build.model, attribution.resolvedModelMetadata) }), async () => {
    const credential = credentialForCandidate(build.connection, build.candidate);
    if (credential?.type !== "api_key") throw new ApiError({ message: "No OpenCode Go API key in the active auth profile. Run: flywheel auth login --opencode-go", recovery: { kind: "none" } });
    const key = credential.key;
    if (endpoint === "anthropic-messages") {
      const { createAnthropicAdapter } = await import("../../agent-runtime/llm/adapters/anthropic/anthropic.js");
      return createAnthropicAdapter(key, build.wireModelId, info, {
        baseURL: OPENCODE_GO_API_BASE,
        accessProvider: definition.id,
        catalogId: definition.catalogId,
        candidate: build.candidate,
        extraHeaders: (options) => openCodeGoRequestHeaders(options.providerSessionKey),
      });
    }
    const [{ default: OpenAI }, { createOpenAIAdapter }, { createChatCompletionsAdapter }] = await Promise.all([
      import("openai"), import("../../agent-runtime/llm/adapters/openai/openai.js"), import("../../agent-runtime/llm/adapters/chat-completions/chat-completions.js"),
    ]);
    const client = new OpenAI({ apiKey: Redacted.value(key), baseURL: OPENCODE_GO_V1_BASE, defaultHeaders: await providerRequestHeaders(), maxRetries: 0 });
    if (endpoint === "openai-responses") return createOpenAIAdapter({ kind: "apiKey", apiKey: key }, build.wireModelId, info, {
      client,
      accessProvider: definition.id,
      catalogId: definition.catalogId,
      candidate: build.candidate,
      extraHeaders: (options) => openCodeGoRequestHeaders(options.providerSessionKey),
    });
    return createChatCompletionsAdapter(client, build.wireModelId, info, {
      accessProvider: definition.id,
      candidate: build.candidate,
      extraHeaders: (options) => openCodeGoRequestHeaders(options.providerSessionKey),
    });
  }, (client, { attribution }) => client.withModelInfo(requireModelMetadata(build.model, attribution.resolvedModelMetadata)));
};

export const opencodeGoModule = {
  id: "provider-opencode-go",
  dependencies: [],
  contributions: [
    { domain: "providers", id: "opencode_go", value: { definition, createClient, usageReader: createOpenCodeGoUsageReader() } },
    { domain: "settings", id: "provider-opencode-go", value: { control: "binary", group: "Model providers", label: definition.displayName, description: "Allow supported models through an OpenCode Go subscription" } },
  ],
} as const satisfies FirstPartyModule;

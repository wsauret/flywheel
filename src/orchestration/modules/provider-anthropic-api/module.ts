import { Redacted } from "effect";
import { apiKey } from "../../../infra/auth/auth-context.js";
import type { AccessProviderDefinition } from "../../../infra/llm/access-provider.js";
import { canonicalizeIdCatalogRow, DEFAULT_DYNAMIC_CATALOG_LIMITS, extractDataCatalogRows, type CatalogJsonValue, type CatalogSourceRow } from "../../../infra/llm/model-catalog-resolution.js";
import { fetchPaginatedCatalog } from "../../../infra/llm/model-listing.js";
import { providerModelInfo } from "../../../infra/llm/provider-model-info.js";
import { isRecord } from "../../../infra/record.js";
import { ApiError } from "../../agent-runtime/errors.js";
import { createClaudeReminders } from "../../agent-runtime/llm/claude-reminders.js";
import { stagedProviderClient, type AccessProviderFactory } from "../../agent-runtime/llm/client-factory.js";
import { describeProvider } from "../../agent-runtime/llm/provider-description.js";
import type { FirstPartyModule } from "../../modules.js";

/** The listing pages by `after_id`, the way the Messages API's model list does. */
function nextModelsPage(body: unknown, currentUrl: string): string | undefined {
  if (!isRecord(body) || body.has_more !== true || typeof body.last_id !== "string" || body.last_id.length === 0) return undefined;
  const next = new URL(currentUrl);
  next.searchParams.set("after_id", body.last_id);
  return next.href;
}

const catalog = { limits: DEFAULT_DYNAMIC_CATALOG_LIMITS, extractRows: extractDataCatalogRows } as const;

function canonicalizeAnthropicRow(row: unknown): CatalogSourceRow | undefined {
  const canonical = canonicalizeIdCatalogRow(row);
  if (canonical === undefined || !isRecord(row)) return canonical;
  const contextLimit = positiveInteger(row.max_input_tokens);
  const outputLimit = positiveInteger(row.max_tokens);
  const capabilities = isRecord(row.capabilities) ? row.capabilities : undefined;
  const hasImageInput = typeof capabilities?.image_input === "boolean";
  const hasPdfInput = typeof capabilities?.pdf_input === "boolean";
  const imageInput = capabilities?.image_input === true;
  const pdfInput = capabilities?.pdf_input === true;
  const normalizedCapabilities: CatalogJsonValue | undefined = capabilities === undefined ? undefined : {
    ...(typeof capabilities.image_input === "boolean" ? { image_input: capabilities.image_input } : {}),
    ...(typeof capabilities.pdf_input === "boolean" ? { pdf_input: capabilities.pdf_input } : {}),
    ...(typeof capabilities.thinking === "boolean" ? { thinking: capabilities.thinking } : {}),
  };
  return {
    ...canonical,
    metadata: {
      ...(typeof row.object === "string" ? { object: row.object } : {}),
      ...(typeof row.owned_by === "string" ? { owned_by: row.owned_by } : {}),
      ...(typeof row.display_name === "string" ? { display_name: row.display_name } : {}),
      ...(typeof row.created_at === "string" ? { created_at: row.created_at } : {}),
      ...(contextLimit === undefined ? {} : { max_input_tokens: contextLimit }),
      ...(outputLimit === undefined ? {} : { max_tokens: outputLimit }),
      ...(normalizedCapabilities === undefined ? {} : { capabilities: normalizedCapabilities }),
    },
    resolvedMetadata: providerModelInfo({
      provider: "anthropic",
      id: canonical.modelId,
      ...(typeof row.display_name === "string" ? { name: row.display_name } : {}),
      ...(typeof row.created_at === "string" ? { releaseDate: row.created_at } : {}),
      ...(typeof capabilities?.thinking === "boolean" ? { reasoning: capabilities.thinking } : {}),
      ...(!hasImageInput && !hasPdfInput ? {} : { attachment: imageInput || pdfInput }),
      ...(contextLimit === undefined ? {} : { contextLimit }),
      ...(outputLimit === undefined ? {} : { outputLimit }),
      ...(!hasImageInput && !hasPdfInput ? {} : { modalities: { input: ["text", ...(imageInput ? ["image"] : []), ...(pdfInput ? ["pdf"] : [])], output: ["text"] } }),
    }),
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

const definition = {
  id: "anthropic_api",
  displayName: "Anthropic API Key",
  shortName: "Anthropic",
  supportedFamilies: ["anthropic"],
  defaultChatTransport: "anthropic-messages",
  cacheRetentionPolicies: ["5m", "1h"],
  configHints: ["flywheel auth login --anthropic"],
  cli: { flag: "anthropic", name: "Anthropic" },
  billing: "metered",
  spendMode: "direct_api",
  rank: 50,
  catalogId: undefined,
  dynamicCatalog: {
    ...catalog,
    canonicalize: canonicalizeAnthropicRow,
    modelsDevCatalogIds: ["anthropic"],
    fetch: async ({ credential, signal }) => {
      if (credential.type !== "api_key") return { discovery: { kind: "not-attempted" }, credential };
      // Provider-call adapter: the key is unwrapped only into the header.
      const headers = { "x-api-key": Redacted.value(credential.key), "anthropic-version": "2023-06-01" };
      return { discovery: await fetchPaginatedCatalog("https://api.anthropic.com/v1/models", headers, catalog, signal, nextModelsPage), credential };
    },
  },
  auth: { kind: "api_key", statusRank: 10, keyPrefix: { prefix: "sk-ant-", description: "an Anthropic API key" } },
} as const satisfies AccessProviderDefinition;

const createClient: AccessProviderFactory = async (build) => {
  const described = await describeProvider(build.model, { accessProvider: definition.id, protocol: "anthropic", providerHint: "anthropic", resolvedModelMetadata: build.attribution.resolvedModelMetadata });
  return stagedProviderClient(build, {
    ...described,
    messagesToAppend: createClaudeReminders(build.wireModelId, described.totalContextLimit ?? described.contextLimit, build.attribution.resolvedModelMetadata),
  }, async () => {
    const key = apiKey(build.connection.auth, definition.id);
    if (!key) throw new ApiError({ message: "No Anthropic API key in the active auth profile. Run: flywheel auth login --anthropic", recovery: { kind: "none" } });
    const { createAnthropicAdapter } = await import("../../agent-runtime/llm/anthropic.js");
    return createAnthropicAdapter(key, build.wireModelId, build.modelsClient, { candidate: build.candidate, availability: build.availability, resolvedModelMetadata: build.attribution.resolvedModelMetadata ?? null });
  });
};

export const anthropicApiModule = {
  id: "provider-anthropic-api",
  dependencies: [],
  availability: { kind: "available" },
  contributions: [
    { domain: "providers", id: "anthropic_api", value: { definition, createClient } },
    { domain: "settings", id: "provider-anthropic-api", value: { control: "binary", group: "Model providers", label: definition.displayName, description: "Allow Anthropic models through an API key" } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule;

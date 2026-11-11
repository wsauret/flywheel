import { Redacted } from "effect";
import { apiKey } from "../../../infra/auth/auth-context.js";
import type { AccessProviderDefinition } from "../../../infra/llm/access-provider.js";
import { DEFAULT_DYNAMIC_CATALOG_LIMITS } from "../../../infra/llm/model-catalog-resolution.js";
import { fetchPaginatedCatalog } from "../../../infra/llm/model-listing.js";
import { providerModelInfo } from "../../../infra/llm/provider-model-info.js";
import { isRecord } from "../../../infra/record.js";
import { ApiError } from "../../agent-runtime/errors.js";
import { stagedProviderClient, type AccessProviderFactory } from "../../agent-runtime/llm/client-factory.js";
import { describeProvider, requireModelMetadata } from "../../agent-runtime/llm/provider-description.js";
import type { FirstPartyModule } from "../../modules.js";

/** The listing pages by `pageToken`, the way the Gemini Developer API's model list does. */
function nextModelsPage(body: unknown, currentUrl: string): string | undefined {
  if (!isRecord(body) || typeof body.nextPageToken !== "string" || body.nextPageToken.length === 0) return undefined;
  const next = new URL(currentUrl);
  next.searchParams.set("pageToken", body.nextPageToken);
  return next.href;
}

const catalog = {
  limits: DEFAULT_DYNAMIC_CATALOG_LIMITS,
  extractRows: (body: unknown) => {
    if (!isRecord(body) || !Array.isArray(body.models)) throw new TypeError("model list models must be an array");
    if (!body.models.every((row) => isRecord(row) && typeof row.name === "string" && row.name.length > 0)) {
      throw new TypeError("model list rows must have non-empty names");
    }
    return body.models;
  },
} as const;

const definition = {
  id: "google_api",
  displayName: "Google API Key",
  shortName: "Google",
  supportedFamilies: ["google"],
  defaultChatTransport: "google",
  configHints: ["flywheel auth login --google"],
  cli: { flag: "google", name: "Google" },
  billing: "metered",
  spendMode: "direct_api",
  rank: 70,
  catalogId: undefined,
  dynamicCatalog: {
    ...catalog,
    canonicalize: (row) => {
      if (!isRecord(row) || typeof row.name !== "string" || row.name.length === 0) return undefined;
      const modelId = row.name.startsWith("models/") ? row.name.slice("models/".length) : row.name;
      const contextLimit = positiveInteger(row.inputTokenLimit);
      const outputLimit = positiveInteger(row.outputTokenLimit);
      return {
          modelId,
          wireModelId: modelId,
          metadata: {
            sourceWireModelId: row.name,
            ...Object.fromEntries(Object.entries(row).filter(([key, value]) => key !== "name" && (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null))),
          },
          resolvedMetadata: providerModelInfo({
            provider: "google",
            id: modelId,
            ...(typeof row.displayName === "string" ? { name: row.displayName } : {}),
            ...(typeof row.thinking === "boolean" ? { reasoning: row.thinking } : {}),
            ...(contextLimit === undefined ? {} : { contextLimit }),
            ...(outputLimit === undefined ? {} : { outputLimit }),
          }),
        };
    },
    modelsDevCatalogIds: ["google"],
    fetch: async ({ credential, signal }) => {
      if (credential.type !== "api_key") return { discovery: { kind: "not-attempted" }, credential };
      // Provider-call adapter: the key is unwrapped only into the header.
      return { discovery: await fetchPaginatedCatalog("https://generativelanguage.googleapis.com/v1beta/models", { "x-goog-api-key": Redacted.value(credential.key) }, catalog, signal, nextModelsPage), credential };
    },
  },
  auth: { kind: "api_key", statusRank: 50, keyPrefix: { prefix: "AIza", description: "a Gemini Developer API key" } },
} as const satisfies AccessProviderDefinition;

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

const createClient: AccessProviderFactory = async (build) => {
  const info = requireModelMetadata(build.model, build.attribution.resolvedModelMetadata);
  const described = await describeProvider(build.model, { accessProvider: definition.id, protocol: "google", providerHint: "google", resolvedModelMetadata: info });
  return stagedProviderClient(build, described, async () => {
    const key = apiKey(build.connection.auth, definition.id);
    if (!key) throw new ApiError({ message: "No Google API key in the active auth profile. Run: flywheel auth login --google", recovery: { kind: "none" } });
    const { createGoogleAdapter } = await import("../../agent-runtime/llm/google.js");
    return createGoogleAdapter(key, build.wireModelId, info);
  });
};

export const googleApiModule = {
  id: "provider-google-api",
  dependencies: [],
  availability: { kind: "available" },
  contributions: [
    { domain: "providers", id: "google_api", value: { definition, createClient } },
    { domain: "settings", id: "provider-google-api", value: { control: "binary", group: "Model providers", label: definition.displayName, description: "Allow Google models through an API key" } },
  ],
  observers: [], transformers: [], gates: [],
} as const satisfies FirstPartyModule;

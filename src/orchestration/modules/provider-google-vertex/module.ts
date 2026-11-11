import { Redacted } from "effect";
import { apiKey } from "../../../infra/auth/auth-context.js";
import type { AccessProviderDefinition } from "../../../infra/llm/access-provider.js";
import { canonicalizeIdCatalogRow, DEFAULT_DYNAMIC_CATALOG_LIMITS, extractDataCatalogRows, type CatalogWireIdentity } from "../../../infra/llm/model-catalog-resolution.js";
import { canonicalCatalogModelId, isMovingModelAlias } from "../../../infra/llm/model-id.js";
import { ApiError } from "../../agent-runtime/errors.js";
import { stagedProviderClient, type AccessProviderFactory } from "../../agent-runtime/llm/client-factory.js";
import { describeProvider, requireModelMetadata } from "../../agent-runtime/llm/provider-description.js";
import type { FirstPartyModule } from "../../modules.js";

/** Vertex AI in express mode: the Gemini wire on aiplatform.googleapis.com,
 *  authenticated with an API key (Google Cloud "AQ." keys). Enterprise keys
 *  are commonly restricted to the Vertex surface and rejected by the Gemini
 *  Developer API, which the google_api provider serves. Vertex publishes no
 *  model listing an express key can read, so the catalog is every Gemini
 *  chat model models.dev knows for the surface. */
/** Derives Vertex's shared model identity from its exact express-mode wire. */
export function canonicalizeGoogleVertexWireId(wireModelId: string): CatalogWireIdentity | undefined {
  if (isMovingModelAlias(wireModelId)) return undefined;
  const separator = wireModelId.indexOf("/");
  const unqualified = separator < 0 ? wireModelId : wireModelId.slice(separator + 1);
  const stable = unqualified.replace(/@(?:default|20\d{6})$/, "").replace(/-maas$/, "");
  if (!stable.startsWith("gemini-")) return undefined;
  return canonicalCatalogModelId(stable);
}

const definition = {
  id: "google_vertex",
  displayName: "Google Vertex",
  shortName: "Vertex",
  supportedFamilies: ["google"],
  defaultChatTransport: "google",
  configHints: ["flywheel auth login --google-vertex"],
  cli: { flag: "google-vertex", name: "Google Vertex" },
  billing: "metered",
  spendMode: "direct_api",
  rank: 75,
  catalogId: undefined,
  dynamicCatalog: {
    limits: DEFAULT_DYNAMIC_CATALOG_LIMITS,
    extractRows: extractDataCatalogRows,
    canonicalize: canonicalizeIdCatalogRow,
    canonicalizeWireId: canonicalizeGoogleVertexWireId,
    modelsDevCatalogIds: ["google-vertex"],
    probeAccess: async ({ credential, wireModelId, signal }) => {
      if (credential.type !== "api_key") return "inconclusive";
      try {
        const response = await fetch(`https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(wireModelId)}:countTokens`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": Redacted.value(credential.key) },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "OK" }] }] }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        });
        await response.body?.cancel();
        if (response.status === 200) return "completed";
        if (response.status === 404) return "refused";
        return "inconclusive";
      } catch {
        if (signal.aborted) throw signal.reason;
        return "inconclusive";
      }
    },
  },
  auth: { kind: "api_key", statusRank: 50, keyPrefix: { prefix: "AQ.", description: "a Google Vertex AI express key" } },
} as const satisfies AccessProviderDefinition;

const createClient: AccessProviderFactory = async (build) => {
  const info = requireModelMetadata(build.model, build.attribution.resolvedModelMetadata);
  const described = await describeProvider(build.model, { accessProvider: definition.id, protocol: "google", providerHint: "google", resolvedModelMetadata: info });
  return stagedProviderClient(build, described, async () => {
    const key = apiKey(build.connection.auth, definition.id);
    if (!key) throw new ApiError({ message: "No Google Vertex API key in the active auth profile. Run: flywheel auth login --google-vertex", recovery: { kind: "none" } });
    const { createGoogleAdapter } = await import("../../agent-runtime/llm/google.js");
    return createGoogleAdapter(key, build.wireModelId, info, { accessProvider: definition.id });
  });
};

export const googleVertexModule = {
  id: "provider-google-vertex",
  dependencies: [],
  availability: { kind: "available" },
  contributions: [
    { domain: "providers", id: "google_vertex", value: { definition, createClient } },
    { domain: "settings", id: "provider-google-vertex", value: { control: "binary", group: "Model providers", label: definition.displayName, description: "Allow Gemini models through a Vertex AI express API key" } },
  ],
  observers: [], transformers: [], gates: [],
} as const satisfies FirstPartyModule;

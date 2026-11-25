import { Redacted } from "effect";
import { apiKeyCredential, type OAuthPersistencePolicy, type RuntimeApiKeyCredential } from "../../../infra/auth/auth-context.js";
import { setMeteredKeyProject } from "../../../infra/auth/store/auth-store-mutations.js";
import type { CredentialSlotClassifier } from "../../../infra/auth/store/auth-store-types.js";
import type { AccessProviderDefinition } from "../../../infra/llm/access/access-provider.js";
import { awaitWithAbortSignal } from "../../../infra/abort.js";
import { errorMessage } from "../../../infra/error-message.js";
import { Log } from "../../../infra/diagnostics/log.js";
import { canonicalizeIdCatalogRow, extractDataCatalogRows, type CatalogWireIdentity } from "../../../infra/llm/catalog/model-catalog-resolution.js";
import { DEFAULT_DYNAMIC_CATALOG_LIMITS } from "../../../infra/model-catalog-rows.js";
import { canonicalCatalogModelId, isMovingModelAlias } from "../../../infra/model-id.js";
import { ApiError } from "../../agent-runtime/llm/routing/runtime-errors.js";
import { LlmStreamError } from "../../agent-runtime/llm/errors.js";
import { normalizeProviderAttemptFailure } from "../../agent-runtime/llm/stream/provider-failure.js";
import { providerAdapter, type AccessProviderFactory } from "../../agent-runtime/llm/routing/client-factory.js";
import { describeProvider, requireModelMetadata } from "../../agent-runtime/llm/provider-description.js";
import type { FirstPartyModule } from "../../module-catalog.js";

/** Vertex AI in express mode: the Gemini wire on aiplatform.googleapis.com,
 *  authenticated with an API key (Google Cloud "AQ." keys). Enterprise keys
 *  are commonly restricted to the Vertex surface and rejected by the Gemini
 *  Developer API, which the google_api provider serves. Vertex publishes no
 *  model listing an express key can read, so the catalog is every Gemini
 *  chat model models.dev knows for the surface.
 *
 *  Every request names the key's project in the global location, because
 *  Vertex sends a request without a project to one regional location, where
 *  newer models are not served. No lookup interface accepts an express key,
 *  so the project number comes from the not-found reply to a model that does
 *  not exist (ARCH-PROVIDERS-082, PI-MODEL-092). */
const PROVIDER_ID = "google_vertex";
const log = Log.create({ service: "provider-google-vertex" });

/** A model id that Vertex serves nowhere, so its not-found reply names the key's project. */
const DISCOVERY_MODEL_ID = "flywheel-project-discovery";
const PROJECT_IN_REPLY = /projects\/(\d+)\/locations\//;

function vertexUrl(model: string, method: string, project?: string): string {
  const scope = project === undefined ? "" : `projects/${project}/locations/global/`;
  return `https://aiplatform.googleapis.com/v1/${scope}publishers/google/models/${encodeURIComponent(model)}:${method}`;
}

/** countTokens never bills, so a probe or a discovery spends nothing. */
function countTokens(key: Redacted.Redacted<string>, model: string, signal: AbortSignal | undefined, project?: string): Promise<Response> {
  return fetch(vertexUrl(model, "countTokens", project), {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": Redacted.value(key) },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "OK" }] }] }),
    signal: signal === undefined ? AbortSignal.timeout(30_000) : AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
}

/** A discovery reply that names no project. It keeps the reply's status and headers, so that a runtime caller can
 *  classify it as it classifies any other provider reply. */
class VertexDiscoveryError extends Error {
  constructor(message: string, readonly status: number, readonly headers: Headers) {
    super(message);
    this.name = "VertexDiscoveryError";
  }
}

/** Finds the project number of an express key from Vertex's not-found reply. It throws an error that names the
 *  cause for the person: a key that Vertex rejects, a reply that names no project, or a request that failed. */
async function discoverVertexProject(key: Redacted.Redacted<string>, signal?: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await countTokens(key, DISCOVERY_MODEL_ID, signal);
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason;
    throw new LlmStreamError(`Could not reach Google Vertex to find the key's project: ${errorMessage(error)}`, "transient", undefined, { cause: error });
  }
  if (response.status !== 404) await response.body?.cancel();
  if (response.status === 401) throw new VertexDiscoveryError("Google Vertex rejected this API key. Check that it is a valid Vertex AI express key.", response.status, response.headers);
  const project = response.status === 404 ? PROJECT_IN_REPLY.exec(await response.text())?.[1] : undefined;
  if (project === undefined) {
    throw new VertexDiscoveryError(`Google Vertex did not name the key's project (HTTP ${response.status}), so Flywheel cannot reach its models. Try again, or check that the key belongs to a Vertex AI project.`, response.status, response.headers);
  }
  return project;
}

interface SavedKeyAccount {
  readonly lineage?: string | undefined;
  readonly authDir: string;
  readonly classifySlot: CredentialSlotClassifier;
  readonly oauthPersistence: OAuthPersistencePolicy;
}

/** One discovery per credential lineage in this process: an audit pass probes every candidate with the same captured
 *  credential, and a lineage names one key for its whole life, so a found project never goes stale. */
const discoveries = new Map<string, Promise<string>>();

/** The key's project. A key saved before 2026-11-19 holds none: its first use finds it and saves it under the same
 *  lineage, so the key keeps its saved model access and needs no new login (PI-UPDATES-003). Remove this conversion
 *  after 2027-05-19, when a key without a project is treated as one to add again. */
function vertexProject(credential: RuntimeApiKeyCredential, account: SavedKeyAccount, signal?: AbortSignal): Promise<string> {
  if (credential.project !== undefined) return Promise.resolve(credential.project);
  const { lineage } = account;
  if (lineage === undefined) return discoverVertexProject(credential.key, signal);
  // The shared discovery runs without a caller's signal, so one caller that stops never fails the others that wait.
  const discovery = discoveries.get(lineage) ?? startDiscovery(credential, lineage, account);
  return awaitWithAbortSignal(discovery, signal);
}

function startDiscovery(credential: RuntimeApiKeyCredential, lineage: string, account: SavedKeyAccount): Promise<string> {
  const discovery = (async () => {
    const project = await discoverVertexProject(credential.key);
    if (account.oauthPersistence !== "profile") return project;
    // A store that cannot take the write keeps the key without a project, and the next process finds it again.
    try {
      const saved = await setMeteredKeyProject(PROVIDER_ID, lineage, project, account.authDir, account.classifySlot);
      log.info("Saved the Google Vertex project of a key added before projects were saved", { saved });
    } catch (error) {
      log.warn("Could not save the Google Vertex project of a key added before projects were saved", { errorKind: error instanceof Error ? error.name : typeof error });
    }
    return project;
  })();
  discoveries.set(lineage, discovery);
  void discovery.catch(() => { if (discoveries.get(lineage) === discovery) discoveries.delete(lineage); });
  return discovery;
}

/** Derives Vertex's shared model identity from its exact express-mode wire. */
function canonicalizeGoogleVertexWireId(wireModelId: string): CatalogWireIdentity | undefined {
  if (isMovingModelAlias(wireModelId)) return undefined;
  const separator = wireModelId.indexOf("/");
  const unqualified = separator < 0 ? wireModelId : wireModelId.slice(separator + 1);
  const stable = unqualified.replace(/@(?:default|20\d{6})$/, "").replace(/-maas$/, "");
  if (!stable.startsWith("gemini-")) return undefined;
  return canonicalCatalogModelId(stable);
}

const definition = {
  id: PROVIDER_ID,
  displayName: "Google Vertex",
  shortName: "Vertex",
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
    probeAccess: async ({ credential, wireModelId, signal, ...account }) => {
      if (credential.type !== "api_key") return "inconclusive";
      try {
        const project = await vertexProject(credential, account, signal);
        const response = await countTokens(credential.key, wireModelId, signal, project);
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
  auth: { kind: "api_key", statusRank: 50, keyPrefix: { prefix: "AQ.", description: "a Google Vertex AI express key" }, discoverProject: discoverVertexProject },
} as const satisfies AccessProviderDefinition;

const createClient: AccessProviderFactory = async (build) => {
  const info = requireModelMetadata(build.model, build.attribution.resolvedModelMetadata);
  return providerAdapter(build, (attribution) => describeProvider(build.model, { accessProvider: definition.id, protocol: "google", providerHint: "google", resolvedModelMetadata: requireModelMetadata(build.model, attribution.resolvedModelMetadata) }), async () => {
    const { connection } = build;
    const credential = apiKeyCredential(connection.auth, definition.id);
    if (!credential) throw new ApiError({ message: "No Google Vertex API key in the active auth profile. Run: flywheel auth login --google-vertex", recovery: { kind: "none" } });
    const project = await vertexProject(credential, { lineage: connection.auth.credentialLineages[definition.id], authDir: connection.authDir, classifySlot: build.classifySlot, oauthPersistence: connection.oauthPersistence }).catch((error: unknown) => {
      // A rejected key and a not-found reply that names no project do not change on a retry. Every other failure,
      // such as a lost connection or a 429 or 5xx reply, retries and fails over as a failed request does.
      if (error instanceof VertexDiscoveryError && (error.status === 401 || error.status === 404)) throw new ApiError({ message: error.message, recovery: { kind: "none" } });
      throw normalizeProviderAttemptFailure(error);
    });
    const { createGoogleAdapter } = await import("../../agent-runtime/llm/adapters/google/google.js");
    return createGoogleAdapter(credential.key, build.wireModelId, info, { vertexProject: project });
  }, (client, { attribution }) => client.withModelInfo(requireModelMetadata(build.model, attribution.resolvedModelMetadata)));
};

export const googleVertexModule = {
  id: "provider-google-vertex",
  dependencies: [],
  contributions: [
    { domain: "providers", id: "google_vertex", value: { definition, createClient } },
    { domain: "settings", id: "provider-google-vertex", value: { control: "binary", group: "Model providers", label: definition.displayName, description: "Allow Gemini models through a Vertex AI express API key" } },
  ],
} as const satisfies FirstPartyModule;

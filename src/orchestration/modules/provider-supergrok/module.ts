import { Redacted } from "effect";
import type { RuntimeOAuthCredential } from "../../../infra/auth/auth-context.js";
import { replaceCredentialInstance } from "../../../infra/auth/auth-store-mutations.js";
import { readBoundedJson } from "../../../infra/auth/bounded-json.js";
import { type StoredTokens, storedTokensToCredential } from "../../../infra/auth/openai-auth-types.js";
import type { AccessProviderDefinition } from "../../../infra/llm/access-provider.js";
import { canonicalizeProviderIdCatalogRow, DEFAULT_DYNAMIC_CATALOG_LIMITS, extractDataCatalogRows } from "../../../infra/llm/model-catalog-resolution.js";
import { classifyFetchFailure, fetchCatalog } from "../../../infra/llm/model-listing.js";
import { PROVIDER_REASONING_EFFORTS } from "../../../infra/llm/models.js";
import { providerModelInfo } from "../../../infra/llm/provider-model-info.js";
import { isRecord } from "../../../infra/record.js";
import { ApiError } from "../../agent-runtime/errors.js";
import { credentialForCandidate, stagedProviderClient, type AccessProviderFactory } from "../../agent-runtime/llm/client-factory.js";
import { describeProvider } from "../../agent-runtime/llm/provider-description.js";
import type { FirstPartyModule } from "../../modules.js";
import { applyXaiSubscriptionHeaders, XAI_SUBSCRIPTION_BASE_URL } from "./auth-types.js";
import { loginXai } from "./oauth.js";
import { createXaiTokenAccessor, ensureFreshXaiTokens, XaiTokenRefreshError, type XaiTokenAccessor } from "./token-refresh.js";
import { createSuperGrokUsageReader } from "./usage-reader.js";

const catalog = { limits: DEFAULT_DYNAMIC_CATALOG_LIMITS, extractRows: extractDataCatalogRows } as const;

const ACCESS_PROBE_TIMEOUT_MS = 30_000;
// Reasoning models spend output tokens before they answer; a smaller cap
// would end a subscribed model's probe as incomplete.
const ACCESS_PROBE_OUTPUT_TOKENS = 256;
const ACCESS_PROBE_RESPONSE_BYTES = 256 * 1024;

function canonicalizeXaiRow(row: unknown) {
  const canonical = canonicalizeProviderIdCatalogRow("xai", row);
  if (canonical === undefined || !isRecord(row)) return canonical;
  const contextLimit = positiveInteger(row.context_window);
  const reasoningEfforts = Array.isArray(row.reasoning_efforts) ? row.reasoning_efforts.flatMap((option: unknown) => {
    if (!isRecord(option)) return [];
    const effort = PROVIDER_REASONING_EFFORTS.find((value) => value === option.value);
    return effort === undefined ? [] : [effort];
  }) : [];
  return {
    ...canonical,
    ...(row.api_backend === "responses" ? { transport: "openai-responses" as const } : {}),
    metadata: {
      ...(typeof row.object === "string" ? { object: row.object } : {}),
      ...(typeof row.owned_by === "string" ? { owned_by: row.owned_by } : {}),
      ...(contextLimit === undefined ? {} : { context_window: contextLimit }),
    },
    resolvedMetadata: providerModelInfo({
      provider: "xai",
      id: canonical.modelId,
      ...(typeof row.name === "string" ? { name: row.name } : {}),
      ...(contextLimit === undefined ? {} : { contextLimit }),
      ...(typeof row.supports_reasoning_effort === "boolean" ? { reasoning: row.supports_reasoning_effort } : {}),
      ...(reasoningEfforts.length === 0 ? {} : { reasoningEfforts }),
    }),
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** xAI tokens cross the store boundary in the OpenAI stored-token shape. */
function oauthCredential(tokens: StoredTokens): RuntimeOAuthCredential {
  return { type: "oauth", access: tokens.accessToken, ...(tokens.refreshToken === undefined ? {} : { refresh: tokens.refreshToken }), expires: tokens.expiresAtMs, ...(tokens.accountId === undefined ? {} : { accountId: tokens.accountId }) };
}

function storedTokens(credential: RuntimeOAuthCredential): StoredTokens {
  return { accessToken: credential.access, refreshToken: credential.refresh, expiresAtMs: credential.expires, ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }) };
}

const definition = {
  id: "supergrok",
  displayName: "SuperGrok Subscription",
  shortName: "SuperGrok",
  billingUrl: "https://grok.com/?_s=billing",
  supportedFamilies: ["openai"],
  defaultChatTransport: "openai-responses",
  configHints: ["flywheel auth login --supergrok"],
  cli: { flag: "supergrok", name: "SuperGrok" },
  billing: "subscription",
  paidModes: ["prepaid", "automatic"],
  rank: 40,
  catalogId: "xai",
  dynamicCatalog: {
    ...catalog,
    canonicalize: canonicalizeXaiRow,
    modelsDevCatalogIds: ["xai"],
    fetch: async ({ credential, instance, authDir, classifySlot, oauthPersistence, signal }) => {
      if (credential.type !== "oauth" || instance === undefined) return { discovery: { kind: "not-attempted" }, credential };
      try {
        const tokens = await ensureFreshXaiTokens(storedTokens(credential), {
          compareAndSet: (expected, next, refreshSignal) => replaceCredentialInstance(definition.id, instance.instanceId, storedTokensToCredential(expected), storedTokensToCredential(next), authDir, classifySlot, refreshSignal),
        }, signal, oauthPersistence);
        // Provider-call adapter: the token is unwrapped only into the header.
        const discovery = await fetchCatalog(`${XAI_SUBSCRIPTION_BASE_URL}/models`, { Authorization: `Bearer ${Redacted.value(tokens.accessToken)}`, "X-XAI-Token-Auth": "xai-grok-cli" }, catalog, signal);
        return { discovery, credential: oauthCredential(tokens) };
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof XaiTokenRefreshError) {
          const reason = error.reason;
          const authInvalid = reason.kind === "no_refresh_token"
            || reason.kind === "refresh_forbidden"
            || (reason.kind === "http" && (reason.status === 401 || reason.status === 403 || reason.code === "invalid_grant"));
          return { discovery: authInvalid ? { kind: "auth-invalid" } : { kind: "failed", reason: "transport" }, credential };
        }
        return { discovery: classifyFetchFailure(error), credential };
      }
    },
    probeAccess: async ({ credential, instance, wireModelId, authDir, classifySlot, oauthPersistence, signal }) => {
      if (credential.type !== "oauth" || instance === undefined) return "inconclusive";
      try {
        const tokens = await ensureFreshXaiTokens(storedTokens(credential), {
          compareAndSet: (expected, next, refreshSignal) => replaceCredentialInstance(definition.id, instance.instanceId, storedTokensToCredential(expected), storedTokensToCredential(next), authDir, classifySlot, refreshSignal),
        }, signal, oauthPersistence);
        const headers = new Headers({ "content-type": "application/json" });
        applyXaiSubscriptionHeaders(headers, tokens.accessToken);
        const response = await fetch(`${XAI_SUBSCRIPTION_BASE_URL}/responses`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: wireModelId, input: "Reply with only OK.", max_output_tokens: ACCESS_PROBE_OUTPUT_TOKENS, store: false }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(ACCESS_PROBE_TIMEOUT_MS)]),
        });
        if (response.status === 402) {
          await response.body?.cancel();
          return "refused";
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          return "inconclusive";
        }
        const body = await readBoundedJson(response, ACCESS_PROBE_RESPONSE_BYTES);
        return isRecord(body) && body.status === "completed" ? "completed" : "inconclusive";
      } catch {
        if (signal.aborted) throw signal.reason;
        return "inconclusive";
      }
    },
  },
  auth: {
    kind: "oauth",
    credentialId: "supergrok",
    flow: "device-code",
    statusRank: 80,
    start: async (ports) => {
      const tokens = await loginXai(ports);
      return { ...(tokens.email === undefined ? {} : { identity: tokens.email }), credential: oauthCredential(tokens) };
    },
  },
} as const satisfies AccessProviderDefinition;

const tokenAccessors = new WeakMap<object, Map<string, XaiTokenAccessor>>();

function tokenAccessor(build: Parameters<AccessProviderFactory>[0], seed: StoredTokens): XaiTokenAccessor {
  if (build.candidate.kind !== "subscription") throw new ApiError({ message: "SuperGrok requires a subscription candidate", recovery: { kind: "none" } });
  const candidate = build.candidate;
  const byCandidate = tokenAccessors.get(build.connection) ?? new Map<string, XaiTokenAccessor>();
  tokenAccessors.set(build.connection, byCandidate);
  const existing = byCandidate.get(candidate.instanceId);
  if (existing) return existing;
  const accessor = createXaiTokenAccessor(seed, {
    compareAndSet: (expected, next) => replaceCredentialInstance(
      definition.id,
      candidate.instanceId,
      storedTokensToCredential(expected),
      storedTokensToCredential(next),
      build.connection.authDir,
      build.classifySlot,
    ),
  }, build.connection.oauthPersistence);
  byCandidate.set(candidate.instanceId, accessor);
  return accessor;
}

const createClient: AccessProviderFactory = async (build) => {
  if (build.candidate.kind !== "subscription") throw new ApiError({ message: "SuperGrok requires a subscription candidate", recovery: { kind: "none" } });
  const described = await describeProvider(build.model, { accessProvider: definition.id, protocol: "openai-responses", providerHint: definition.catalogId, resolvedModelMetadata: build.attribution.resolvedModelMetadata });
  return stagedProviderClient(build, described, async () => {
    const cred = credentialForCandidate(build.connection, build.candidate);
    if (cred?.type !== "oauth") throw new ApiError({ message: "No SuperGrok tokens found. Run: flywheel auth login --supergrok", recovery: { kind: "none" } });
    const seed = storedTokens(cred);
    const [{ createOpenAIAdapter }, { createXaiOpenAIClient }] = await Promise.all([import("../../agent-runtime/llm/openai.js"), import("./client.js")]);
    return createOpenAIAdapter({ kind: "apiKey", apiKey: seed.accessToken }, build.wireModelId, build.modelsClient, {
      client: createXaiOpenAIClient(tokenAccessor(build, seed)),
      accessProvider: definition.id, catalogId: definition.catalogId, candidate: build.candidate, resolvedModelMetadata: build.attribution.resolvedModelMetadata ?? null,
    });
  });
};

export const supergrokModule = {
  id: "provider-supergrok",
  dependencies: [],
  availability: { kind: "available" },
  contributions: [
    { domain: "providers", id: "supergrok", value: { definition, createClient, usageReader: createSuperGrokUsageReader() } },
    { domain: "settings", id: "provider-supergrok", value: { control: "binary", group: "Model providers", label: definition.displayName, description: "Allow xAI models through a SuperGrok subscription" } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule;

import { Effect, Redacted, Scope } from "effect";
import type { RuntimeOAuthCredential } from "../../../infra/auth/auth-context.js";
import { replaceCredentialInstance } from "../../../infra/auth/auth-store-mutations.js";
import { type StoredTokens, storedTokensToCredential } from "../../../infra/auth/openai-auth-types.js";
import { extractDisplayIdentityFromJwt } from "../../../infra/auth/openai-jwt.js";
import type { AccessProviderDefinition } from "../../../infra/llm/access-provider.js";
import { DEFAULT_DYNAMIC_CATALOG_LIMITS } from "../../../infra/llm/model-catalog-resolution.js";
import { ApiError } from "../../agent-runtime/errors.js";
import { normalizeProviderAttemptFailure, ProviderAuthenticationError } from "../../agent-runtime/llm/provider-failure.js";
import { ensureFreshChatGPTTokens, getConnectionChatGPTTokenAccessor, rotateChatGPTTokens } from "../../agent-runtime/llm/openai-chatgpt.js";
import { startBrowserFlow } from "../../auth/openai-oauth.js";
import { credentialForCandidate, stagedProviderClient, type AccessProviderFactory } from "../../agent-runtime/llm/client-factory.js";
import { describeProvider } from "../../agent-runtime/llm/provider-description.js";
import { retainWebSocketSession } from "../../agent-runtime/llm/chatgpt-adapter/websocket-session.js";
import type { FirstPartyModule } from "../../modules.js";
import { canonicalizeChatGptRow, CHATGPT_CATALOG, fetchChatGPTModels } from "./catalog.js";
import { createChatGPTResetConsumer, createChatGPTUsageReader, isModelWindowMetric } from "./usage-reader.js";

function oauthCredential(tokens: StoredTokens): RuntimeOAuthCredential {
  return { type: "oauth", access: tokens.accessToken, ...(tokens.refreshToken === undefined ? {} : { refresh: tokens.refreshToken }), expires: tokens.expiresAtMs, ...(tokens.accountId === undefined ? {} : { accountId: tokens.accountId }) };
}

function storedTokens(credential: RuntimeOAuthCredential): StoredTokens {
  return { accessToken: credential.access, refreshToken: credential.refresh, expiresAtMs: credential.expires, ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }) };
}

const definition = {
  id: "chatgpt",
  displayName: "ChatGPT Subscription",
  shortName: "ChatGPT",
  billingUrl: "https://help.openai.com/en/articles/9039756-managing-billing-settings-on-chatgpt-web-and-platform",
  supportedFamilies: ["openai"],
  defaultChatTransport: "openai-responses",
  configHints: ["flywheel auth login"],
  cli: { flag: "chatgpt", name: "ChatGPT" },
  billing: "subscription",
  paidModes: ["prepaid", "automatic"],
  rank: 10,
  catalogId: undefined,
  dynamicCatalog: {
    limits: DEFAULT_DYNAMIC_CATALOG_LIMITS,
    extractRows: CHATGPT_CATALOG.extractRows,
    canonicalize: canonicalizeChatGptRow,
    modelsDevCatalogIds: ["openai"],
    fetch: async ({ credential, instance, authDir, classifySlot, oauthPersistence, signal }) => {
      if (credential.type !== "oauth" || instance === undefined) return { discovery: { kind: "not-attempted" }, credential };
      try {
        const tokens = await ensureFreshChatGPTTokens(storedTokens(credential), {
          caller: "model catalog",
          signal,
          persistence: oauthPersistence,
          compareAndSet: (expected, next) => replaceCredentialInstance(definition.id, instance.instanceId, storedTokensToCredential(expected), storedTokensToCredential(next), authDir, classifySlot),
        });
        const discovery = await fetchChatGPTModels(tokens.accessToken, tokens.accountId, signal, definition.dynamicCatalog);
        return { discovery, credential: oauthCredential(tokens) };
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof ProviderAuthenticationError || normalizeProviderAttemptFailure(error).failure._tag === "AuthFailure") {
          return { discovery: { kind: "auth-invalid" }, credential };
        }
        return { discovery: { kind: "failed", reason: "transport" }, credential };
      }
    },
  },
  auth: {
    kind: "oauth",
    credentialId: "chatgpt",
    flow: "browser",
    statusRank: 60,
    start: async (ports) => {
      const tokens = await startBrowserFlow(ports);
      // The id token names the account; the access token's claims are the
      // fallback identity when the provider omits the email.
      const identity = tokens.email ?? tokens.accountId ?? extractDisplayIdentityFromJwt(Redacted.value(tokens.accessToken));
      return { ...(identity === undefined ? {} : { identity }), credential: oauthCredential(tokens) };
    },
    refresh: async (credential, signal) => oauthCredential(await rotateChatGPTTokens(storedTokens(credential), signal)),
  },
  usage: {
    metricDetail: isModelWindowMetric,
    // The usage reader keeps the plan_type that ChatGPT reports; a guest has no paid plan either.
    freePlan: ({ plan }) => plan === "free" || plan === "guest",
  },
} as const satisfies AccessProviderDefinition;

const createClient: AccessProviderFactory = async (build) => {
  if (build.candidate.kind !== "subscription") throw new ApiError({ message: "ChatGPT requires a subscription candidate", recovery: { kind: "none" } });
  const candidate = build.candidate;
  const described = await describeProvider(build.model, { accessProvider: definition.id, protocol: "openai-responses", providerHint: "openai", resolvedModelMetadata: build.attribution.resolvedModelMetadata });
  const { providerSessionKey, scope } = build.providerSessionLifetime;
  await Effect.runPromise(Scope.provide(scope)(Effect.acquireRelease(
    Effect.sync(() => retainWebSocketSession(providerSessionKey)),
    (release) => Effect.sync(release),
  )));
  return stagedProviderClient(build, described, async () => {
    const cred = credentialForCandidate(build.connection, candidate);
    if (cred?.type !== "oauth") throw new ApiError({ message: "No ChatGPT tokens found. Run: flywheel auth login", recovery: { kind: "none" } });
    const { createOpenAIAdapter } = await import("../../agent-runtime/llm/openai.js");
    return createOpenAIAdapter({ kind: "chatgpt", accessToken: cred.access, refreshToken: cred.refresh, expiresAtMs: cred.expires, ...(cred.accountId === undefined ? {} : { accountId: cred.accountId }) }, build.wireModelId, build.modelsClient, {
      oauthPersistence: build.connection.oauthPersistence,
      tokenAccessor: getConnectionChatGPTTokenAccessor(
        build.connection,
        candidate.instanceId,
        (expected, next) => replaceCredentialInstance(
          definition.id,
          candidate.instanceId,
          storedTokensToCredential(expected),
          storedTokensToCredential(next),
          build.connection.authDir,
          build.classifySlot,
        ),
      ),
      availableModels: null,
      availability: build.availability,
      candidate,
      resolvedModelMetadata: build.attribution.resolvedModelMetadata ?? null,
      projectRoot: build.projectRoot,
    });
  });
};

export const chatgptModule = {
  id: "provider-chatgpt",
  dependencies: [],
  availability: { kind: "available" },
  contributions: [
    { domain: "providers", id: "chatgpt", value: { definition, createClient, usageReader: createChatGPTUsageReader(), resetConsumer: createChatGPTResetConsumer() } },
    { domain: "settings", id: "provider-chatgpt", value: { control: "binary", group: "Model providers", label: definition.displayName, description: "Allow OpenAI models through a ChatGPT subscription" } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule;

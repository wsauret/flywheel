import { Redacted } from "effect";
import { replaceCredentialInstance } from "../../../infra/auth/store/auth-store-mutations.js";
import type { AccessProviderDefinition } from "../../../infra/llm/access/access-provider.js";
import { ApiError } from "../../agent-runtime/llm/routing/runtime-errors.js";
import { credentialForCandidate, providerAdapter, type AccessProviderFactory } from "../../agent-runtime/llm/routing/client-factory.js";
import type { ProviderAffordabilityFactory } from "../../agent-runtime/llm/routing/provider-affordability.js";
import type { ProviderAllowanceFactory } from "../../agent-runtime/llm/routing/provider-availability-types.js";
import { describeProvider, requireModelMetadata } from "../../agent-runtime/llm/provider-description.js";
import type { FirstPartyModule } from "../../modules.js";
import { copilotAffordability } from "./affordability.js";
import { captureCopilotAllowanceAdmission } from "./allowance-admission.js";
import { copilotTokensToCredential } from "./auth-types.js";
import { COPILOT_CATALOG, copilotOAuthCredential, createCopilotCatalogFetch } from "./catalog.js";
import { buildCopilotDynamicHeaders } from "./headers.js";
import { normalizeCopilotCatalogRow } from "./model-support.js";
import { loginGitHubCopilot } from "./oauth.js";
import { createCopilotUsageReader } from "./quota-meter.js";

/** Flywheel's own ceiling on the pooled AI Credits a profile spends through
 *  Copilot included usage in one month. 0 is no ceiling. It applies only to pooled seats;
 *  a finite seat's own allowance is the provider's to enforce. */
const MONTHLY_CREDIT_CAP = { control: "number", key: "monthly_credit_cap", label: "Copilot monthly credit cap", description: "Monthly AI Credits cap on included Copilot use. 0 means no cap.", min: 0, max: 1_000_000, off: 0, defaultValue: 3_900, group: "Model providers" } as const;

const definition = {
  id: "github_copilot",
  displayName: "Copilot Subscription",
  shortName: "Copilot",
  billingUrl: "https://github.com/settings/billing",
 
  defaultChatTransport: "chat-completions",
  configHints: ["flywheel auth login --copilot"],
  cli: { flag: "copilot", name: "GitHub Copilot" },
  billing: "subscription",
  paidModes: ["automatic"],
  rank: 20,
  catalogId: "github-copilot",
  dynamicCatalog: {
    ...COPILOT_CATALOG,
    canonicalize: normalizeCopilotCatalogRow,
    modelsDevCatalogIds: ["github-copilot"],
    modelsDevMetadataFields: ["contextLimit", "totalContextLimit"],
    fetch: createCopilotCatalogFetch(),
  },
  auth: {
    kind: "oauth",
    credentialId: "github_copilot",
    flow: "device-code",
    statusRank: 70,
    start: async (ports) => {
      const tokens = await loginGitHubCopilot(ports);
      return { ...(tokens.identity === undefined ? {} : { identity: tokens.identity }), credential: copilotOAuthCredential(tokens) };
    },
  },
  usage: {
    allowanceCap: (settings) => settings[MONTHLY_CREDIT_CAP.key] === MONTHLY_CREDIT_CAP.off ? undefined : settings[MONTHLY_CREDIT_CAP.key],
    // The quota meter keeps GitHub's access_type_sku as the tier; Copilot Free reports free_limited_copilot.
    freePlan: ({ tier }) => tier === "free_limited_copilot",
  },
} as const satisfies AccessProviderDefinition;

const createClient: AccessProviderFactory = async (build) => {
  const { model, wireModelId, availability, connection, candidate } = build;
  if (candidate.kind !== "subscription") throw new ApiError({ message: "GitHub Copilot requires a subscription candidate", recovery: { kind: "none" } });
  const capturedEndpoint = build.attribution.transport;
  if (capturedEndpoint === undefined) throw new ApiError({ message: `Copilot did not advertise a supported endpoint for "${model}".`, recovery: { kind: "none" } });
  const endpoint = capturedEndpoint;
  const protocol = endpoint === "anthropic-messages" ? "anthropic" : endpoint === "chat-completions" ? "chat-completions" : "openai-responses";
  const info = requireModelMetadata(model, build.attribution.resolvedModelMetadata);
  return providerAdapter(build, (attribution) => describeProvider(model, { accessProvider: definition.id, protocol, providerHint: definition.catalogId, resolvedModelMetadata: requireModelMetadata(model, attribution.resolvedModelMetadata) }), async () => {
    const cred = credentialForCandidate(connection, build.candidate);
    if (cred?.type !== "oauth") throw new ApiError({ message: "No GitHub Copilot tokens found. Run: flywheel auth login --copilot", recovery: { kind: "none" } });
    const [{ buildCopilotClients }, { createAnthropicAdapter, operationsFromAnthropicClient }, { createOpenAIAdapter }, { createChatCompletionsAdapter }] = await Promise.all([
      import("./clients.js"), import("../../agent-runtime/llm/adapters/anthropic/anthropic.js"), import("../../agent-runtime/llm/adapters/openai/openai.js"), import("../../agent-runtime/llm/adapters/chat-completions/chat-completions.js"),
    ]);
    const { anthropic, openai } = buildCopilotClients(
      cred, connection, candidate,
      (expected, next) => replaceCredentialInstance(
        definition.id,
        candidate.instanceId,
        copilotTokensToCredential(expected),
        copilotTokensToCredential(next),
        connection.authDir,
        build.classifySlot,
      ),
    );
    if (endpoint === "anthropic-messages") return createAnthropicAdapter(Redacted.make("copilot"), wireModelId, info, {
      operations: operationsFromAnthropicClient(anthropic), accessProvider: definition.id, catalogId: definition.catalogId, extraHeaders: (options) => buildCopilotDynamicHeaders(options.messages),
      availability, candidate,
    });
    if (endpoint === "chat-completions") return createChatCompletionsAdapter(openai, wireModelId, info, {
      accessProvider: definition.id, extraHeaders: (options) => buildCopilotDynamicHeaders(options.messages),
      availability, candidate,
    });
    return createOpenAIAdapter({ kind: "apiKey", apiKey: Redacted.make("copilot") }, wireModelId, info, {
      client: openai, accessProvider: definition.id, catalogId: definition.catalogId, extraHeaders: (options) => buildCopilotDynamicHeaders(options.messages),
      availability, candidate,
    });
  }, (client, { attribution }) => client.withModelInfo(requireModelMetadata(model, attribution.resolvedModelMetadata)));
};
const createAffordability: ProviderAffordabilityFactory = () => copilotAffordability;
const allowance: ProviderAllowanceFactory = ({ candidates, usage, settings }) => captureCopilotAllowanceAdmission({ candidates, service: usage, monthlyCreditCap: definition.usage.allowanceCap(settings) });

export const githubCopilotModule = {
  id: "provider-github-copilot",
  dependencies: [],
  contributions: [
    { domain: "providers", id: "github_copilot", value: { definition, createClient, usageReader: createCopilotUsageReader(), affordability: createAffordability, allowance } },
    { domain: "settings", id: "provider-github-copilot", value: { control: "binary", group: "Model providers", label: definition.displayName, description: "Allow models through a GitHub Copilot subscription" } },
    { domain: "settings", id: `provider-github-copilot:${MONTHLY_CREDIT_CAP.key}`, value: MONTHLY_CREDIT_CAP },
  ],
} as const satisfies FirstPartyModule;

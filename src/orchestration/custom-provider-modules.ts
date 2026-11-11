import { Redacted } from "effect";
import { apiKey } from "../infra/auth/auth-context.js";
import { providerRequestHeaders } from "../infra/llm/provider-request-identity.js";
import { customProviderModelInfo } from "../infra/llm/models.js";
import { customProviderModelUnavailableReason, customProviders, type CustomProviderDefinition } from "../infra/llm/custom-provider-registry.js";
import type { AccessProviderDefinition } from "../infra/llm/access-provider.js";
import { ApiError } from "./agent-runtime/errors.js";
import { stagedProviderClient, type AccessProviderFactory } from "./agent-runtime/llm/client-factory.js";
import { describeProvider } from "./agent-runtime/llm/provider-description.js";
import type { FirstPartyModule } from "./modules.js";

/**
 * Materializes one capability module per [custom_providers] entry in the
 * installed registry. Each module is shaped exactly like a first-party
 * provider module, so composition, planning, listing, and client
 * construction need no custom-provider special case. Entries are declarative
 * config, not code: every custom provider speaks the OpenAI chat-completions
 * wire against its configured base URL.
 */
export function customProviderModules(): FirstPartyModule[] {
  return customProviders().map(customProviderModule);
}

function customProviderModule(entry: CustomProviderDefinition): FirstPartyModule {
  const definition: AccessProviderDefinition = {
    id: entry.id,
    displayName: entry.displayName,
    shortName: entry.displayName,
    supportedFamilies: ["openai"],
    defaultChatTransport: "openai-completions",
    configHints: [`flywheel auth login --provider ${entry.id}`],
    cli: { name: entry.displayName },
    billing: "metered",
    spendMode: "direct_api",
    // Explicit endpoints follow first-party providers for shared model names.
    rank: 90,
    catalogId: entry.catalogId ?? entry.id,
    auth: { kind: "api_key", statusRank: 50 },
    staticModelUnavailableReason: (model) => customProviderModelUnavailableReason(entry.id, model),
  };

  const createClient: AccessProviderFactory = async (build) => {
    const info = build.attribution.resolvedModelMetadata ?? customProviderModelInfo(entry, build.model);
    const described = await describeProvider(build.model, {
      accessProvider: entry.id,
      protocol: "openai-completions",
      providerHint: entry.catalogId ?? entry.id,
      resolvedModelMetadata: info,
    });
    return stagedProviderClient(build, described, async () => {
      const key = apiKey(build.connection.auth, entry.id);
      if (!key) throw new ApiError({ message: `No ${entry.displayName} API key in the active auth profile. Run: flywheel auth login --provider ${entry.id}`, recovery: { kind: "none" } });
      const [{ default: OpenAI }, { createOpenAIChatCompletionsAdapter }] = await Promise.all([import("openai"), import("./agent-runtime/llm/openai-completions.js")]);
      const client = new OpenAI({ apiKey: Redacted.value(key), baseURL: entry.baseUrl, defaultHeaders: await providerRequestHeaders(), maxRetries: 0 });
      return createOpenAIChatCompletionsAdapter(client, build.wireModelId, info, {
        accessProvider: entry.id,
        candidate: build.candidate,
        providerHint: entry.catalogId ?? "openai",
      });
    });
  };

  return {
    id: `provider-custom-${entry.id}`,
    dependencies: [],
    availability: { kind: "available" },
    contributions: [{ domain: "providers", id: entry.id, value: { definition, createClient } }],
    observers: [],
    transformers: [],
    gates: [],
  };
}

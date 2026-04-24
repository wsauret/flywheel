import type { ModelFamily } from "./model-family.js";
import type { AuthContext } from "../../../../../infra/auth/auth-context.js";

export type AccessProviderId = "anthropic_api" | "chatgpt" | "openai_api";

interface AccessProviderDefinition {
  id: AccessProviderId;
  supportedFamilies: readonly ModelFamily[];
  configHints: readonly string[];
  isConfigured: (auth: AuthContext) => boolean;
}

const ACCESS_PROVIDER_DEFINITIONS: readonly AccessProviderDefinition[] = [
  {
    id: "anthropic_api",
    supportedFamilies: ["anthropic"],
    configHints: ["ANTHROPIC_API_KEY"],
    isConfigured: (auth) => !!auth.anthropicApiKey,
  },
  {
    id: "chatgpt",
    supportedFamilies: ["openai"],
    configHints: ["openai_auth = \"chatgpt\" (or FLYWHEEL_OPENAI_AUTH=chatgpt)"],
    isConfigured: (auth) => auth.openaiAuth === "chatgpt",
  },
  {
    id: "openai_api",
    supportedFamilies: ["openai"],
    configHints: ["OPENAI_API_KEY"],
    isConfigured: (auth) => !!auth.openaiApiKey,
  },
];

function definitionsForFamily(family: ModelFamily): AccessProviderDefinition[] {
  return ACCESS_PROVIDER_DEFINITIONS.filter((definition) => definition.supportedFamilies.includes(family));
}

export function getConfiguredAccessProvidersForFamily(
  family: ModelFamily,
  auth: AuthContext,
): AccessProviderId[] {
  return definitionsForFamily(family)
    .filter((definition) => definition.isConfigured(auth))
    .map((definition) => definition.id);
}

export function buildMissingAccessProviderMessage(family: ModelFamily): string {
  const definitions = definitionsForFamily(family);
  if (definitions.length === 0) {
    return `No configured access provider supports ${family} models yet.`;
  }
  const hints = [...new Set(definitions.flatMap((definition) => definition.configHints))];
  return `No configured access provider for ${family} models. Configure ${hints.join(" or ")}.`;
}

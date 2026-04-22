import type { ModelFamily } from "./model-family.js";

export type AccessProviderId = "anthropic_api" | "chatgpt" | "openai_api";

interface AccessProviderDefinition {
  id: AccessProviderId;
  supportedFamilies: readonly ModelFamily[];
  configHints: readonly string[];
  isConfigured: (env: Record<string, string | undefined>) => boolean;
}

const ACCESS_PROVIDER_DEFINITIONS: readonly AccessProviderDefinition[] = [
  {
    id: "anthropic_api",
    supportedFamilies: ["anthropic"],
    configHints: ["ANTHROPIC_API_KEY"],
    isConfigured: (env) => !!env["ANTHROPIC_API_KEY"],
  },
  {
    id: "chatgpt",
    supportedFamilies: ["openai"],
    configHints: ["FLYWHEEL_OPENAI_AUTH=chatgpt"],
    isConfigured: (env) => env["FLYWHEEL_OPENAI_AUTH"] === "chatgpt",
  },
  {
    id: "openai_api",
    supportedFamilies: ["openai"],
    configHints: ["OPENAI_API_KEY"],
    isConfigured: (env) => !!env["OPENAI_API_KEY"],
  },
];

function definitionsForFamily(family: ModelFamily): AccessProviderDefinition[] {
  return ACCESS_PROVIDER_DEFINITIONS.filter((definition) => definition.supportedFamilies.includes(family));
}

export function getConfiguredAccessProvidersForFamily(
  family: ModelFamily,
  env: Record<string, string | undefined> = process.env,
): AccessProviderId[] {
  return definitionsForFamily(family)
    .filter((definition) => definition.isConfigured(env))
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

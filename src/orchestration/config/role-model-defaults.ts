import type { ModelFamily } from "../../infra/llm/model-family.js";
import type { Effort } from "../../infra/workflow-types.js";
import { normalizeSelectableModelId } from "./model-compatibility.js";
import { canonicalRoleId } from "./retired-config-names.js";

interface RoleModelPreference {
  model: string;
  effort: Effort;
}

export interface RoleModelCandidate extends RoleModelPreference {
  family: ModelFamily;
}

type CodedFamily = "openai" | "anthropic";

interface CodedPreference<F extends CodedFamily> extends RoleModelPreference {
  readonly family: F;
}

/** A role's benchmark result: one coded preference per family, the first preferred (PI-MODEL-016). The role's
 *  fallback is the price tier of its first preference, at that preference's effort, so the list is the one source. */
export type RoleModelPreferences =
  | readonly [CodedPreference<"openai">, CodedPreference<"anthropic">]
  | readonly [CodedPreference<"anthropic">, CodedPreference<"openai">];

type RoleModelDefaults = { readonly [K in string]: RoleModelPreferences };

/** Coded role policy. Each preference owns its effort. */
export const ROLE_MODEL_DEFAULTS = {
  chat: [
    { family: "openai", model: "gpt-6.1-sol", effort: "medium" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
  ],
  "workflow-agent": [
    { family: "openai", model: "gpt-6.1-sol", effort: "medium" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
  ],
  explorer: [
    { family: "openai", model: "gpt-6-luna", effort: "high" },
    { family: "anthropic", model: "claude-haiku-5.5", effort: "high" },
  ],
  reviewer: [
    { family: "openai", model: "gpt-6.1-sol", effort: "high" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "high" },
  ],
  "reviewer-elegance": [
    { family: "openai", model: "gpt-6.1-sol", effort: "medium" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
  ],
  "reviewer-mechanism": [
    { family: "openai", model: "gpt-6.1-sol", effort: "medium" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
  ],
  implementer: [
    { family: "openai", model: "gpt-6.1-sol", effort: "medium" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
  ],
  ship: [
    { family: "openai", model: "gpt-6-luna", effort: "high" },
    { family: "anthropic", model: "claude-haiku-5.5", effort: "high" },
  ],
  "reviewer-design": [
    { family: "openai", model: "gpt-6.1-sol", effort: "medium" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
  ],
  "reviewer-data-integrity": [
    { family: "openai", model: "gpt-6.1-sol", effort: "medium" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
  ],
  "reviewer-performance": [
    { family: "openai", model: "gpt-6.1-sol", effort: "medium" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
  ],
  "reviewer-security": [
    { family: "openai", model: "gpt-6.1-sol", effort: "medium" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
  ],
  "reviewer-uat": [
    { family: "openai", model: "gpt-6.1-sol", effort: "medium" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
  ],
  "learning-review": [
    { family: "openai", model: "gpt-6.1-sol", effort: "medium" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
  ],
  "title-generation": [
    { family: "openai", model: "gpt-6-luna", effort: "low" },
    { family: "anthropic", model: "claude-haiku-5.5", effort: "low" },
  ],
  "subagent-summary": [
    { family: "openai", model: "gpt-6-luna", effort: "low" },
    { family: "anthropic", model: "claude-haiku-5.5", effort: "low" },
  ],
  "benchmark-judge": [
    { family: "openai", model: "gpt-6.1-sol", effort: "high" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "high" },
  ],
  advisor: [
    { family: "openai", model: "gpt-6-astra", effort: "high" },
    { family: "anthropic", model: "claude-fable-5.2", effort: "high" },
  ],
} satisfies RoleModelDefaults;

/** Unknown reviewer subtypes inherit Reviewer; all other dynamic seats inherit Workflow Agent. */
export function roleModelPreferences(roleId: string): RoleModelPreferences {
  const canonicalRole = canonicalRoleId(roleId);
  return Object.entries(ROLE_MODEL_DEFAULTS).find(([id]) => id === canonicalRole)?.[1]
    ?? (canonicalRole.startsWith("reviewer-") ? ROLE_MODEL_DEFAULTS.reviewer : ROLE_MODEL_DEFAULTS["workflow-agent"]);
}

/** The role's coded preference of one family, for a caller that must run that family's model. */
export function codedRolePreference(roleId: string, family: CodedFamily): RoleModelPreference {
  const [first, second] = roleModelPreferences(roleId);
  const { model, effort } = first.family === family ? first : second;
  return { model, effort };
}

/** Select the first coded preference available under the active profile's
 *  provider listing. Returns undefined when no preference is listed, so the
 *  caller can use the role's tier fallback. */
export function selectRoleModelDefault(
  roleId: string,
  availableModels: ReadonlyMap<ModelFamily, ReadonlySet<string>> | undefined,
): RoleModelCandidate | undefined {
  return reachableRoleModelDefaults(roleModelPreferences(roleId), availableModels)[0];
}

/** The coded preferences that the active profile's provider listing names, in the role's order. */
export function reachableRoleModelDefaults(
  preferences: RoleModelPreferences,
  availableModels: ReadonlyMap<ModelFamily, ReadonlySet<string>> | undefined,
): RoleModelCandidate[] {
  return preferences.flatMap(({ model, effort }) => {
    const normalized = normalizeSelectableModelId(model);
    for (const [family, familyModels] of availableModels ?? []) {
      for (const listed of familyModels) {
        if (normalizeSelectableModelId(listed) === normalized) return [{ model: normalized, effort, family }];
      }
    }
    return [];
  });
}

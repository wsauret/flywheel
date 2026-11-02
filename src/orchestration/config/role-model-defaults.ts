import type { ModelFamily } from "../../infra/llm/model-family.js";
import type { Effort } from "../../infra/workflow-types.js";
import type { ModelTier } from "../../protocol/model-assignment-protocol-types.js";
import { normalizeSelectableModelId } from "./model-compatibility.js";
import { canonicalRoleId } from "./retired-config-names.js";

interface RoleModelPreference {
  model: string;
  effort: Effort;
}

export interface RoleModelCandidate extends RoleModelPreference {
  family: ModelFamily;
}

interface RoleModelDefault {
  readonly openai: RoleModelPreference;
  readonly anthropic: RoleModelPreference;
  readonly tier: { readonly tier: ModelTier; readonly effort: Effort };
}

type RoleModelDefaults = { readonly [K in string]: RoleModelDefault };

/** Coded role policy. Each preference owns its effort; the tier uses the OpenAI effort. */
export const ROLE_MODEL_DEFAULTS = {
  chat: {
    openai: { model: "gpt-6.1-sol", effort: "medium" },
    anthropic: { model: "claude-opus-5.5", effort: "medium" },
    tier: { tier: "mid", effort: "medium" },
  },
  "workflow-agent": {
    openai: { model: "gpt-6.1-sol", effort: "medium" },
    anthropic: { model: "claude-opus-5.5", effort: "medium" },
    tier: { tier: "mid", effort: "medium" },
  },
  explorer: {
    openai: { model: "gpt-6-luna", effort: "high" },
    anthropic: { model: "claude-haiku-5.5", effort: "high" },
    tier: { tier: "cheap", effort: "high" },
  },
  reviewer: {
    openai: { model: "gpt-6.1-sol", effort: "high" },
    anthropic: { model: "claude-opus-5.5", effort: "high" },
    tier: { tier: "mid", effort: "high" },
  },
  "reviewer-quality": {
    openai: { model: "gpt-6-astra", effort: "medium" },
    anthropic: { model: "claude-opus-5.5", effort: "high" },
    tier: { tier: "mid", effort: "medium" },
  },
  "reviewer-elegance": {
    openai: { model: "gpt-6-astra", effort: "medium" },
    anthropic: { model: "claude-opus-5.5", effort: "high" },
    tier: { tier: "mid", effort: "medium" },
  },
  "reviewer-mechanism": {
    openai: { model: "gpt-6-astra", effort: "medium" },
    anthropic: { model: "claude-opus-5.5", effort: "high" },
    tier: { tier: "mid", effort: "medium" },
  },
  implementer: {
    openai: { model: "gpt-6.1-sol", effort: "medium" },
    anthropic: { model: "claude-opus-5.5", effort: "medium" },
    tier: { tier: "mid", effort: "medium" },
  },
  ship: {
    openai: { model: "gpt-6-luna", effort: "high" },
    anthropic: { model: "claude-haiku-5.5", effort: "high" },
    tier: { tier: "cheap", effort: "high" },
  },
  "reviewer-design": {
    openai: { model: "gpt-6.1-sol", effort: "medium" },
    anthropic: { model: "claude-opus-5.5", effort: "medium" },
    tier: { tier: "mid", effort: "medium" },
  },
  "reviewer-data-integrity": {
    openai: { model: "gpt-6.1-sol", effort: "medium" },
    anthropic: { model: "claude-opus-5.5", effort: "medium" },
    tier: { tier: "mid", effort: "medium" },
  },
  "reviewer-performance": {
    openai: { model: "gpt-6.1-sol", effort: "medium" },
    anthropic: { model: "claude-opus-5.5", effort: "medium" },
    tier: { tier: "mid", effort: "medium" },
  },
  "reviewer-security": {
    openai: { model: "gpt-6.1-sol", effort: "medium" },
    anthropic: { model: "claude-opus-5.5", effort: "medium" },
    tier: { tier: "mid", effort: "medium" },
  },
  "reviewer-uat": {
    openai: { model: "gpt-6.1-sol", effort: "medium" },
    anthropic: { model: "claude-opus-5.5", effort: "medium" },
    tier: { tier: "mid", effort: "medium" },
  },
  "learning-review": {
    openai: { model: "gpt-6.1-sol", effort: "medium" },
    anthropic: { model: "claude-opus-5.5", effort: "medium" },
    tier: { tier: "mid", effort: "medium" },
  },
  "title-generation": {
    openai: { model: "gpt-6-luna", effort: "low" },
    anthropic: { model: "claude-haiku-5.5", effort: "low" },
    tier: { tier: "cheap", effort: "low" },
  },
  "subagent-summary": {
    openai: { model: "gpt-6-luna", effort: "low" },
    anthropic: { model: "claude-haiku-5.5", effort: "low" },
    tier: { tier: "cheap", effort: "low" },
  },
  "benchmark-judge": {
    openai: { model: "gpt-6.1-sol", effort: "high" },
    anthropic: { model: "claude-opus-5.5", effort: "high" },
    tier: { tier: "mid", effort: "high" },
  },
  advisor: {
    openai: { model: "gpt-6-astra", effort: "high" },
    anthropic: { model: "claude-fable-5.1", effort: "high" },
    tier: { tier: "powerful", effort: "high" },
  },
} satisfies RoleModelDefaults;

/** Unknown reviewer subtypes inherit Reviewer; all other dynamic seats inherit Workflow Agent. */
export function roleModelDefault(roleId: string): RoleModelDefault {
  const canonicalRole = canonicalRoleId(roleId);
  return Object.entries(ROLE_MODEL_DEFAULTS).find(([id]) => id === canonicalRole)?.[1]
    ?? (canonicalRole.startsWith("reviewer-") ? ROLE_MODEL_DEFAULTS.reviewer : ROLE_MODEL_DEFAULTS["workflow-agent"]);
}

/** Select the first fixed candidate available under the active profile's
 *  provider listing. Returns undefined when neither preference is listed, so
 *  the caller can use the role's tier and effort. */
export function selectRoleModelDefault(
  roleId: string,
  availableModels: ReadonlyMap<ModelFamily, ReadonlySet<string>> | undefined,
): RoleModelCandidate | undefined {
  const defaults = roleModelDefault(roleId);
  if (!availableModels || availableModels.size === 0) return undefined;
  for (const preference of ["openai", "anthropic"] as const) {
    const candidate = defaults[preference];
    const normalized = normalizeSelectableModelId(candidate.model);
    for (const [family, familyModels] of availableModels) {
      for (const listed of familyModels) {
        if (normalizeSelectableModelId(listed) === normalized) {
          return { ...candidate, model: normalized, family };
        }
      }
    }
  }
  return undefined;
}

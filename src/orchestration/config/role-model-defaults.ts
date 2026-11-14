import type { ModelFamily } from "../../infra/llm/model-family.js";
import type { Effort } from "../../infra/workflow-types.js";
import { normalizeSelectableModelId } from "./model-compatibility.js";
import type { RankedModelTier } from "./model-tiers.js";
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

/** A role's benchmark result: one coded preference per family, the first preferred (PI-MODEL-016). */
export type RoleModelPreferences =
  | readonly [CodedPreference<"openai">, CodedPreference<"anthropic">]
  | readonly [CodedPreference<"anthropic">, CodedPreference<"openai">];

/** The tier a role falls back to when no coded preference is reachable, and the effort it runs at there. */
interface RoleTierFallback {
  readonly tier: RankedModelTier;
  readonly effort: Effort;
}

/** A role's coded policy (PI-MODEL-016). A benchmarked role copies the Policy block that `bun run bench:rank` prints
 *  for it: each family's top-scoring setting, the family with the higher top score first, and `fallback`, the average
 *  price tier (rounded toward cheaper) and the most common effort (a tie goes to the higher effort) of the settings that
 *  pass its filters. A role without `fallback` falls back to the price tier of its first preference, at that
 *  preference's effort. */
export interface RoleModelDefault {
  readonly preferences: RoleModelPreferences;
  readonly fallback?: RoleTierFallback;
}

type RoleModelDefaults = { readonly [K in string]: RoleModelDefault };

/** Coded role policy. Each preference owns its effort. */
export const ROLE_MODEL_DEFAULTS = {
  chat: { preferences: [
    { family: "openai", model: "gpt-6.1-sol", effort: "medium" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
  ] },
  "workflow-agent": { preferences: [
    { family: "openai", model: "gpt-6.1-sol", effort: "medium" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
  ] },
  // bench:rank on explorer-2026-11-13T21-20-04-158Z and explorer-2026-11-13T21-20-06-290Z.
  explorer: { preferences: [
    { family: "openai", model: "gpt-6.1-sol", effort: "low" },
    { family: "anthropic", model: "claude-sonnet-5.5", effort: "low" },
  ], fallback: { tier: "mid", effort: "medium" } },
  // The specialist reviewer default, which every reviewer role without its own entry inherits. Only quality runs on
  // stronger settings.
  reviewer: { preferences: [
    { family: "openai", model: "gpt-6.1-sol", effort: "medium" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
  ] },
  // bench:rank on reviewer-code-quality-2026-11-11T01-03-13-088Z, T01-04-30-041Z, T05-15-25-509Z, T06-50-30-346Z, and
  // T15-32-09-950Z.
  "reviewer-quality": { preferences: [
    { family: "openai", model: "gpt-6.1-sol", effort: "high" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
  ], fallback: { tier: "mid", effort: "xhigh" } },
  // bench:rank on reviewer-code-elegance-2026-11-11T21-48-22-147Z, reviewer-code-elegance-2026-11-12T00-44-54-328Z,
  // and reviewer-plan-elegance-2026-11-13T14-48-59-768Z.
  "reviewer-elegance": { preferences: [
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
    { family: "openai", model: "gpt-6.1-sol", effort: "medium" },
  ], fallback: { tier: "mid", effort: "medium" } },
  // bench:rank on reviewer-mechanism-2026-11-11T21-48-24-057Z.
  "reviewer-mechanism": { preferences: [
    { family: "openai", model: "gpt-6.1-sol", effort: "medium" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
  ], fallback: { tier: "mid", effort: "medium" } },
  // bench:rank on implementer-2026-11-13T21-16-42-634Z and implementer-2026-11-13T21-16-44-771Z. No Anthropic setting
  // passes the filters, so its top scorer goes second.
  implementer: { preferences: [
    { family: "openai", model: "gpt-6-astra", effort: "low" },
    { family: "anthropic", model: "claude-fable-5.2", effort: "low" },
  ], fallback: { tier: "mid", effort: "high" } },
  ship: { preferences: [
    { family: "openai", model: "gpt-6-luna", effort: "high" },
    { family: "anthropic", model: "claude-haiku-5.5", effort: "high" },
  ] },
  "reviewer-design": { preferences: [
    { family: "openai", model: "gpt-6.1-sol", effort: "medium" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
  ] },
  "reviewer-data-integrity": { preferences: [
    { family: "openai", model: "gpt-6.1-sol", effort: "medium" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
  ] },
  "reviewer-performance": { preferences: [
    { family: "openai", model: "gpt-6.1-sol", effort: "medium" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
  ] },
  "reviewer-security": { preferences: [
    { family: "openai", model: "gpt-6.1-sol", effort: "medium" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
  ] },
  "reviewer-uat": { preferences: [
    { family: "openai", model: "gpt-6.1-sol", effort: "medium" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
  ] },
  "learning-review": { preferences: [
    { family: "openai", model: "gpt-6.1-sol", effort: "medium" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "medium" },
  ] },
  "title-generation": { preferences: [
    { family: "openai", model: "gpt-6-luna", effort: "low" },
    { family: "anthropic", model: "claude-haiku-5.5", effort: "low" },
  ] },
  "subagent-summary": { preferences: [
    { family: "openai", model: "gpt-6-luna", effort: "low" },
    { family: "anthropic", model: "claude-haiku-5.5", effort: "low" },
  ] },
  "benchmark-judge": { preferences: [
    { family: "openai", model: "gpt-6.1-sol", effort: "high" },
    { family: "anthropic", model: "claude-opus-5.5", effort: "high" },
  ] },
  advisor: { preferences: [
    { family: "openai", model: "gpt-6-astra", effort: "high" },
    { family: "anthropic", model: "claude-fable-5.2", effort: "high" },
  ] },
} satisfies RoleModelDefaults;

/** Unknown reviewer subtypes inherit Reviewer; all other dynamic seats inherit Workflow Agent. */
export function roleModelDefault(roleId: string): RoleModelDefault {
  const canonicalRole = canonicalRoleId(roleId);
  return Object.entries(ROLE_MODEL_DEFAULTS).find(([id]) => id === canonicalRole)?.[1]
    ?? (canonicalRole.startsWith("reviewer-") ? ROLE_MODEL_DEFAULTS.reviewer : ROLE_MODEL_DEFAULTS["workflow-agent"]);
}

/** The role's coded preference of one family, for a caller that must run that family's model. */
export function codedRolePreference(roleId: string, family: CodedFamily): RoleModelPreference {
  const [first, second] = roleModelDefault(roleId).preferences;
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
  return reachableRoleModelDefaults(roleModelDefault(roleId).preferences, availableModels)[0];
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

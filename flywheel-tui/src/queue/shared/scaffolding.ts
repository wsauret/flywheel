import type { Step, StepType } from "../types";
import type { StepPaths } from "./step-paths";

export interface ScaffoldingResult {
  preamble: string;
  postamble: string;
}

export type ScaffoldingStrategy = (step: Step, paths: ScaffoldingPaths) => ScaffoldingResult;

export interface ScaffoldingPaths {
  handoffPath: string;
  planPath?: string;
  researchPath?: string;
  reviewPath?: string;
}

export type StepVariantKey = string;

export function variantKey(type: StepType, hint?: string): StepVariantKey {
  return hint ? `${type}:${hint}` : type;
}

const registry = new Map<StepVariantKey, ScaffoldingStrategy>();

export function registerScaffolding(key: StepVariantKey, strategy: ScaffoldingStrategy): void {
  registry.set(key, strategy);
}

// Title-based hint inference for steps that lack an explicit dispatcherHint.
// Maps title keywords to the canonical dispatcherHint used as registration keys.
const TITLE_HINT_MAP: Array<[keyword: string, type: string, hint: string]> = [
  ["draft", "plan", "draft"],
  ["review plan", "plan", "review"],
  ["consolidat", "plan", "consolidate"],
  ["dispatch", "review", "dispatch-reviewers"],
  ["multi-agent", "review", "dispatch-reviewers"],
  ["consolidat", "review", "consolidate-review"],
  ["learning", "ship", "learnings"],
  ["compound", "ship", "learnings"],
  ["extract", "ship", "learnings"],
  ["investigate", "debug", "investigate"],
  ["fix", "debug", "fix"],
  ["verify", "debug", "debug-verify"],
];

function inferHint(step: Step): string | undefined {
  if (step.dispatcherHint) return step.dispatcherHint;
  const title = step.title.toLowerCase();
  for (const [keyword, type, hint] of TITLE_HINT_MAP) {
    if (step.type === type && title.includes(keyword)) return hint;
  }
  // Type-level defaults for steps with no hint
  const typeDefaults: Record<string, string> = {
    plan: "research",
    review: "dispatch-reviewers",
    ship: "ship",
    debug: "investigate",
  };
  return typeDefaults[step.type];
}

/**
 * Build deterministic scaffolding for a step.
 * Resolves the variant key from (type, dispatcherHint) and looks up the
 * registered strategy. Falls back to type-only key, then empty scaffolding.
 */
export function buildScaffolding(step: Step, paths: ScaffoldingPaths): ScaffoldingResult {
  const hint = inferHint(step);
  const specific = registry.get(variantKey(step.type as StepType, hint));
  if (specific) return specific(step, paths);

  const generic = registry.get(step.type);
  if (generic) return generic(step, paths);

  return { preamble: "", postamble: "" };
}

export function toScaffoldingPaths(stepPaths: StepPaths, stepType: string, stepId: string): ScaffoldingPaths {
  return {
    handoffPath: stepPaths.handoffPath(stepType, stepId),
    planPath: stepPaths.planPath,
    researchPath: stepPaths.researchPath,
    reviewPath: stepPaths.reviewPath,
  };
}

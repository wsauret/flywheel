import type { Step } from "../types.js";

interface ScaffoldingResult {
  preamble: string;
  postamble: string;
}

type ScaffoldingStrategy = (step: Step, paths: ScaffoldingPaths) => ScaffoldingResult;

export interface ScaffoldingPaths {
  handoffPath: string;
}

export function variantKey(type: Step["type"], hint?: string): string {
  return hint ? `${type}:${hint}` : type;
}

const registry = new Map<string, ScaffoldingStrategy>();

export function registerScaffolding(key: string, strategy: ScaffoldingStrategy): void {
  registry.set(key, strategy);
}

export function buildScaffolding(step: Step, paths: ScaffoldingPaths): ScaffoldingResult {
  const hint = step.dispatcherHint;
  const specific = registry.get(variantKey(step.type, hint));
  if (specific) return specific(step, paths);

  const generic = registry.get(step.type);
  if (generic) return generic(step, paths);

  return { preamble: "", postamble: "" };
}

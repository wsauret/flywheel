import type { Step } from "../types.js";

interface ScaffoldingResult {
  preamble: string;
  postamble: string;
  produces?: string;
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

export function getStepProduces(key: string): string | undefined {
  const stubStep = { id: "", type: "work", title: "", status: "pending" } as Step;
  const stubPaths: ScaffoldingPaths = { handoffPath: "" };

  const isVariant = key.includes(":");
  if (isVariant) {
    const variantStrategy = registry.get(key);
    if (variantStrategy) {
      const produces = variantStrategy(stubStep, stubPaths).produces;
      if (produces !== undefined) return produces;
    }
    const typeKey = key.slice(0, key.indexOf(":"));
    const typeStrategy = registry.get(typeKey);
    if (typeStrategy) return typeStrategy(stubStep, stubPaths).produces;
    return undefined;
  }

  const strategy = registry.get(key);
  if (strategy) return strategy(stubStep, stubPaths).produces;
  return undefined;
}

import type { Step } from "../types.js";

export interface ScaffoldingResult {
  preamble: string;
  postamble: string;
}

export type ScaffoldingStrategy = (step: Step, paths: ScaffoldingPaths) => ScaffoldingResult;

export interface ScaffoldingPaths {
  handoffPath: string;
}

export function variantKey(type: Step["type"], hint?: string): string {
  return hint ? `${type}:${hint}` : type;
}

const registry = new Map<string, ScaffoldingStrategy>();
const producesMap = new Map<string, string>();

export function registerScaffolding(
  key: string,
  strategy: ScaffoldingStrategy,
  produces?: string,
): void {
  registry.set(key, strategy);
  if (produces !== undefined) producesMap.set(key, produces);
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
  if (key.includes(":")) {
    const variantProduces = producesMap.get(key);
    if (variantProduces !== undefined) return variantProduces;
    const typeKey = key.slice(0, key.indexOf(":"));
    return producesMap.get(typeKey);
  }
  return producesMap.get(key);
}

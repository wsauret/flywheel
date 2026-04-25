import type { z } from "zod";
import type { HandoffFieldSpec } from "../queue/shared/handoff-render.js";

export interface HandoffType {
  name: string;
  fields: readonly HandoffFieldSpec[];
  schema: z.ZodTypeAny;
  description?: string;
}

const registry = new Map<string, HandoffType>();

export function registerHandoffType(type: HandoffType): void {
  // Fail-fast: duplicate handoff-type names indicate a misconfigured registration root (unlike scaffolding, which allows variant overrides).
  if (registry.has(type.name)) {
    throw new Error(`Duplicate handoff type registration: ${type.name}`);
  }
  Object.freeze(type.fields);
  Object.freeze(type);
  registry.set(type.name, type);
}

export function getHandoffType(name: string): HandoffType | undefined {
  return registry.get(name);
}

export function getAllHandoffTypes(): HandoffType[] {
  return Array.from(registry.values());
}

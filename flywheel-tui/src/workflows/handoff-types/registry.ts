import type { z } from "zod";
import type { HandoffFieldSpec } from "../queue/shared/handoff-render.js";

export type { HandoffFieldSpec };

export interface HandoffType {
  name: string;
  fields: HandoffFieldSpec[];
  schema: z.ZodTypeAny;
  description?: string;
}

const registry = new Map<string, HandoffType>();

export function registerHandoffType(type: HandoffType): void {
  if (registry.has(type.name)) {
    throw new Error(`Duplicate handoff type registration: ${type.name}`);
  }
  registry.set(type.name, type);
}

export function getHandoffType(name: string): HandoffType | undefined {
  return registry.get(name);
}

export function getAllHandoffTypes(): HandoffType[] {
  return Array.from(registry.values());
}

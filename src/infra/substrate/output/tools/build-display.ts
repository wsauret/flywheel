import type { ToolInput } from "./detail-helpers.js";
import type { DetailToolDisplay } from "./types.js";

type RequiredFields = "name" | "action" | "displayName" | "verbs" | "getDetail";

type DisplayDef = Pick<DetailToolDisplay, RequiredFields> & Partial<Omit<DetailToolDisplay, RequiredFields>>;

/**
 * Apply defaults for an explicit ToolDisplay declaration. The registry caller uses
 * this for fallback synthesis; per-tool display contracts call it directly.
 */
export function buildDisplay(def: DisplayDef): DetailToolDisplay {
  return {
    isOptimistic: false,
    preservesResultContent: false,
    ...def,
  };
}

export function defaultDetailFromInput(input: ToolInput): string | null {
  const subject = input.subject;
  if (typeof subject === "string" && subject.length > 0) return subject;
  const description = input.description;
  if (typeof description === "string" && description.length > 0) return description;
  for (const val of Object.values(input)) {
    if (typeof val === "string" && val.length > 0) return val;
  }
  return null;
}

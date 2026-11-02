import { numField, strField, type ToolInput } from "../detail-helpers.js";
import type { ToolDisplay, ToolPresentationResolution } from "../types.js";

/** Positive integers only: a modifier is a real argument, and a zero, negative,
 *  or fractional historical value carries no reader value. */
function countModifier(input: ToolInput, key: string, render: (count: number) => string): string | null {
  const value = numField(input, key);
  return value !== undefined && Number.isInteger(value) && value > 0 ? render(value) : null;
}

function joinDetail(parts: readonly (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

function skillPresentation(input: ToolInput): ToolPresentationResolution {
  const skillId = strField(input, "skill_id");
  const path = strField(input, "path");
  switch (strField(input, "action")) {
    // Retired action: no current prompt advertises it, but stored transcripts
    // still hold list calls, so historical rendering keeps this shape.
    case "list": {
      const query = strField(input, "query");
      return {
        name: "List Skills",
        detail: joinDetail([
          query ? `"${query}"` : null,
          countModifier(input, "limit", (limit) => `| head -${limit}`),
          countModifier(input, "offset", (offset) => `| offset ${offset}`),
          countModifier(input, "page", (page) => `| page ${page}`),
        ]),
      };
    }
    case "load":
      return { name: "Load Skill", detail: skillId ?? "" };
    case "resource":
      return {
        name: "Read Skill Resource",
        detail: joinDetail([
          skillId && path ? `${skillId}/${path}` : (path ?? skillId),
          countModifier(input, "offset", (offset) => `| offset ${offset}`),
        ]),
      };
    default:
      // No known action: a streaming call has not named one yet, and a
      // malformed historical call names the family alone, with no argument.
      return "input_not_ready";
  }
}

export const skillDisplay: ToolDisplay = {
  name: "skill",
  action: "file_read",
  displayName: "Read Skill",
  verbs: { progressive: "Reading skill", past: "Read skill" },
  isOptimistic: false,
  getPresentation: skillPresentation,
  getSentence: (input, _cwd, presentation) => ({
    name: input.action === "load" ? "Loaded" : "Read",
    detail: `skill ${presentation.detail}`.trim(),
  }),
};
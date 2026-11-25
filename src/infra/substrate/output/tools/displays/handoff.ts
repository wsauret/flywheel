import { strField, type ToolInput } from "../detail-helpers.js";
import type { ToolDiffInfo, ToolDisplay } from "../types.js";

function handoffContent(input: ToolInput): string | undefined {
  if (Object.keys(input).length === 0) return undefined;
  return JSON.stringify(input, null, 2);
}

export const handoffDisplay: ToolDisplay = {
  name: "handoff",
  action: "handoff_write",
  displayName: "Handoff",
  verbs: { progressive: "Recording handoff", past: "Recorded handoff", blocked: "Held handoff" },
  isOptimistic: false,
  // The row reads what the agent handed off: the first line of its summary.
  getDetail: (input) => strField(input, "summary")?.split("\n", 1)[0]?.trim() || null,
  extractDiff: (input): ToolDiffInfo | undefined => {
    const content = handoffContent(input);
    return content ? { content, filetype: "json" } : undefined;
  },
};

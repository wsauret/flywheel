import { formatDisplayPath, searchDetail, strField } from "../detail-helpers.js";
import type { ToolDisplay } from "../types.js";

export const searchDisplay: ToolDisplay = {
  name: "search",
  action: "search",
  displayName: "Search",
  verbs: { progressive: "Searching", past: "Searched" },
  isOptimistic: true,
  preservesResultContent: true,
  streamingInput: {
    bodyFields: {},
    presentationFields: ["pattern", "path", "glob", "type", "output_mode"],
  },
  getDetail: (input, executionCwd) => searchDetail(input, executionCwd, "glob", "type"),
  getSentence: (input, cwd) => ({
    name: searchDisplay.verbs.past,
    detail: [strField(input, "pattern"), strField(input, "path") ? `in ${formatDisplayPath(strField(input, "path"), cwd)}` : undefined].filter(Boolean).join(" "),
  }),
};

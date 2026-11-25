import { fileSubject, formatDisplayPath, singleLine, strField } from "../detail-helpers.js";
import { getFiletype } from "../filetype.js";
import type { ToolDiffInfo, ToolDisplay } from "../types.js";

export const writeDisplay: ToolDisplay = {
  name: "write",
  action: "file_write",
  displayName: "Write",
  verbs: { progressive: "Writing", past: "Wrote" },
  isOptimistic: false,
  fileChangeKind: "create",
  streamingInput: {
    bodyFields: { content: "content" },
    presentationFields: ["path"],
  },
  getDetail: (input, executionCwd) => singleLine(formatDisplayPath(strField(input, "path"), executionCwd)),
  getSentence: (_input, _cwd, presentation) => ({ name: writeDisplay.verbs.past, detail: fileSubject(presentation.detail) }),
  extractDiff: (input): ToolDiffInfo | undefined => {
    // The input holds only the new content, not the content it may replace.
    // Surface it directly so the TUI applies syntax highlighting instead of
    // "all-added" diff coloring.
    const fp = strField(input, "path") ?? "";
    const content = strField(input, "content");
    if (!content) return undefined;
    return { content, filetype: getFiletype(fp) };
  },
};
import { fileSubject, formatDisplayPath, singleLine, strField } from "../detail-helpers.js";
import { getFiletype } from "../filetype.js";
import type { ToolDiffInfo, ToolDisplay, ToolPresentationResolution } from "../types.js";

function capturedPaths(input: string, pattern: RegExp): string[] {
  return [...input.matchAll(pattern)].flatMap((match) => {
    const path = match[1];
    return path === undefined ? [] : [path.trimEnd()];
  });
}

/** Extract active V4A paths and retired hashline section paths for historical replay. */
function extractDisplayPaths(input: string | undefined): string[] {
  if (!input) return [];
  const patchPaths = capturedPaths(input, /^\*\*\* (?:Add|Delete|Update) File: (.+)$/gm);
  return patchPaths.length > 0 ? patchPaths : capturedPaths(input, /^@@ (.+)$/gm);
}

function presentationForPath(path: string, executionCwd: string): ToolPresentationResolution {
  const detail = singleLine(formatDisplayPath(path, executionCwd));
  return detail === null ? "input_not_ready" : { name: "Edit", detail };
}

export const editDisplay: ToolDisplay = {
  name: "edit",
  action: "file_edit",
  displayName: "Edit",
  verbs: { progressive: "Editing", past: "Edited" },
  isOptimistic: false,
  getSentence: (input, _cwd, presentation) => ({
    name: editDisplay.verbs.past,
    detail: [...new Set((strField(input, "path") ? [strField(input, "path") ?? ""] : extractDisplayPaths(strField(input, "input"))).map(fileSubject))].join(", ") || fileSubject(presentation.detail),
  }),
  fileChangeKind: (input) => strField(input, "input") === undefined ? "replace" : "patch",
  streamingInput: {
    bodyFields: { "edits.*.old_string": "content", "edits.*.new_string": "content", old_string: "content", new_string: "content", input: "diff" },
    presentationFields: ["path", "input"],
  },
  getPresentation: (input, executionCwd) => {
    const explicitPath = strField(input, "path");
    if (explicitPath) return presentationForPath(explicitPath, executionCwd);
    const patch = strField(input, "input");
    if (patch === undefined) return "input_not_ready";
    const paths = extractDisplayPaths(patch);
    if (paths.length === 0) return "input_not_ready";
    if (paths.length > 1) return { name: "Edit", detail: "" };
    const path = paths[0];
    return path === undefined ? "input_not_ready" : presentationForPath(path, executionCwd);
  },
  extractDiff: (input): ToolDiffInfo | undefined => {
    const explicitPath = strField(input, "path");
    if (explicitPath) return { filetype: getFiletype(explicitPath) };
    const inputText = strField(input, "input");
    const path = extractDisplayPaths(inputText)[0];
    return path ? { filetype: getFiletype(path) } : undefined;
  },
};

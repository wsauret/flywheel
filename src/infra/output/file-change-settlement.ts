import type { ToolEntry } from "../output-blocks.js";

/** Removes bodies that describe an intended file change rather than a verified result. */
export function resetFailedFileChange(tool: ToolEntry): ToolEntry {
  if (tool.fileChangeKind === undefined) return tool;
  const {
    proposedDiff: _proposedDiff,
    invocationBody: _invocationBody,
    diff: _diff,
    content: _content,
    filetype: _filetype,
    ...settled
  } = tool;
  return settled;
}

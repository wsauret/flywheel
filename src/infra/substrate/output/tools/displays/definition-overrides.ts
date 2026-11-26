import { formatRelativePath, strField } from "../detail-helpers.js";
import type { ToolDisplay } from "../types.js";

/** Inspecting and preparing definition overrides. The tool declares itself
 *  bookkeeping, but its list and diff results are what a reader opens the
 *  row for, and only a command row discloses its output, so it presents as
 *  one. Both actions group under Ran. */
export const definitionOverridesDisplay: ToolDisplay = {
  name: "definition_overrides",
  action: "shell_exec",
  displayName: "Definition Overrides",
  verbs: { progressive: "Reviewing overrides", past: "Reviewed overrides" },
  isOptimistic: false,
  preservesResultContent: true,
  getDetail: (input, executionCwd) => [strField(input, "action")?.replaceAll("-", " "), formatRelativePath(strField(input, "path"), executionCwd)].filter(Boolean).join(" ") || null,
};

import { planStringEdit } from "../../../infra/file-edit/string-edit.js";
import { canonicalMutationPath } from "../../../infra/file-mutation-queue.js";
import { FileEditRefusal } from "../../file-edits/file-edit-operation.js";
import { publishToolFileEdits } from "./file-edit-tool-adapter.js";
import { lineRangeOfByteSpans } from "./file-read-ledger.js";
import { RetainedFileEditAuthority } from "../../file-edits/retained-file-edit-host.js";
import { resolveToolPath, sessionPathInput } from "./tool-paths.js";
import type { RuntimeTool, RuntimeToolInput, ToolContext, ToolResult } from "./types.js";
import type { StringEditPlan } from "../../../infra/file-edit/string-edit.js";

const EDIT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Absolute or cwd-relative path of the existing file" },
    old_string: { type: "string", description: "Exact text to replace, copied verbatim from a prior read or search result" },
    new_string: { type: "string", description: "Replacement text" },
    replace_all: { type: "boolean", description: "Replace every match instead of requiring exactly one; use only when every exact occurrence must change" },
  },
  required: ["path", "old_string", "new_string"],
} as const;

function inputString(input: RuntimeToolInput, key: "path" | "old_string" | "new_string"): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

export function assertStringEditReplaceAll(replaceAll: boolean, matchKind: StringEditPlan["matchKind"]): void {
  if (replaceAll && matchKind !== "exact" && matchKind !== "line-ending") {
    throw new FileEditRefusal(`replace_all matched only through the ${matchKind} tier; every occurrence must match exactly. Copy old_string exactly, or edit each occurrence on its own.`);
  }
}

export function createEditDefinition(): RuntimeTool {
  return {
    name: "edit",
    action: "file_edit",
    description: "Replace exact text in one existing file. The old_string must identify one match unless replace_all is true. The file is changed only if the captured content still matches at publication.",
    promptSnippet: "Replace exact text in one existing file.",
    inputSchema: EDIT_INPUT_SCHEMA,
    isConcurrencySafe: false,
    prepareAdmission: async (input, context) => sessionPathInput(input, context, "file"),
    reservedPaths: (input, executionCwd) => {
      const path = inputString(input, "path");
      return path ? [canonicalMutationPath(resolveToolPath(executionCwd, path))] : [];
    },
    async execute(input: RuntimeToolInput, context: ToolContext): Promise<ToolResult> {
      const path = inputString(input, "path");
      const oldString = inputString(input, "old_string");
      const newString = inputString(input, "new_string");
      if (path === undefined || oldString === undefined || newString === undefined || (input.replace_all !== undefined && typeof input.replace_all !== "boolean")) {
        return { content: "Invalid input: edit expects { path, old_string, new_string, replace_all? } with string text fields and an optional boolean.", outcome: "error" };
      }
      const unchanged = oldString === newString;
      const result = await publishToolFileEdits(context, {
        label: "Edit",
        paths: [path],
        admit: RetainedFileEditAuthority.admit,
        plan: ([admitted]) => {
          if (!admitted) throw new Error(`${path} was not admitted`);
          const before = admitted.authority.text;
          if (before === undefined) throw new Error(`${path} is not valid UTF-8`);
          const plan = planStringEdit(before, { oldString, newString, ...(input.replace_all === true ? { replaceAll: true } : {}) });
          if (unchanged) return [];
          if (plan.content === before) throw new FileEditRefusal("the replacement produced no change");
          assertStringEditReplaceAll(input.replace_all === true, plan.matchKind);
          const changedLines = lineRangeOfByteSpans(admitted.authority.encode(before), plan.spans);
          return [changedLines ? { admitted, after: plan.content, changedLines } : { admitted, after: plan.content }];
        },
      });
      return unchanged && result.outcome === "ok"
        ? { ...result, content: `Note: old_string and new_string are identical; ${path} is unchanged.` }
        : result;
    },
  };
}

export const editDefinition = createEditDefinition();

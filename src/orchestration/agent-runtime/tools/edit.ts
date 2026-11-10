import { editInputEntries, parseStringEdits } from "../../../infra/file-edit/edit-input.js";
import { planStringEdits } from "../../../infra/file-edit/string-edit.js";
import { canonicalMutationPath } from "../../../infra/file-mutation-queue.js";
import { coerceToolInput, describeInputRepair } from "./coerce-input.js";
import { publishToolFileEdits } from "./file-edit-tool-adapter.js";
import { lineRangeOfByteSpans } from "./file-read-ledger.js";
import { RetainedFileEditAuthority } from "../../file-edits/retained-file-edit-host.js";
import { resolveToolPath, sessionPathInput } from "./tool-paths.js";
import type { RuntimeTool, RuntimeToolInput, ToolContext, ToolResult } from "./types.js";
import type { ToolInputRepair } from "../llm/types.js";

const EDIT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Absolute or cwd-relative path of the existing file" },
    edits: {
      type: "array",
      minItems: 1,
      description: "Replacements in this file, applied together",
      items: {
        type: "object",
        properties: {
          old_string: { type: "string", description: "Exact text to replace, copied verbatim from file content shown earlier in this conversation" },
          new_string: { type: "string", description: "Replacement text" },
          replace_all: { type: "boolean", description: "Replace every match instead of requiring exactly one; use only when every exact occurrence must change" },
        },
        required: ["old_string", "new_string"],
      },
    },
  },
  required: ["path", "edits"],
} as const;

/** The earlier single-edit schema, with the entry fields beside `path`. */
const SINGLE_EDIT_SCHEMA = {
  type: "object",
  properties: { path: EDIT_INPUT_SCHEMA.properties.path, ...EDIT_INPUT_SCHEMA.properties.edits.items.properties },
  required: ["path", "old_string", "new_string"],
} as const;

/** Reads a call in the single-edit shape, with old_string and new_string beside path, as the one
 *  entry of `edits`: models that saw the earlier schema still write it. Dispatch coerced the call
 *  against the `edits` schema, which does not declare the entry fields at the top level, so the
 *  call is coerced again against the single-edit schema first; its synonym and scalar repairs
 *  then apply as they did before. Remove after 2027-05-09 together with the single-edit branch
 *  of `editInputEntries`. */
function singleEditAsEntry(input: Readonly<RuntimeToolInput>): { readonly input: RuntimeToolInput; readonly notice: string } | undefined {
  if (input.edits !== undefined) return undefined;
  const repairs: ToolInputRepair[] = [];
  const coerced = coerceToolInput(input, SINGLE_EDIT_SCHEMA, (repair) => repairs.push(repair));
  const [entry] = editInputEntries(coerced);
  if (entry === undefined) return undefined;
  const rest = Object.fromEntries(Object.entries(coerced).filter(([key]) => !Object.hasOwn(entry, key)));
  const keys = Object.keys(entry).map((key) => `\`${key}\``).join(", ");
  const lifted = `Note: ${keys} ${Object.keys(entry).length === 1 ? "was" : "were"} read as the one entry of \`edits\`.`;
  return { input: { ...rest, edits: [entry] }, notice: [...repairs.map(describeInputRepair), lifted].join("\n") };
}

export function createEditDefinition(): RuntimeTool {
  return {
    name: "edit",
    action: "file_edit",
    description: "Replace exact text in one existing file. Each edits[] entry's old_string must identify one match in the file as it was before this call, unless its replace_all is true; entries must not overlap, and an entry cannot match text that another entry of the same call produces. All entries apply together or none do. The file is changed only if the captured content still matches at publication.",
    promptSnippet: "Replace exact text in one existing file.",
    inputSchema: EDIT_INPUT_SCHEMA,
    isConcurrencySafe: false,
    prepareAdmission: async (input, context) => {
      const lifted = singleEditAsEntry(input);
      const { repair } = sessionPathInput(lifted?.input ?? input, context, "file");
      if (lifted === undefined) return repair ? { repair } : {};
      return { repair: repair ? { input: repair.input, notice: `${lifted.notice}\n${repair.notice}` } : lifted };
    },
    reservedPaths: (input, executionCwd) => typeof input.path === "string" ? [canonicalMutationPath(resolveToolPath(executionCwd, input.path))] : [],
    async execute(input: RuntimeToolInput, context: ToolContext): Promise<ToolResult> {
      const path = input.path;
      const edits = parseStringEdits(input.edits);
      if (typeof path !== "string" || edits === undefined) {
        return { content: "Invalid input: edit expects { path, edits: [{ old_string, new_string, replace_all? }, ...] } with at least one entry, string text fields, and an optional boolean.", outcome: "error" };
      }
      const unchanged = edits.every((edit) => edit.oldString === edit.newString);
      const result = await publishToolFileEdits(context, {
        label: "Edit",
        paths: [path],
        admit: RetainedFileEditAuthority.admit,
        plan: ([admitted]) => {
          if (!admitted) throw new Error(`${path} was not admitted`);
          const before = admitted.authority.text;
          if (before === undefined) throw new Error(`${path} is not valid UTF-8`);
          const plan = planStringEdits(before, edits);
          if (unchanged) return [];
          const changedLines = lineRangeOfByteSpans(admitted.authority.encode(before), plan.spans);
          return [changedLines ? { admitted, after: plan.content, changedLines } : { admitted, after: plan.content }];
        },
      });
      return unchanged && result.outcome === "ok"
        ? { ...result, content: `Note: every old_string equals its new_string; ${path} is unchanged.` }
        : result;
    },
  };
}

export const editDefinition = createEditDefinition();

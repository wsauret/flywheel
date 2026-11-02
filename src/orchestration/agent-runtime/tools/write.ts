/**
 * Write tool - whole-file creation.
 *
 * Creates a file with the provided content, including parent directories, and
 * refuses to overwrite an existing file. Display metadata lives in
 * `infra/tools/displays/write.ts`.
 */

import { canonicalMutationPath } from "../../../infra/file-mutation-queue.js";
import { FileEditRefusal } from "../../file-edits/file-edit-operation.js";
import { publishToolFileEdits } from "./file-edit-tool-adapter.js";
import { RetainedFileEditAuthority } from "../../file-edits/retained-file-edit-host.js";
import { resolveToolPath, sessionPathInput } from "./tool-paths.js";
import type { RuntimeTool, RuntimeToolInput, ToolContext, ToolResult } from "./types.js";

function existingFileRefusal(path: string, editTool: string): FileEditRefusal {
  return new FileEditRefusal(`File already exists: ${path}. Use the ${editTool} tool to modify existing files. The write tool is only for creating new files.`);
}

/** Read output pastes back as `N|text` on every line; a real file almost never does. */
function looksLikeReadOutput(content: string): boolean {
  const lines = content.split("\n").filter((line) => line !== "");
  return lines.length > 0 && lines.every((line) => /^\s*\d+\|/.test(line));
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

const WRITE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Absolute or relative path to the file to write",
    },
    content: {
      type: "string",
      description: "The complete file content to write",
    },
  },
  required: ["path", "content"],
} as const;

/** Builds create-only file writes, naming the owning surface's update tool in refusals. */
function createWriteDefinition(updateTool?: string): RuntimeTool {
  return {
    name: "write",
    action: "file_write",
    description: "Create a NEW file with the exact given content, including any parent directories. This tool ONLY creates new files; it rejects writes to files that already exist. The file receives the content exactly as supplied; display prefixes are not stripped and line endings are not transformed. NEVER proactively create documentation files (*.md) or README files unless explicitly requested.",
    promptSnippet: "Create new files with exact content; reject writes to existing files.",
    inputSchema: WRITE_INPUT_SCHEMA,
    // Mutates the filesystem: not gate-safe, but the target is declarable,
    // so disjoint writes in one batch overlap in time (path-scoped gate
    // admission, ARCH-TOOLS-004). The per-realpath queue below is defense in depth
    // for writers outside this gate's scope, e.g. a concurrent subagent.
    isConcurrencySafe: false,
    prepareAdmission: async (input, context) => sessionPathInput(input, context, "new-file"),
    reservedPaths: (input, executionCwd) =>
      typeof input.path === "string" && input.path.trim() !== ""
        ? [canonicalMutationPath(resolveToolPath(executionCwd, input.path))]
        : [],
    async execute(input: RuntimeToolInput, context: ToolContext): Promise<ToolResult> {
      if (typeof input.path !== "string") {
        return { content: "write was called without a 'path' string. Provide the absolute or cwd-relative path of the new file as 'path'.", outcome: "error" };
      }
      if (typeof input.content !== "string") {
        return { content: "write was called without a 'content' string. Provide the complete file contents as 'content'; write does not append, it creates the file with exactly the content you pass.", outcome: "error" };
      }
      const path = input.path;
      const content = input.content;
      const editTool = updateTool ?? context.toolNames?.presented("edit") ?? "edit";
      if (looksLikeReadOutput(content)) {
        return { content: "write refused: every line of the content starts with a read line-number prefix such as 12|. Send the file text without the prefixes.", outcome: "error" };
      }
      return publishToolFileEdits(context, {
        label: "Write",
        paths: [path],
        admit: (resolvedPath) => {
          try {
            return RetainedFileEditAuthority.admitWritable(resolvedPath);
          } catch (error) {
            // A symlink in the final position opens as ELOOP under O_NOFOLLOW: the name is taken.
            if (isErrnoCode(error, "ELOOP")) throw existingFileRefusal(path, editTool);
            throw error;
          }
        },
        plan: ([admitted]) => {
          if (!admitted) throw new Error(`${path} was not admitted`);
          if (admitted.authority.snapshot) throw existingFileRefusal(path, editTool);
          const metadata = admitted.authority.defaultPublicationMetadata();
          return [metadata ? { admitted, after: content, metadata } : { admitted, after: content }];
        },
      });
    },
  };
}

export const writeDefinition = createWriteDefinition();

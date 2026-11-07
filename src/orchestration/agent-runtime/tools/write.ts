/**
 * Write tool - whole-file creation and replacement.
 *
 * Creates a file with the provided content, including parent directories, or
 * replaces an existing file whose current version this agent loop has read.
 * Display metadata lives in `infra/tools/displays/write.ts`.
 */

import { LineEndingRestorer } from "../../../infra/file-edit/text-file.js";
import { canonicalMutationPath } from "../../../infra/file-mutation-queue.js";
import { FileEditRefusal } from "../../file-edits/file-edit-operation.js";
import { publishToolFileEdits } from "./file-edit-tool-adapter.js";
import { RetainedFileEditAuthority } from "../../file-edits/retained-file-edit-host.js";
import { resolveToolPath, sessionPathInput } from "./tool-paths.js";
import type { RuntimeTool, RuntimeToolInput, ToolContext, ToolResult } from "./types.js";

/** Read output pastes back as `N|text` on every line; a real file almost never does. */
function looksLikeReadOutput(content: string): boolean {
  const lines = content.split("\n").filter((line) => line !== "");
  return lines.length > 0 && lines.every((line) => /^\s*\d+\|/.test(line));
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** A replacement is an edit of the whole file (PI-AGENT-049): an existing BOM stays, and each line ending in
 *  `content` takes the replaced file's ending in the same position, then the file's first ending. A file with
 *  no line ending has no style to keep, so `content` keeps its own endings. */
function replacementText(before: string, content: string): string {
  const bom = before.startsWith("\uFEFF") && !content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = /[\r\n]/.test(before) ? new LineEndingRestorer(before).restore(content, { start: 0, end: before.length }) : content;
  return bom + body;
}

const WRITE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Absolute or relative path of the file to create or replace",
    },
    content: {
      type: "string",
      description: "The complete file content to write",
    },
  },
  required: ["path", "content"],
} as const;

/** Builds file writes, naming the owning surface's update tool in refusals. */
function createWriteDefinition(updateTool?: string): RuntimeTool {
  return {
    name: "write",
    action: "file_write",
    description: "Create a file or replace a whole existing file, including any parent directories. Replacement requires the current version of the file, read with the read tool or written with a file-editing tool during this run. Shell reads and search results do not count. Write refuses a replacement when the current bytes differ from that version. Use the file-editing tool to change part of a file. A new file receives the content exactly as supplied; display prefixes are not stripped and line endings are not transformed. A replaced file keeps its byte-order mark and line-ending style. NEVER proactively create documentation files (*.md) or README files unless explicitly requested.",
    promptSnippet: "Create files with exact content, or replace a whole file read or written at its current version during this run.",
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
        return { content: "write was called without a 'path' string. Provide the absolute or cwd-relative path of the file as 'path'.", outcome: "error" };
      }
      if (typeof input.content !== "string") {
        return { content: "write requires a 'content' string. Provide the complete file contents as 'content'. Write creates or replaces the file; it does not append.", outcome: "error" };
      }
      const path = input.path;
      const content = input.content;
      const editTool = updateTool ?? context.toolNames?.presented("edit") ?? "edit";
      const readTool = context.toolNames?.presented("read") ?? "read";
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
            // A symlink in the final position opens as ELOOP under O_NOFOLLOW; write never replaces a link.
            if (isErrnoCode(error, "ELOOP")) throw new FileEditRefusal(`write refused: ${path} is a symbolic link. Write to the file it points to instead.`);
            throw error;
          }
        },
        plan: ([admitted]) => {
          if (!admitted) throw new Error(`${path} was not admitted`);
          const { authority } = admitted;
          if (!authority.snapshot) {
            const metadata = authority.defaultPublicationMetadata();
            return [metadata ? { admitted, after: content, metadata } : { admitted, after: content }];
          }
          // A context without a ledger has seen nothing, so it may only create.
          switch (context.readLedger ? context.readLedger.versionStaleness(authority.canonicalPath, authority.snapshot.content) : "unread") {
            case "unread":
              throw new FileEditRefusal(`write refused: ${path} already exists, and this run has no verified version of it from the ${readTool} tool or a file edit. Read it with ${readTool} before you replace the whole file, or use ${editTool} to change part of it.`);
            case "changed":
              throw new FileEditRefusal(`write refused: ${path} differs from the version that this run last read or wrote. Read it again with ${readTool}, then write.`);
          }
          if (authority.text === undefined) throw new FileEditRefusal(`write refused: ${path} is not valid UTF-8 text, so write cannot replace it.`);
          return [{ admitted, after: replacementText(authority.text, content) }];
        },
      });
    },
  };
}

export const writeDefinition = createWriteDefinition();

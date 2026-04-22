/**
 * Write tool -- whole-file creation/overwrite.
 *
 * Creates a file with the provided content, including parent directories.
 * For surgical edits to existing files, prefer the edit tool.
 */

import * as fs from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { errorMessage } from "../../../../../infra/error-message.js";
import { Log } from "../../../../../infra/log.js";
import type { ToolDefinition, ToolResult, ToolContext } from "./types.js";

const log = Log.create({ service: "harness-write" });

interface WriteOperations {
  writeFile(path: string, content: string): Promise<number>;
  mkdir(path: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
}

const defaultWriteOperations: WriteOperations = {
  writeFile: (path, content) => Bun.write(path, content),
  mkdir: (path) => fs.mkdir(path, { recursive: true }).then(() => {}),
  fileExists: (path) => fs.access(path).then(() => true).catch(() => false),
};

function createWriteDefinition(options?: { operations?: WriteOperations }): ToolDefinition {
  const ops = options?.operations ?? defaultWriteOperations;

  return {
    name: "write",
    description:
      "Create a NEW file with the given content, including any parent directories. " +
      "This tool ONLY creates new files — it will reject writes to files that already exist. " +
      "To modify existing files, use the edit tool (read first, then edit with LINE#HASH references). " +
      "NEVER proactively create documentation files (*.md) or README files unless explicitly requested.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Absolute or relative path to the file to write",
        },
        content: {
          type: "string",
          description: "The complete file content to write",
        },
      },
      required: ["file_path", "content"],
    },
    async execute(input: Record<string, unknown>, context: ToolContext) {
      if (typeof input.file_path !== "string") {
        return { content: "write requires a string 'file_path' parameter", isError: true };
      }
      if (typeof input.content !== "string") {
        return { content: "write requires a string 'content' parameter", isError: true };
      }

      const rawPath = input.file_path;
      const fileContent = input.content;
      const resolvedPath = rawPath.startsWith("/") ? rawPath : resolve(context.cwd, rawPath);

      try {
        const exists = await ops.fileExists(resolvedPath);
        if (exists) {
          return {
            content: `File already exists: ${rawPath}. Use the edit tool to modify existing files (read it first to get LINE#HASH references, then use edit). The write tool is only for creating new files.`,
            isError: true,
          };
        }

        await ops.mkdir(dirname(resolvedPath));
        const bytes = await ops.writeFile(resolvedPath, fileContent);
        log.info("file written", { path: rawPath, bytes });
        return { content: `Wrote ${bytes} bytes to ${rawPath}`, isError: false };
      } catch (err) {
        const msg = errorMessage(err);
        log.warn("write failed", { path: rawPath, error: msg });
        return { content: `Error writing file: ${msg}`, isError: true };
      }
    },
  };
}

export const writeDefinition = createWriteDefinition();

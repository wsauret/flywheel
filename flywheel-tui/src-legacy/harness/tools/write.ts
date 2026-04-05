/**
 * Write tool — whole-file creation/overwrite for the Agent Harness.
 *
 * Writes content to a file, creating parent directories as needed.
 * Simpler than the hashline edit tool for new file creation and full rewrites.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { HarnessTool, ToolContext, ToolResult } from "./types.js";

const writeInputSchema = z.object({
  file_path: z
    .string()
    .describe("Absolute or relative path to the file to write."),
  content: z
    .string()
    .describe("The complete file content to write."),
});

const WRITE_DESCRIPTION = `Write content to a file, creating the file and any parent directories if they don't exist.
If the file already exists it will be overwritten. Use this tool for creating new files or replacing
entire file contents. For surgical edits to existing files, prefer the edit tool instead.`;

export const writeTool: HarnessTool = {
  name: "write",
  description: WRITE_DESCRIPTION,
  inputSchema: writeInputSchema,
  concurrency: "exclusive",

  async execute(rawInput: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = writeInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return { content: `Invalid input: ${parsed.error.message}`, isError: true };
    }

    const { file_path, content } = parsed.data;
    const resolvedPath = file_path.startsWith("/") ? file_path : path.resolve(context.cwd, file_path);

    try {
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await Bun.write(resolvedPath, content);
      const bytes = Buffer.byteLength(content, "utf-8");
      return { content: `Wrote ${bytes} bytes to ${file_path}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `Error writing file: ${message}`, isError: true };
    }
  },
};

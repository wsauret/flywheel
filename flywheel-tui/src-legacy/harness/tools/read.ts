/**
 * Read tool — file reading with hashline output for the Agent Harness.
 *
 * Reads files using Bun.file(), splits into lines, applies offset/limit,
 * and prepends hashline tags for line-addressable editing.
 */

import { z } from "zod";
import { computeLineHash, formatLineTag } from "./hashline.js";
import type { HarnessTool, ToolContext, ToolResult } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 2400;
const NULL_BYTE = 0x00;
const BINARY_CHECK_BYTES = 8192;

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const readInputSchema = z.object({
  file_path: z
    .string()
    .describe("The absolute path to the file to read (must be absolute, not relative)."),
  offset: z
    .number()
    .optional()
    .default(0)
    .describe("The line number to start reading from (0-based, defaults to 0)."),
  limit: z
    .number()
    .optional()
    .default(DEFAULT_LIMIT)
    .describe(`The maximum number of lines to read (defaults to ${DEFAULT_LIMIT}).`),
});

type ReadInput = z.infer<typeof readInputSchema>;

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

/** Check if a buffer contains null bytes, indicating a binary file. */
function isBinaryContent(buffer: Uint8Array): boolean {
  const checkLen = Math.min(buffer.length, BINARY_CHECK_BYTES);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === NULL_BYTE) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

const READ_DESCRIPTION = `Read the contents of a file. By default, reads the entire file, but for large text files,
results are truncated to the first ${DEFAULT_LIMIT} lines to preserve token usage. Use offset and limit parameters
to read specific portions of huge files when needed. Requires absolute file paths.

Each line is prefixed with a hashline tag in the format LINE#HASH:content where LINE is the
1-indexed line number and HASH is a 2-character hash for line-addressable editing.

Use offset (0-based line number) and limit to paginate through large files.`;

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

export function createReadTool(): HarnessTool {
  return {
    name: "read",
    description: READ_DESCRIPTION,
    inputSchema: readInputSchema,
    concurrency: "shared",

    async execute(rawInput: unknown, context: ToolContext): Promise<ToolResult> {
      const parsed = readInputSchema.parse(rawInput);
      const filePath = parsed.file_path;
      const offset = parsed.offset ?? 0;
      const limit = parsed.limit ?? DEFAULT_LIMIT;

      // Resolve path relative to cwd if not absolute
      const resolvedPath = filePath.startsWith("/") ? filePath : `${context.cwd}/${filePath}`;

      // Read file
      const file = Bun.file(resolvedPath);
      let exists: boolean;
      try {
        const stat = await file.stat();
        exists = stat.size >= 0;
      } catch {
        exists = false;
      }

      if (!exists) {
        return {
          content: `Error: File not found: ${filePath}`,
          isError: true,
        };
      }

      // Check for binary content
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: `Error reading file: ${message}`,
          isError: true,
        };
      }

      if (bytes.length > 0 && isBinaryContent(bytes)) {
        return {
          content: `Error: Cannot read binary file: ${filePath}`,
          isError: true,
        };
      }

      // Decode text
      const text = new TextDecoder("utf-8").decode(bytes);

      // Handle empty files
      if (text.length === 0) {
        return { content: "(empty file)" };
      }

      const allLines = text.split("\n");
      const totalLines = allLines.length;

      // Validate offset
      if (offset >= totalLines) {
        return {
          content: `Offset ${offset} is beyond end of file (${totalLines} lines total). Use offset=0 to read from the start.`,
          isError: true,
        };
      }

      // Apply offset and limit
      const endLine = Math.min(offset + limit, totalLines);
      const selectedLines = allLines.slice(offset, endLine);

      // Format with hashline tags
      const formatted = selectedLines.map((line, i) => {
        const lineNumber = offset + i + 1; // 1-indexed
        const tag = formatLineTag(lineNumber, line);
        return `${tag}:${line}`;
      });

      let output = formatted.join("\n");

      // Add pagination hint if there are more lines
      const remaining = totalLines - endLine;
      if (remaining > 0) {
        output += `\n\n[${remaining} more lines. Use offset=${endLine} to continue reading.]`;
      }

      return { content: output };
    },
  };
}

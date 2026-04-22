/**
 * Hashline-addressed edit tool.
 *
 * Applies structured edits to files using line-number + hash references
 * for integrity. All edits are validated transactionally -- if any hash
 * mismatch is found, no changes are written.
 */

import * as fs from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { errorMessage } from "../../../../../infra/error-message.js";
import { Log } from "../../../../../infra/log.js";
import {
  applyHashlineEdits,
  formatHashLines,
  stripHashlinePrefixes,
  HashlineMismatchError,
  type HashlineEdit,
  type EditFileOperations,
} from "./hashline.js";
import type { ToolDefinition, ToolResult, ToolContext } from "./types.js";

const log = Log.create({ service: "harness-edit" });

const EDIT_OPS = ["insert_before", "insert_after", "replace", "delete", "replace_all", "create"] as const;

export interface EditOperations extends EditFileOperations {
  fileExists(path: string): Promise<boolean>;
}

const defaultEditOperations: EditOperations = {
  readFile: (path) => Bun.file(path).text(),
  writeFile: (path, content) => Bun.write(path, content).then(() => {}),
  mkdir: (path) => fs.mkdir(path, { recursive: true }).then(() => {}),
  fileExists: (path) =>
    fs.access(path).then(() => true).catch(() => false),
};

function validateEditInput(input: Record<string, unknown>): { filePath: string; edits: HashlineEdit[] } | string {
  if (typeof input.file_path !== "string") return "edit requires a string 'file_path' parameter";

  const rawEdits = input.edits;
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
    return "edit requires a non-empty 'edits' array";
  }

  const edits: HashlineEdit[] = [];
  for (let i = 0; i < rawEdits.length; i++) {
    const raw = rawEdits[i] as Record<string, unknown>;
    const op = raw.op as string;
    if (!EDIT_OPS.includes(op as typeof EDIT_OPS[number])) {
      return `edits[${i}]: unknown op '${op}'. Valid: ${EDIT_OPS.join(", ")}`;
    }
    const lines = Array.isArray(raw.lines) ? (raw.lines as string[]) : undefined;
    switch (op) {
      case "insert_before":
      case "insert_after":
        if (typeof raw.target !== "string") return `edits[${i}]: '${op}' requires a 'target' string`;
        if (!lines) return `edits[${i}]: '${op}' requires a 'lines' array`;
        edits.push({ op, target: raw.target, lines });
        break;
      case "replace":
        if (typeof raw.start !== "string") return `edits[${i}]: 'replace' requires a 'start' string`;
        if (typeof raw.end !== "string") return `edits[${i}]: 'replace' requires an 'end' string`;
        if (!lines) return `edits[${i}]: 'replace' requires a 'lines' array`;
        edits.push({ op, start: raw.start, end: raw.end, lines });
        break;
      case "delete":
        if (typeof raw.start !== "string") return `edits[${i}]: 'delete' requires a 'start' string`;
        if (typeof raw.end !== "string") return `edits[${i}]: 'delete' requires an 'end' string`;
        edits.push({ op, start: raw.start, end: raw.end });
        break;
      case "replace_all":
      case "create":
        if (!lines) return `edits[${i}]: '${op}' requires a 'lines' array`;
        edits.push({ op, lines });
        break;
    }
  }
  return { filePath: input.file_path, edits };
}

export function createEditDefinition(options?: { operations?: EditOperations }): ToolDefinition {
  const ops = options?.operations ?? defaultEditOperations;

  return {
    name: "edit",
    description:
      "Edit a file using hashline-addressed operations. You MUST read the file first to get LINE#HASH " +
      "references (e.g. 5#KX, 12#MQ), then use those references to address edits. " +
      "Supports insert_before, insert_after, replace, delete, replace_all, and create. " +
      "All edits are validated transactionally — if any hash is stale, nothing changes. " +
      "Preserve the exact indentation (tabs or spaces) of surrounding code in your edit lines. " +
      "Do NOT include the LINE#HASH: prefix in your edit content. " +
      "replace_all and create do not require reading first. " +
      "If an edit fails, the error includes updated references — retry using those directly.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Absolute or relative path to the file to edit",
        },
        edits: {
          type: "array",
          description: "Array of hashline edit operations to apply transactionally",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: EDIT_OPS,
                description: "Edit operation type",
              },
              target: {
                type: "string",
                description: "Target line reference e.g. '5#KX' (for insert_before/insert_after)",
              },
              start: {
                type: "string",
                description: "Start line reference inclusive (for replace/delete)",
              },
              end: {
                type: "string",
                description: "End line reference inclusive (for replace/delete)",
              },
              lines: {
                type: "array",
                items: { type: "string" },
                description: "Lines of content (for insert/replace/replace_all/create)",
              },
            },
            required: ["op"],
          },
        },
      },
      required: ["file_path", "edits"],
    },
    async execute(input: unknown, context: ToolContext) {
      const validated = validateEditInput(input as Record<string, unknown>);
      if (typeof validated === "string") {
        return { content: validated, isError: true };
      }

      const { filePath: rawPath, edits } = validated;
      const resolvedPath = rawPath.startsWith("/") ? rawPath : resolve(context.cwd, rawPath);
      const hasCreate = edits.some((e) => e.op === "create");
      const hasReplaceAll = edits.some((e) => e.op === "replace_all");
      const skipReadCheck = hasCreate || hasReplaceAll;

      if (!skipReadCheck) {
        const exists = await ops.fileExists(resolvedPath);
        if (!exists) return { content: `File not found: ${rawPath}`, isError: true };

        if (!context.readFiles.has(resolvedPath)) {
          return {
            content: `You must read the file before editing it. Call read(file_path="${rawPath}") first to get the current LINE#HASH references, then retry this edit.`,
            isError: true,
          };
        }
      }

      // Strip hashline prefixes from lines the model may have copied
      const strippedEdits = edits.map((edit) => {
        if ("lines" in edit && edit.lines) {
          const joined = edit.lines.join("\n");
          const stripped = stripHashlinePrefixes(joined);
          return { ...edit, lines: stripped.split("\n") };
        }
        return edit;
      });

      try {
        await applyHashlineEdits(resolvedPath, strippedEdits, ops);
      } catch (err) {
        if (err instanceof HashlineMismatchError) {
          return {
            content: `${err.message}\n\nThe file has changed since you last read it. Use the updated LINE#HASH references shown above and retry your edit.`,
            isError: true,
          };
        }
        const msg = errorMessage(err);
        if (msg.includes("does not exist") || msg.includes("Invalid")) {
          try {
            const current = await ops.readFile(resolvedPath);
            const preview = formatHashLines(current);
            return {
              content: `Edit failed: ${msg}\n\nCurrent file content:\n${preview}\n\nReview the content above and retry with correct references.`,
              isError: true,
            };
          } catch {
            // Fall through to basic error
          }
        }
        log.warn("edit failed", { path: rawPath, error: msg });
        return { content: msg, isError: true };
      }

      if (hasCreate) return { content: `Created ${rawPath}`, isError: false };
      if (edits.some((e) => e.op === "replace_all")) {
        return { content: `Replaced all content in ${rawPath}`, isError: false };
      }

      try {
        const updated = await ops.readFile(resolvedPath);
        const preview = formatHashLines(updated);
        const lineCount = updated.split("\n").length;
        const editSummary = edits.map((e) => e.op).join(", ");
        return {
          content: `Applied ${edits.length} edit(s) to ${rawPath} [${editSummary}] (${lineCount} lines)\n\n${preview}`,
          isError: false,
        };
      } catch {
        return {
          content: `Applied ${edits.length} edit(s) to ${rawPath}`,
          isError: false,
        };
      }
    },
  };
}

export const editDefinition = createEditDefinition();

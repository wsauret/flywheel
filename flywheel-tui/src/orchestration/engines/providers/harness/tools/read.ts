/**
 * Unified read tool — reads text files with hashline-prefixed line numbers
 * and image files with base64 encoding and optional resizing.
 *
 * Replaces the standalone read_image tool.
 */

import { extname, resolve } from "node:path";
import { errorMessage } from "../../../../../infra/error-message.js";
import { Log } from "../../../../../infra/log.js";
import { formatLineTag } from "./hashline.js";
import { resizeImage, type ResizedImage } from "./image-resize.js";
import { generateFileMap, formatFileMap, lookupSymbol } from "./structural-map.js";
import type { ToolDefinition, ToolResult, ToolContext } from "./types.js";

interface ReadOperations {
  readFile(path: string): Promise<{
    size: number;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
  resizeImage?: (base64: string, mimeType: string) => Promise<ResizedImage | null>;
}

const log = Log.create({ service: "harness-read" });

const DEFAULT_LINE_LIMIT = 2000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const defaultReadOperations: ReadOperations = {
  readFile: (path: string) => {
    const file = Bun.file(path);
    return Promise.resolve({
      size: file.size,
      arrayBuffer: () => file.arrayBuffer(),
    });
  },
  resizeImage,
};

function isImageExtension(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

function isBinaryContent(buffer: ArrayBuffer): boolean {
  const view = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 8192));
  for (let i = 0; i < view.length; i++) {
    if (view[i] === 0) return true;
  }
  return false;
}

async function readImage(
  filePath: string,
  ops: ReadOperations,
): Promise<ToolResult> {
  const ext = extname(filePath).toLowerCase();
  const mediaType = MIME_MAP[ext];
  if (!mediaType) {
    return {
      content: `Unsupported image format '${ext}'. Supported: ${Object.keys(MIME_MAP).join(", ")}`,
      isError: true,
    };
  }

  const file = await ops.readFile(filePath);

  if (file.size > MAX_IMAGE_BYTES) {
    return {
      content: `Image too large (${file.size} bytes). Maximum is ${MAX_IMAGE_BYTES} bytes (20MB).`,
      isError: true,
    };
  }

  const buffer = await file.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");

  const resize = ops.resizeImage ?? resizeImage;
  const resized = await resize(base64, mediaType);

  if (resized) {
    const parts = [`data:${resized.mimeType};base64,${resized.data}`];
    if (resized.wasResized) {
      parts.push(
        `\n(Image resized from ${resized.originalWidth}x${resized.originalHeight} to ${resized.width}x${resized.height})`,
      );
    } else {
      parts.push(`\n(${resized.width}x${resized.height})`);
    }
    log.info("image read", { path: filePath, size: file.size, mediaType: resized.mimeType, resized: resized.wasResized });
    return { content: parts.join(""), isError: false };
  }

  // Resize failed or returned null — return raw base64 with a note
  log.info("image read (no resize)", { path: filePath, size: file.size, mediaType });
  return {
    content: `data:${mediaType};base64,${base64}`,
    isError: false,
  };
}

async function readText(
  filePath: string,
  offset: number,
  limit: number,
  ops: ReadOperations,
  options?: { map?: boolean; symbol?: string },
): Promise<ToolResult> {
  const file = await ops.readFile(filePath);
  const buffer = await file.arrayBuffer();

  if (isBinaryContent(buffer)) {
    return {
      content: `Cannot read '${filePath}': file appears to be binary. Use the bash tool to inspect binary files.`,
      isError: true,
    };
  }

  const text = new TextDecoder().decode(buffer);
  const allLines = text.split("\n");
  const totalLines = allLines.length;

  if (options?.symbol) {
    return readSymbol(filePath, allLines, totalLines, options.symbol);
  }

  const startIdx = Math.min(offset, totalLines);
  const endIdx = Math.min(startIdx + limit, totalLines);
  const slice = allLines.slice(startIdx, endIdx);

  const tagged = slice
    .map((line, i) => {
      const lineNumber = startIdx + i + 1; // 1-indexed
      return `${formatLineTag(lineNumber, line)}:${line}`;
    })
    .join("\n");

  const parts = [tagged];
  const truncated = endIdx < totalLines;

  if (truncated) {
    const remaining = totalLines - endIdx;
    parts.push(`\n(${remaining} more line${remaining !== 1 ? "s" : ""} not shown. Use offset=${endIdx} to continue reading.)`);
  }

  if (truncated || options?.map) {
    const fileMap = await generateFileMap(filePath);
    if (fileMap) parts.push("\n" + formatFileMap(fileMap, filePath));
  }

  if (startIdx > 0) {
    parts.unshift(`(Starting from line ${startIdx + 1} of ${totalLines} total lines)\n`);
  }

  return { content: parts.join(""), isError: false };
}

async function readSymbol(
  filePath: string,
  allLines: string[],
  totalLines: number,
  symbolQuery: string,
): Promise<ToolResult> {
  const fileMap = await generateFileMap(filePath);
  if (!fileMap) {
    return readSliceWithWarning(
      allLines,
      totalLines,
      0,
      DEFAULT_LINE_LIMIT,
      "[Warning: structural map not available for this file type. Falling back to normal read.]\n",
    );
  }

  const result = lookupSymbol(fileMap, symbolQuery);

  switch (result.type) {
    case "found": {
      const sym = result.symbol;
      const startIdx = sym.startLine - 1;
      const endIdx = sym.endLine;
      const slice = allLines.slice(startIdx, endIdx);
      const tagged = slice
        .map((line, i) => {
          const lineNumber = startIdx + i + 1;
          return `${formatLineTag(lineNumber, line)}:${line}`;
        })
        .join("\n");
      return {
        content: `[Symbol: ${sym.name} (${sym.kind}), lines ${sym.startLine}-${sym.endLine} of ${totalLines} total]\n${tagged}`,
        isError: false,
      };
    }
    case "ambiguous": {
      const listing = result.candidates
        .map((c) => `  ${c.name} (${c.kind}): lines ${c.startLine}-${c.endLine}`)
        .join("\n");
      return {
        content: `Ambiguous symbol "${symbolQuery}". Multiple matches:\n${listing}\nUse dot notation (e.g. "ClassName.methodName") or a more specific name.`,
        isError: true,
      };
    }
    case "not-found": {
      const listing = result.available
        .map((s) => `  ${s.name} (${s.kind}): lines ${s.startLine}-${s.endLine}`)
        .join("\n");
      const warning = `[Warning: symbol "${symbolQuery}" not found. Available symbols:\n${listing}\nFalling back to normal read.]\n`;
      return readSliceWithWarning(allLines, totalLines, 0, DEFAULT_LINE_LIMIT, warning);
    }
  }
}

function readSliceWithWarning(
  allLines: string[],
  totalLines: number,
  offset: number,
  limit: number,
  warning: string,
): ToolResult {
  const startIdx = Math.min(offset, totalLines);
  const endIdx = Math.min(startIdx + limit, totalLines);
  const slice = allLines.slice(startIdx, endIdx);
  const tagged = slice
    .map((line, i) => {
      const lineNumber = startIdx + i + 1;
      return `${formatLineTag(lineNumber, line)}:${line}`;
    })
    .join("\n");
  const parts = [warning + tagged];
  if (endIdx < totalLines) {
    const remaining = totalLines - endIdx;
    parts.push(`\n(${remaining} more line${remaining !== 1 ? "s" : ""} not shown. Use offset=${endIdx} to continue reading.)`);
  }
  return { content: parts.join(""), isError: false };
}

function createReadDefinition(options?: { operations?: ReadOperations }): ToolDefinition {
  const ops = options?.operations ?? defaultReadOperations;

  return {
    name: "read",
    description:
      "Read a file's contents. Text files are returned with hashline-prefixed line numbers " +
      "(e.g. 1#a3f:const x = 1) — these LINE#HASH references are used by the edit tool to address lines precisely. " +
      "Use symbol: \"functionName\" to read just that function (dot notation supported: \"Class.method\"). " +
      "Use map: true to see the file's structural outline (functions, classes, types with line ranges). " +
      "When a file is truncated, a structural map is auto-appended. " +
      "Image files (PNG, JPG, GIF, WebP) are returned as base64-encoded data. " +
      "You can read multiple files in parallel — always parallelize when exploring related files.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Absolute or relative path to the file to read",
        },
        offset: {
          type: "number",
          description: "0-based line offset to start reading from (default: 0). Only applies to text files.",
        },
        limit: {
          type: "number",
          description: `Maximum number of lines to return (default: ${DEFAULT_LINE_LIMIT}). Only applies to text files.`,
        },
        map: {
          type: "boolean",
          description: "Include a structural map of the file's symbols (functions, classes, types with line ranges). Mutually exclusive with symbol.",
        },
        symbol: {
          type: "string",
          description: "Read only the named symbol (function, class, etc). Supports dot notation: \"ClassName.methodName\". Mutually exclusive with offset, limit, and map.",
        },
      },
      required: ["file_path"],
    },
    async execute(input: Record<string, unknown>, context: ToolContext) {
      if (typeof input.file_path !== "string") {
        return { content: "read requires a string 'file_path' parameter", isError: true };
      }

      const hasSymbol = typeof input.symbol === "string" && input.symbol.length > 0;
      const hasMap = input.map === true;

      if (hasSymbol && hasMap) {
        return { content: "Parameters 'symbol' and 'map' are mutually exclusive.", isError: true };
      }
      if (hasSymbol && (input.offset !== undefined || input.limit !== undefined)) {
        return { content: "Parameter 'symbol' is mutually exclusive with 'offset' and 'limit'.", isError: true };
      }

      const rawPath = input.file_path;
      const resolvedPath = rawPath.startsWith("/") ? rawPath : resolve(context.cwd, rawPath);
      const ext = extname(resolvedPath).toLowerCase();

      try {
        if (isImageExtension(ext)) {
          return await readImage(resolvedPath, ops);
        }

        const offset = typeof input.offset === "number" ? Math.max(0, Math.floor(input.offset)) : 0;
        const limit = typeof input.limit === "number" ? Math.max(1, Math.floor(input.limit)) : DEFAULT_LINE_LIMIT;

        const result = await readText(resolvedPath, offset, limit, ops, {
          map: hasMap,
          symbol: hasSymbol ? (input.symbol as string) : undefined,
        });
        if (!result.isError) context.readFiles.add(resolvedPath);
        return result;
      } catch (err) {
        const msg = errorMessage(err);
        log.warn("failed to read file", { path: rawPath, error: msg });
        return { content: `Failed to read '${rawPath}': ${msg}`, isError: true };
      }
    },
  };
}

export const readDefinition = createReadDefinition();

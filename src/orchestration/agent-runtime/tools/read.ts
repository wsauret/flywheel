/**
 * Unified read tool for numbered text lines and base64-encoded images, with
 * text/image/multi-range/symbol implementations and the factory/wiring layer.
 * Display metadata (verbs, detail formatting) lives in
 * `infra/tools/displays/read.ts`.
 */

import { createReadStream, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { errnoCode, errorMessage } from "../../../infra/error-message.js";
import { Log } from "../../../infra/log.js";
import { canonicalMutationPath } from "../../../infra/file-mutation-queue.js";
import type { LineRange as LedgerLineRange } from "./file-read-ledger.js";
import { executePathBatch, hasKind, missingPathHint, prepareReadOnlyPathInput, resolveToolPath } from "./tool-paths.js";
import { listDefinition } from "./list.js";
import { searchDefinition } from "./search.js";
import { prepareSearchPathInput } from "./search-paths.js";
import { type ImageResizeResult, resizeImage } from "./image-resize.js";
import { checkNumericRange } from "./numeric-input.js";
import { isRawSelector, type LineRange, parseSel, splitPathAndSel } from "./read-selectors.js";
import { decodeTextSnapshot, readTextWindows } from "./read-text-windows.js";
import { formatFileMap, generateFileMap, lookupSymbol } from "./structural-map.js";
import { renderStructuralSummary, summarizeStructure } from "./structural-summary.js";
import { detectTreeSitterLanguage } from "./tree-sitter-code.js";
import type { RuntimeTool, RuntimeToolInput, ToolContext, ToolResult } from "./types.js";
import type { CapabilityCheck } from "../../../infra/capability-text.js";

const log = Log.create({ service: "agent-read" });

interface MimeTypesByExtension {
  [extension: string]: string;
}

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".ico",
  ".avif",
  ".heic",
  ".heif",
]);

const RANGE_LEADING_CONTEXT_LINES = 1;
const RANGE_TRAILING_CONTEXT_LINES = 3;

function isImageExtension(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

type ResolvedReadInput = {
  resolvedPath: string;
  ext: string;
  offset: number;
  limit: number;
  hasMap: boolean;
  symbol: string | undefined;
  raw: boolean;
  multiRanges: readonly LineRange[] | undefined;
  summarize: boolean;
  cleanPath: string;
  rawPath: string;
};

function resolveReadInput(input: RuntimeToolInput, context: ToolContext): { error: ToolResult } | ResolvedReadInput {
  // Belt for direct execute() callers; dispatched calls are pre-validated in tool-dispatch.
  const rawPath = input.path;
  if (typeof rawPath !== "string") {
    return { error: { content: "read was called without a 'path' string. Provide the absolute or cwd-relative path of the file you want to read as 'path'.", outcome: "error" } };
  }

  const { path: cleanPath, sel } = splitPathAndSel(rawPath);
  const parsed = parseSel(sel);
  const raw = isRawSelector(parsed);

  const symbolInput = input.symbol;
  const symbol = typeof symbolInput === "string" && symbolInput.length > 0 ? symbolInput : undefined;
  const hasSymbol = symbol !== undefined;
  const hasMap = input.map === true;

  if (hasSymbol && hasMap) {
    return { error: { content: "Parameters 'symbol' and 'map' are mutually exclusive.", outcome: "error" } };
  }
  const resolvedPath = resolveToolPath(context.executionCwd, cleanPath);

  let offset: number;
  let limit: number;
  let multiRanges: readonly LineRange[] | undefined;

  if (parsed.kind === "lines") {
    if (parsed.ranges.length > 1) {
      multiRanges = parsed.ranges;
      offset = 0;
      limit = DEFAULT_LINE_LIMIT;
    } else {
      const first = parsed.ranges[0];
      // Expand single-range reads with context to reduce follow-up reads when
      // the requested boundary omits nearby context.
      const contextStart = Math.max(1, first.startLine - RANGE_LEADING_CONTEXT_LINES);
      offset = contextStart - 1; // convert 1-indexed to 0-indexed
      limit = first.endLine !== undefined
        ? first.endLine + RANGE_TRAILING_CONTEXT_LINES - contextStart + 1
        : DEFAULT_LINE_LIMIT;
    }
  } else {
    const offsetCheck = checkNumericRange(input.offset, "offset", { min: 0 });
    if ("error" in offsetCheck) return { error: { content: offsetCheck.error, outcome: "error" } };
    const limitCheck = checkNumericRange(input.limit, "limit", { min: 1 });
    if ("error" in limitCheck) return { error: { content: limitCheck.error, outcome: "error" } };
    offset = offsetCheck.value !== undefined ? Math.floor(offsetCheck.value) : 0;
    limit = limitCheck.value !== undefined ? Math.floor(limitCheck.value) : DEFAULT_LINE_LIMIT;
  }

  return {
    resolvedPath,
    ext: extname(resolvedPath).toLowerCase(),
    offset,
    limit,
    hasMap,
    symbol,
    raw,
    summarize: sel === undefined && input.offset === undefined && input.limit === undefined && !hasMap && !hasSymbol,
    multiRanges,
    cleanPath,
    rawPath,
  };
}

// Read implementations (formerly read-helpers.ts, split only to satisfy the
// old 400-line cap; single consumer, merged back).

/** Records which lines of the decoded file the model saw, so a later edit can judge its read evidence. */
type RecordCoverage = (coverage: "full" | readonly LedgerLineRange[]) => Promise<void>;

function coverageRecorder(context: ToolContext, resolvedPath: string, sha256: string): RecordCoverage {
  const ledger = context.readLedger;
  if (!ledger) return async () => {};
  return async (coverage) => ledger.recordRead(
    canonicalMutationPath(resolvedPath),
    sha256,
    coverage,
    await context.projectionReader?.capturePosition() ?? 0,
  );
}

function sliceCoverage(startLine: number, endIdx: number, totalLines: number): "full" | readonly LedgerLineRange[] {
  return startLine === 1 && endIdx >= totalLines ? "full" : [{ start: startLine, end: Math.max(startLine, endIdx) }];
}

interface ReadOperations {
  readFile(path: string): Promise<{
    size: number;
    arrayBuffer(): Promise<ArrayBuffer>;
    stream(): ReadableStream<Uint8Array>;
  }>;
  resizeImage?: (base64: string) => Promise<ImageResizeResult>;
}

const DEFAULT_LINE_LIMIT = 2000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const MIME_MAP: MimeTypesByExtension = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function fileByteStream(path: string): ReadableStream<Uint8Array> {
  const source = createReadStream(path);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      source.on("data", (chunk) => controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
      source.once("end", () => controller.close());
      source.once("error", (error) => controller.error(error));
    },
    cancel() {
      source.destroy();
    },
  });
}

const defaultReadOperations: ReadOperations = {
  readFile: (path: string) => {
    return Promise.resolve({
      size: statSync(path).size,
      arrayBuffer: async () => Uint8Array.from(await readFile(path)).buffer,
      stream: () => fileByteStream(path),
    });
  },
  resizeImage,
};

/** Format text with ordinary one-based line numbers unless raw output is requested. */
function formatText(text: string, startNum: number, raw: boolean | undefined): string {
  if (raw) return text;
  return text.split("\n").map((line, index) => `${startNum + index}|${line}`).join("\n");
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
      outcome: "error",
    };
  }

  const file = await ops.readFile(filePath);

  if (file.size > MAX_IMAGE_BYTES) {
    return {
      content: `Image too large (${file.size} bytes). Maximum is ${MAX_IMAGE_BYTES} bytes (20MB).`,
      outcome: "error",
    };
  }

  const buffer = await file.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");

  const resize = ops.resizeImage ?? resizeImage;
  const resized = await resize(base64);

  if (resized.kind === "decoded") {
    log.debug("image read", { path: filePath, size: file.size, mediaType: resized.mimeType, resized: resized.wasResized });
    const note = resized.wasResized
      ? `(Image resized from ${resized.originalWidth}x${resized.originalHeight} to ${resized.width}x${resized.height})`
      : `(${resized.width}x${resized.height})`;
    return {
      content: [
        { type: "image", mediaType: resized.mimeType, data: resized.data },
        { type: "text", text: note },
      ],
      outcome: "ok",
    };
  }
  if (resized.kind === "unreadable") {
    return {
      content: `Cannot read ${filePath} as an image: ${resized.reason}.`,
      outcome: "error",
    };
  }

  // Without the decoder nothing is known about the bytes, so they go as the extension names them.
  log.debug("image read (no decoder)", { path: filePath, size: file.size, mediaType });
  return {
    content: [{ type: "image", mediaType, data: base64 }],
    outcome: "ok",
  };
}

async function readSliceWithWarning(
  filePath: string,
  allLines: string[],
  totalLines: number,
  offset: number,
  limit: number,
  seen: RecordCoverage,
  warning: string,
  options?: { raw?: boolean },
): Promise<ToolResult> {
  const startIdx = Math.min(offset, totalLines);
  const endIdx = Math.min(startIdx + limit, totalLines);
  const slice = allLines.slice(startIdx, endIdx);
  const startLine = startIdx + 1;
  await seen(sliceCoverage(startLine, endIdx, totalLines));
  const selectedContent = slice.join("\n");
  const tagged = formatText(selectedContent, startLine, options?.raw);
  const parts = [warning + tagged];
  if (endIdx < totalLines) {
    const remaining = totalLines - endIdx;
    parts.push(`\n(${remaining} more line${remaining !== 1 ? "s" : ""} not shown. Use offset=${endIdx} to continue reading.)`);
  }
  return {
    content: parts.join(""),
    outcome: "ok",
  };
}

async function readSymbol(
  filePath: string,
  allLines: string[],
  totalLines: number,
  symbolQuery: string,
  seen: RecordCoverage,
  options?: { raw?: boolean },
): Promise<ToolResult> {
  const fileMap = await generateFileMap({ path: filePath, text: allLines.join("\n") });
  if (!fileMap) {
    return readSliceWithWarning(
      filePath,
      allLines,
      totalLines,
      0,
      DEFAULT_LINE_LIMIT,
      seen,
      "[Warning: structural map not available for this file type. Falling back to normal read.]\n",
      options,
    );
  }

  const result = lookupSymbol(fileMap, symbolQuery);

  switch (result.type) {
    case "found": {
      const sym = result.symbol;
      const startIdx = sym.startLine - 1;
      const endIdx = sym.endLine;
      const slice = allLines.slice(startIdx, endIdx);
      const startLine = startIdx + 1;
      await seen([{ start: sym.startLine, end: sym.endLine }]);
      const selectedContent = slice.join("\n");
      const tagged = formatText(selectedContent, startLine, options?.raw);
      return {
        content: `[Symbol: ${sym.name} (${sym.kind}), lines ${sym.startLine}-${sym.endLine} of ${totalLines} total]\n${tagged}`,
        outcome: "ok",
        details: options?.raw ? undefined : { displayContent: { text: selectedContent, startLine } },
      };
    }
    case "ambiguous": {
      const listing = result.candidates
        .map((c) => `  ${c.name} (${c.kind}): lines ${c.startLine}-${c.endLine}`)
        .join("\n");
      return {
        content: `Ambiguous symbol "${symbolQuery}". Multiple matches:\n${listing}\nUse dot notation (e.g. "ClassName.methodName") or a more specific name.`,
        outcome: "error",
      };
    }
    case "not-found": {
      const listing = result.available
        .map((s) => `  ${s.name} (${s.kind}): lines ${s.startLine}-${s.endLine}`)
        .join("\n");
      const warning = `[Warning: symbol "${symbolQuery}" not found. Available symbols:\n${listing}\nFalling back to normal read.]\n`;
      return readSliceWithWarning(filePath, allLines, totalLines, 0, DEFAULT_LINE_LIMIT, seen, warning, options);
    }
  }
}

/** The refusal of a binary file, which names the shell only for an agent that holds it. */
function binaryFileRefusal(filePath: string, has: CapabilityCheck | undefined): ToolResult {
  return {
    content: `Cannot read '${filePath}': file appears to be binary. ${has?.("bash") === false ? "Its bytes cannot be shown as text." : "Use the bash tool to inspect binary files."}`,
    outcome: "error",
  };
}

async function readText(
  filePath: string,
  offset: number,
  limit: number,
  ops: ReadOperations,
  record: (sha256: string) => RecordCoverage,
  options?: { map?: boolean; symbol?: string; raw?: boolean; summarize?: boolean; signal?: AbortSignal; has?: CapabilityCheck },
): Promise<ToolResult> {
  const file = await ops.readFile(filePath);
  const supportsStructure = detectTreeSitterLanguage(filePath) !== null;
  const fullSummaryFallback = options?.summarize === true;
  const range = options?.symbol
    ? { startLine: 1, endLine: DEFAULT_LINE_LIMIT }
    : { startLine: offset + 1, endLine: fullSummaryFallback ? undefined : offset + limit };
  const acquired = supportsStructure
    ? decodeTextSnapshot(await file.arrayBuffer())
    : await readTextWindows(file.stream(), [range], options?.signal);
  const { totalLines, sha256, binary } = acquired;
  const seen = record(sha256);

  if (binary) return binaryFileRefusal(filePath, options?.has);

  if (options?.summarize && "text" in acquired) {
    const summary = await summarizeStructure({ path: filePath, text: acquired.text });
    if (summary) {
      const rendered = renderStructuralSummary(summary, filePath);
      await seen(rendered.retainedRows.map(([line]) => ({ start: line, end: line })));
      return {
        content: rendered.text,
        outcome: "ok",
        details: { displayContent: { text: rendered.displayText, startLine: 1 } },
      };
    }
  }

  if (options?.symbol) {
    if ("text" in acquired) return readSymbol(filePath, acquired.lines, totalLines, options.symbol, seen, { raw: options?.raw });
    // SAFETY: readTextWindows maps the single supplied range to exactly one window, including at EOF.
    return await readSliceWithWarning(filePath, acquired.windows[0]!.lines, totalLines, 0, DEFAULT_LINE_LIMIT, seen,
      "[Warning: structural map not available for this file type. Falling back to normal read.]\n", options);
  }

  const startIdx = fullSummaryFallback ? 0 : Math.min(offset, totalLines);
  const endIdx = fullSummaryFallback ? totalLines : Math.min(startIdx + limit, totalLines);
  // SAFETY: readTextWindows maps the single supplied range to exactly one window, including at EOF.
  const slice = "text" in acquired ? acquired.lines.slice(startIdx, endIdx) : acquired.windows[0]!.lines;
  const startLine = startIdx + 1; // 1-indexed
  await seen(sliceCoverage(startLine, endIdx, totalLines));

  const selectedContent = slice.join("\n");
  const tagged = formatText(selectedContent, startLine, options?.raw);

  const parts = [tagged];
  const truncated = endIdx < totalLines;

  if (truncated) {
    const remaining = totalLines - endIdx;
    parts.push(`\n(${remaining} more line${remaining !== 1 ? "s" : ""} not shown. Use offset=${endIdx} to continue reading.)`);
  }

  if ((truncated || options?.map) && "text" in acquired) {
    const fileMap = await generateFileMap({ path: filePath, text: acquired.text });
    if (fileMap) parts.push(`\n${formatFileMap(fileMap, filePath)}`);
  }

  if (startIdx > 0) {
    parts.unshift(`(Starting from line ${startIdx + 1} of ${totalLines} total lines)\n`);
  }

  const result: ToolResult = {
    content: parts.join(""),
    outcome: "ok",
  };
  if (!options?.raw) {
    result.details = { displayContent: { text: selectedContent, startLine } };
  }
  return result;
}

async function readTextMultiRange(
  filePath: string,
  ranges: readonly LineRange[],
  ops: ReadOperations,
  record: (sha256: string) => RecordCoverage,
  options?: { raw?: boolean; signal?: AbortSignal; has?: CapabilityCheck },
): Promise<ToolResult> {
  const file = await ops.readFile(filePath);
  const { windows, totalLines, sha256, binary } = await readTextWindows(file.stream(), ranges, options?.signal);
  const seen = record(sha256);

  if (binary) return binaryFileRefusal(filePath, options?.has);

  const blocks: string[] = [];
  const notices: string[] = [];
  const covered: LedgerLineRange[] = [];

  for (const range of windows) {
    if (range.startLine > totalLines) {
      const bound = range.endLine !== undefined ? `${range.startLine}-${range.endLine}` : `${range.startLine}`;
      notices.push(`[Range ${bound} is beyond end of file (${totalLines} lines total); skipped]`);
      continue;
    }
    const effectiveEnd = Math.min(range.endLine ?? totalLines, totalLines);
    covered.push({ start: range.startLine, end: effectiveEnd });
    const sliceText = range.lines.join("\n");
    blocks.push(formatText(sliceText, range.startLine, options?.raw));
  }
  await seen(covered);

  let outputText = blocks.length > 0 ? blocks.join("\n\n...\n\n") : "";
  if (notices.length > 0) {
    outputText = outputText ? `${outputText}\n${notices.join("\n")}` : notices.join("\n");
  }

  return {
    content: outputText,
    outcome: "ok",
  };
}

const READ_INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Absolute or relative path to the file to read",
    },
    offset: {
      type: "number",
      description: "0-based line offset to start reading from (default: 0). Only applies to text files.",
    },
    limit: {
      type: "number",
      description: "Maximum number of lines to return (default: 2000). Only applies to text files.",
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
  required: ["path"],
} as const;

const searchProperties = searchDefinition.inputSchema.properties;
const SEARCH_KEYS = typeof searchProperties === "object" && searchProperties !== null
  ? Object.keys(searchProperties).filter((key) => !Object.hasOwn(READ_INPUT_SCHEMA.properties, key)) : [];

function searchRequested(input: Readonly<RuntimeToolInput>): boolean {
  return SEARCH_KEYS.some((key) => Object.hasOwn(input, key));
}

const READ_DESCRIPTION_HEAD = "Read a file's contents; given a directory, read returns its entries. Text files are returned with ordinary one-based decimal line numbers followed by | (for example, 42|const x = 1). Append :raw to the path for verbatim content without line numbers. Append line ranges to the path: path:5-16, path:50+20 (20 lines from 50), or path:5-16,960-973 (multi-range); selectors compound, as in path:5-16:raw. Use symbol: \"functionName\" to read just that function (dot notation supported: \"Class.method\"). Use map: true to see the file's structural outline (functions, classes, types with line ranges).";
const READ_DESCRIPTION_TAIL = "When a file is truncated, a structural map is auto-appended. Image files (PNG, JPG, GIF, WebP) are returned as base64-encoded data. You can read multiple files in parallel; always parallelize when exploring related files.";
/** One text for both default-read behaviors, so the tool reads the same for
 *  every agent (ARCH-CONTEXT-018). */
const DEFAULT_READ_DESCRIPTION = `A read without a selector or read option returns the file from its first line, up to ${DEFAULT_LINE_LIMIT} lines, or a large supported code file as its structural summary; summary rows keep their original line numbers and the footer gives exact ranges for each elided body, so re-read its cited ranges to recover them.`;

interface ReadDefinitionOptions {
  readonly operations?: ReadOperations;
  /** A read without a selector or read option returns a large code file as
   *  its structural summary. False returns the file from its first line, up
   *  to the default line limit. True by default. */
  readonly structuralSummary?: boolean;
}

/** Create the read tool with file and image operations supplied by its host or tests. */
export function createReadDefinition(options?: ReadDefinitionOptions): RuntimeTool {
  const ops = options?.operations ?? defaultReadOperations;
  const structuralSummary = options?.structuralSummary ?? true;

  const definition: RuntimeTool = {
    name: "read",
    action: "file_read",
    description: [READ_DESCRIPTION_HEAD, DEFAULT_READ_DESCRIPTION, READ_DESCRIPTION_TAIL].join(" "),
    promptSnippet: "Read files (numbered text; images as base64). Supports :raw, line ranges, symbol, and structural map modes.",
    inputSchema: READ_INPUT_SCHEMA,
    inputValidationSchema: { anyOf: [
      { ...READ_INPUT_SCHEMA, properties: { ...READ_INPUT_SCHEMA.properties, path: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] } } },
      { ...searchDefinition.inputSchema, required: ["path", "pattern"] },
    ] },
    isConcurrencySafe: true,
    async prepareAdmission(input, context, signal) {
      signal?.throwIfAborted();
      if (searchRequested(input)) {
        const prepared = await prepareSearchPathInput(input, context);
        return { ...prepared, repair: {
          input: prepared.repair?.input ?? { ...input },
          notice: ["[Search arguments were supplied to read; searched the named path instead.]", prepared.repair?.notice].filter(Boolean).join("\n"),
        } };
      }
      const prepared = await prepareReadOnlyPathInput(input, context, "any", "read", (rawPath) => {
        const { path, sel } = splitPathAndSel(rawPath);
        return { path, suffix: sel === undefined ? "" : `:${sel}`, valid: sel === undefined || parseSel(sel).kind !== "none" };
      }, signal);
      const normalized = prepared.repair?.input ?? input;
      if (typeof input.symbol !== "string" || input.symbol.length === 0 || (input.offset === undefined && input.limit === undefined)) return prepared;
      const { offset, limit, ...symbolInput } = normalized;
      return { ...prepared, repair: {
        input: symbolInput,
        notice: [prepared.repair?.notice, `[Read symbol '${input.symbol}'; ignored ${[offset !== undefined ? "offset" : "", limit !== undefined ? "limit" : ""].filter(Boolean).join(" and ")}.]`].filter(Boolean).join("\n"),
      } };
    },
    async execute(input: RuntimeToolInput, context: ToolContext) {
      if (searchRequested(input)) return searchDefinition.execute(input, context);
      if (Array.isArray(input.path) && input.path.every((path): path is string => typeof path === "string")) {
        return executePathBatch(input.path, (path) => definition.execute({ ...input, path }, context));
      }
      if (typeof input.path === "string") {
        const directory = splitPathAndSel(input.path).path;
        if (hasKind(resolveToolPath(context.executionCwd, directory), "directory")) {
          const result = await listDefinition.execute({ path: directory, offset: input.offset, limit: input.limit }, context);
          return { ...result, content: `[Path '${directory}' is a directory; listed its contents instead.]\n${result.content}` };
        }
      }
      const resolved = resolveReadInput(input, context);
      if ("error" in resolved) return resolved.error;

      const { resolvedPath, ext, offset, limit, hasMap, symbol, raw, multiRanges, rawPath, summarize } = resolved;
      const record = (sha256: string) => coverageRecorder(context, resolvedPath, sha256);

      try {
        let result: ToolResult;
        if (isImageExtension(ext)) {
          result = await readImage(resolvedPath, ops);
        } else if (multiRanges) {
          result = await readTextMultiRange(resolvedPath, multiRanges, ops, record, { raw, signal: context.signal, ...(context.capabilities ? { has: context.capabilities } : {}) });
        } else {
          result = await readText(resolvedPath, offset, limit, ops, record, {
            map: hasMap,
            symbol,
            raw,
            summarize: structuralSummary && summarize,
            signal: context.signal,
            ...(context.capabilities ? { has: context.capabilities } : {}),
          });
        }

        return result;
      } catch (err) {
        if (context.signal?.aborted) {
          return { content: `Read of '${rawPath}' was interrupted before it could complete.`, outcome: "interrupted" };
        }
        const msg = errorMessage(err);
        // The model's own tool outcome, which its durable tool result holds.
        log.debug("failed to read file", { path: rawPath, error: msg, outcome: "error" });
        const hint = errnoCode(err) === "ENOENT" ? await missingPathHint(context, resolvedPath, "any") : "";
        return { content: `Failed to read '${rawPath}': ${msg}. Common causes: file does not exist, permission denied (the user may need to grant access), or the path points at a directory. ${context.capabilities?.("list") === false ? "Check" : "Use list to diagnose"} path spelling or directory structure, then read a specific file. Do not retry blindly; diagnose first.${hint}`, outcome: "error" };
      }
    },
  };
  return definition;
}

export const readDefinition = createReadDefinition();

/** The read tool of an agent of a workflow, which reads whole files. */
export const wholeFileReadDefinition = createReadDefinition({ structuralSummary: false });

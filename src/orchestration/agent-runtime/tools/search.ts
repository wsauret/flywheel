/**
 * Search tool - regex/literal search via ripgrep: validation, formatting,
 * grep invocation, error handling, and the factory/wiring layer.
 * Display metadata lives in `infra/tools/displays/search.ts`.
 */

import { displayRelativePath } from "../../../infra/tools/detail-helpers.js"
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isAbortError } from "../../../infra/abort.js";
import { errorDetail, errorMessage } from "../../../infra/error-message.js";
import { Log } from "../../../infra/log.js";
import { canonicalMutationPath } from "../../../infra/file-mutation-queue.js";
import { missingPathHint, resolveToolPath } from "./tool-paths.js";
import { PRUNED_DIR_GLOBS, prepareSearchPathInput, prunedDirectoriesNote } from "./search-paths.js";
import { PRUNED_DIR_NAMES, SEARCH_CPU_LIMIT_SECONDS, SEARCH_WALL_BACKSTOP_SECONDS, searchStoppedMessage } from "./search-rules.js";
import { formatMatchLine } from "./match-line-format.js";
import { checkNumericRange } from "./numeric-input.js";
import type { CapabilityCheck } from "../../../infra/capability-text.js";
import type { GrepMatch, GrepResult } from "./ripgrep.js";
import { grep, SearchStoppedError } from "./ripgrep.js";
import {
  distributeRoundRobin,
  rankFileGroups,
  groupByFile,
  maxOutputChars,
  selectWindow,
  trimToBudget,
} from "./search-pipeline.js";
import type { FileGroups } from "./search-pipeline.js";
import { isDefinitionLine, pathWeight, rankMatches } from "./search-ranking.js";
import type { RankOptions } from "./search-ranking.js";
import type { RuntimeTool, RuntimeToolInput, ToolAdmissionContext, ToolContext, ToolResult } from "./types.js";

const log = Log.create({ service: "agent-search" });

const SEARCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: "Regex or literal pattern to search for in file contents",
    },
    path: {
      type: "string",
      description: "Single file or directory to search (default: cwd). Do not pass multiple paths; issue multiple independent search tool calls in the same response instead.",
    },
    glob: {
      type: "string",
      description: "Glob pattern to filter files (e.g. \"*.ts\"). Include-filter only; it does not bypass the default artifact-directory exclusions (pass path to search inside one).",
    },
    type: {
      type: "string",
      description: "Ripgrep file type filter (e.g. \"js\", \"py\", \"rust\")",
    },
    case_insensitive: {
      type: "boolean",
      description: "Case-insensitive search (default: false)",
    },
    context: {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description: "Lines of context around each match (0-100)",
    },
    output_mode: {
      type: "string",
      enum: ["matching_files", "content", "count"],
      description: "Output shape. \"matching_files\" (default, fast) lists files whose contents match, ranked with definition-holding and source files first (recency as tiebreaker). \"content\" shows matching lines with one-based line numbers and context, ranked definitions-first then distributed across files; match lines are prefixed with *, context lines with a space, and long lines truncate at 500 columns. \"count\" returns exact per-file match counts and a total, like `grep -c` (no match cap; sorted by count).",
    },
    multiline: {
      type: "boolean",
      description: "Enable multiline matching for cross-line patterns (default: false)",
    },
    limit: {
      type: "number",
      description: "Maximum number of matches to return - the first N, like `grep -m N` (combine with tail: true for the last N). In matching_files mode: maximum number of files listed, like `grep -l pattern dir | head -N`. In count mode: maximum number of files listed",
    },
    tail: {
      type: "boolean",
      description: "Return the LAST `limit` matches instead of the first, like `grep pattern file | tail -N`. Implies content mode; matches come back in plain file order (relevance ranking off) and the reported total match count is exact. The way to read the end of a log or other append-only file (default: false). Cannot combine with output_mode matching_files or count.",
    },
    skip: {
      type: "number",
      description: "Files to skip for pagination; use when the prior call hit the file limit (default: 20 files per page)",
    },
    prefer_tests: {
      type: "boolean",
      description: "Promote tests and fixtures over source paths when searching tests intentionally (default: false)",
    },
  },
  required: ["pattern"],
} as const;

const SEARCH_PROMPT_EXAMPLES = `Wrong: one path string containing multiple roots
{"pattern":"createSession","path":"src tests"}

Right: independent calls in the same response
{"pattern":"createSession","path":"src"}
{"pattern":"createSession","path":"tests"}`;

export const searchDefinition: RuntimeTool = {
  name: "search",
  action: "search",
  description: `Search file contents using regex or literal patterns via native ripgrep; output_mode selects the result shape and tail reads the end of a file. Supports full regex syntax (e.g. "log.*Error", "function\\\\s+\\\\w+"). Literal braces need escaping ("interface\\\\{\\\\}" to find "interface{}" in Go). Searches ignored files, but a directory search skips artifact directories (${PRUNED_DIR_NAMES.slice(0, 6).join(", ")}, and similar), the runtime state directory, and every directory that the repository's .gitignore excludes; pass path at or inside one to search it explicitly. A search is stopped with an error after ${SEARCH_CPU_LIMIT_SECONDS} seconds of processing time, or after ${SEARCH_WALL_BACKSTOP_SECONDS} seconds spent waiting on slow file reads; narrow path/glob/type when that happens. path names one file or directory; glob and type constrain which files are searched, so omit path and constrain with glob to cover several roots at once. PERFORMANCE TIP: Use multiple independent search tool calls in a single response to search different patterns or directories in parallel; do not combine multiple paths in one path value.`,
  promptExamples: SEARCH_PROMPT_EXAMPLES,
  inputSchema: SEARCH_INPUT_SCHEMA,
  isConcurrencySafe: true,
  async prepareAdmission(input, context) {
    let repaired = { ...input };
    const notices: string[] = [];
    if (typeof input.tail === "number" && (input.limit === undefined || input.limit === input.tail)) {
      repaired = { ...repaired, tail: true, limit: input.tail };
      notices.push(`Note: numeric tail ${input.tail} was read as tail: true with limit: ${input.tail}.`);
    }
    if (typeof input.literal === "boolean" && (!input.literal || typeof input.pattern === "string")) {
      const { literal, ...rest } = repaired;
      repaired = rest;
      if (literal === true && typeof input.pattern === "string") {
        repaired.pattern = RegExp.escape(input.pattern);
        notices.push("Note: literal: true was read as a fixed-string search; regex metacharacters in pattern were escaped.");
      } else {
        notices.push("Note: literal: false was omitted; pattern remains a regex.");
      }
    }
    const paths = await prepareSearchPathInput(repaired, context);
    if (paths.repair) notices.push(paths.repair.notice);
    return {
      ...paths,
      ...(notices.length > 0 ? { repair: { input: paths.repair?.input ?? repaired, notice: notices.join("\n") } } : {}),
    };
  },
  async execute(input: RuntimeToolInput, context: ToolContext) {
    const validated = await validateSearchInput(input, context);
    if (validated.kind === "error") return validated.result;
    const { pattern, searchPath, effectiveLimit, outputMode, globPattern, fileType, ignoreCase, multiline, contextLines, internalLimit, tail, skip, rank } = validated;

    try {
      // The native side enforces the processor-time limit and the wall-clock
      // backstop: the task rejects at either no matter what its worker is
      // doing, and handleSearchError maps that rejection to narrow-your-search
      // guidance. Abort signals reject via napi, and the shared budget stops
      // the scan at its next checkpoint (pre-aborted signals reject in the
      // grep wrapper).
      const { result, engine } = await grepWithPcre2Fallback({
        pattern,
        path: searchPath,
        glob: globPattern,
        excludeGlobs: PRUNED_DIR_GLOBS,
        type: fileType,
        ignoreCase,
        multiline: multiline || undefined,
        maxCount: internalLimit,
        offset: outputMode === "filesWithMatches" ? skip : undefined,
        context: contextLines,
        maxColumns: MAX_COLUMN_WIDTH,
        cpuLimitMs: SEARCH_CPU_LIMIT_SECONDS * 1000,
        timeoutMs: SEARCH_WALL_BACKSTOP_SECONDS * 1000,
        mode: outputMode,
        tail: tail || undefined,
        protectedTraversalRoots: context.protectedTraversalRoots,
      }, context.signal);
      const observationPosition = context.readLedger && outputMode === "content"
        ? await context.projectionReader?.capturePosition() ?? 0
        : 0;

      let formatted: ToolResult;
      if (result.matches.length === 0) {
        if (result.skipReason) {
          const rel = displayRelativePath(searchPath, context.executionCwd);
          formatted = {
            content: `Cannot search '${rel}': ${result.skipReason}. The file was not searched; no matches returned.${skippedFileAlternatives(context.capabilities)}`,
            outcome: "error",
          };
        } else {
          formatted = { content: "No matches found", outcome: "ok" };
        }
      } else if (outputMode === "count") {
        formatted = formatCountOutput(result.matches, result, context, effectiveLimit);
      } else if (outputMode === "content") {
        formatted = tail
          ? formatTailOutput(result.matches, result, context, observationPosition)
          : formatContentOutput(result.matches, result, context, effectiveLimit, skip, rank, observationPosition);
      } else {
        formatted = formatMatchingFilesOutput(result.matches, result, context, effectiveLimit, rank);
      }
      return withEngineNote(appendSearchDiagnostics(formatted, result, context.executionCwd), engine);
    } catch (err) {
      if (isAbortError(err)) throw err;
      return handleSearchError(err, pattern, searchPath, context.executionCwd);
    }
  },
};

// Validation, ranking, formatting, and error handling (formerly
// search-helpers.ts, split only to satisfy the old 400-line cap; single
// consumer, merged back). The exported formatters/validator are exercised
// directly by the ranking unit tests.

const MAX_MATCHES = 500;
const DEFAULT_HEAD_LIMIT = 200;
const DEFAULT_FILE_LIMIT = 20;
export const MAX_COLUMN_WIDTH = 500;
const MAX_CONTEXT_LINES = 100;
const OVERSAMPLE_FACTOR = 5;

type SearchOutputMode = "matching_files" | "content" | "count";
function searchDiagnostics(result: GrepResult, executionCwd: string): string[] {
  const notes: string[] = [];
  const failures = result.searchFailures ?? [];
  const otherSkipped = result.filesSkipped - failures.length;
  if (otherSkipped > 0) notes.push(`${otherSkipped} file(s) were skipped because they were binary, unreadable, or not regular files.`);
  if (failures.length > 0) {
    const listed = failures.slice(0, 5).map((failure) => `${failure.path} (${failure.reason})`).join(", ");
    const more = failures.length > 5 ? ` and ${failures.length - 5} more` : "";
    notes.push(`${failures.length} file(s) could not be searched with this pattern, so counts exclude them: ${listed}${more}.`);
  }
  if (result.traversalIssues > 0) notes.push(`${result.traversalIssues} linked directory branch(es) could not be traversed or entered a protected credential root; other results are unaffected.`);
  if (result.entryLimitReached) notes.push("The filesystem walk reached its entry limit. Search scanned only the retained prefix; narrow the path.");
  const pruned = prunedDirectoriesNote(result.prunedDirectories ?? [], (directory) => displayRelativePath(directory, executionCwd));
  if (pruned) notes.push(pruned);
  return notes;
}

function appendSearchDiagnostics(toolResult: ToolResult, result: GrepResult, executionCwd: string): ToolResult {
  const diagnostics = searchDiagnostics(result, executionCwd);
  if (diagnostics.length === 0) return toolResult;
  const terminal = `\n\n[${diagnostics.join(" ")}]`;
  return {
    ...toolResult,
    content: typeof toolResult.content === "string" ? `${toolResult.content}${terminal}` : toolResult.content,
    ...(toolResult.fullContent ? { fullContent: `${toolResult.fullContent.trimEnd()}${terminal}\n` } : {}),
  };
}

type SearchEngine = "default" | "pcre2";

/** Runs the Rust regex engine, and reruns with PCRE2 when Rust refuses the pattern, so that
 *  look-around and backreferences work. Rust refuses at compile time, before any scan, so the
 *  rerun costs no second walk, and it shares the first attempt's wall-clock backstop, which
 *  admission wait can have spent. A pattern that PCRE2 also refuses reports Rust's error. */
/** The other ways to inspect a file that search skipped, from the tools that the calling agent holds. */
function skippedFileAlternatives(has: CapabilityCheck | undefined): string {
  const ways = [...(has?.("bash") !== false ? ["use bash (rg/grep against the path directly)"] : []), ...(has?.("read") !== false ? ["read it via the read tool"] : [])];
  return ways.length > 0 ? ` If you need to inspect this file, ${ways.join(" or ")}.` : "";
}

async function grepWithPcre2Fallback(options: Parameters<typeof grep>[0], signal: AbortSignal | undefined): Promise<{ result: GrepResult; engine: SearchEngine }> {
  const deadline = performance.now() + options.timeoutMs;
  try {
    return { result: await grep(options, signal), engine: "default" };
  } catch (rustFailure) {
    if (!errorMessage(rustFailure).includes("regex parse error")) throw rustFailure;
    try {
      return { result: await grep({ ...options, engine: "pcre2", timeoutMs: Math.max(0, Math.ceil(deadline - performance.now())) }, signal), engine: "pcre2" };
    } catch (pcre2Failure) {
      if (errorMessage(pcre2Failure).includes("PCRE2: error compiling")) throw rustFailure;
      throw pcre2Failure;
    }
  }
}

function withEngineNote(toolResult: ToolResult, engine: SearchEngine): ToolResult {
  if (engine === "default") return toolResult;
  const note = "Note: the pattern uses features that the default regex engine does not support, such as look-around or backreferences, so it ran with PCRE2.\n\n";
  return {
    ...toolResult,
    content: typeof toolResult.content === "string" ? `${note}${toolResult.content}` : toolResult.content,
    ...(toolResult.fullContent ? { fullContent: `${note}${toolResult.fullContent}` } : {}),
  };
}

function getMtime(filePath: string): number {
  try { return statSync(filePath).mtimeMs; }
  catch (err) {
    log.debug("search result mtime read failed", { filePath, error: errorMessage(err), errorDetail: errorDetail(err) });
    return 0;
  }
}

function resolveMatchPath(executionCwd: string, filePath: string) {
  const absolute = isAbsolute(filePath) ? filePath : resolve(executionCwd, filePath);
  return { absolute, display: displayRelativePath(absolute, executionCwd) };
}

export function formatMatchingFilesOutput(
  matches: GrepMatch[],
  result: GrepResult,
  context: ToolContext,
  limit: number,
  rank: RankOptions,
): ToolResult {
  const executionCwd = context.executionCwd;
  const fileMap = new Map<string, string>();
  const fileHasDefinition = new Map<string, boolean>();
  for (const match of matches) {
    const { absolute, display } = resolveMatchPath(executionCwd, match.path);
    if (!fileMap.has(display)) fileMap.set(display, absolute);
    if (isDefinitionLine(match.line)) fileHasDefinition.set(display, true);
    else if (!fileHasDefinition.has(display)) fileHasDefinition.set(display, false);
  }
  const entries = [...fileMap.entries()].sort((a, b) =>
    rank.rankingEnabled
      ? Number(fileHasDefinition.get(b[0]) === true) - Number(fileHasDefinition.get(a[0]) === true) ||
        pathWeight(a[0], rank.preferTests) - pathWeight(b[0], rank.preferTests) ||
        getMtime(b[1]) - getMtime(a[1])
      : getMtime(b[1]) - getMtime(a[1]),
  );
  const paths = entries.map(([display]) => display);
  const bestPath = rank.rankingEnabled ? paths[0] : undefined;
  const bestIsDef = bestPath !== undefined && fileHasDefinition.get(bestPath) === true;

  const truncated = result.limitReached || matches.length >= limit;
  const shown = Math.min(paths.length, limit);

  const bestNote = bestPath !== undefined ? `; best: ${bestPath}${bestIsDef ? " [def]" : ""}` : "";
  const summary = truncated
    ? `Found matches in ${paths.length} file(s)${bestNote}; showing ${shown}.`
    : `Found matches in ${paths.length} file(s)${bestNote}`;

  const visible = paths.slice(0, limit).join("\n");
  const content = `${summary}\n\n${visible}`;
  const toolResult: ToolResult = { content, outcome: "ok" };
  if (truncated) {
    toolResult.fullContent = `Found matches in ${paths.length} file(s)\n\n${paths.join("\n")}\n`;
  }
  return toolResult;
}

interface RenderMatchResult {
  modelLines: string[];
  displayLines: string[];
}

interface RenderedLine {
  text: string;
  isMatch: boolean;
}

/** Render selected matches grouped by file with overlapping context windows
 *  merged: each line renders once, match lines win over context lines, and
 *  lines emit in ascending order (the explicit line numbers make region gaps
 *  legible). Without merging, clustered matches re-render nearly identical
 *  context blocks and drown the visible window in duplicates. */
function renderMatchLines(matches: GrepMatch[], executionCwd: string): RenderMatchResult {
  const fileOrder: string[] = [];
  const linesByFile = new Map<string, Map<number, RenderedLine>>();

  for (const match of matches) {
    const { display } = resolveMatchPath(executionCwd, match.path);
    let lines = linesByFile.get(display);
    if (!lines) {
      lines = new Map();
      linesByFile.set(display, lines);
      fileOrder.push(display);
    }
    for (const ctx of [...(match.contextBefore ?? []), ...(match.contextAfter ?? [])]) {
      if (!lines.get(ctx.lineNumber)?.isMatch) {
        lines.set(ctx.lineNumber, { text: ctx.line, isMatch: false });
      }
    }
    lines.set(match.lineNumber, { text: match.line, isMatch: true });
  }

  const modelLines: string[] = [];
  const displayLines: string[] = [];
  for (const file of fileOrder) {
    if (modelLines.length > 0) {
      modelLines.push("");
      displayLines.push("");
    }
    modelLines.push(`# ${file}`);
    displayLines.push(`# ${file}`);
    // SAFETY: fileOrder entries are inserted together with their map entry above.
    const sorted = [...linesByFile.get(file)!.entries()].sort((a, b) => a[0] - b[0]);
    for (const [lineNumber, line] of sorted) {
      modelLines.push(formatMatchLine(lineNumber, line.text, line.isMatch));
      displayLines.push(line.isMatch ? `>> ${lineNumber}: ${line.text}` : `  ${lineNumber}: ${line.text}`);
    }
  }
  return { modelLines, displayLines };
}


const REMAINING_FILES_LISTED = 8;

/** Names the files holding matches that the visible window dropped, so the
 *  model can go straight to the right file instead of re-running a broader
 *  search. Counts cover only the matches the engine returned; `enginePartial`
 *  flags that more matches exist beyond the engine's cap. */
function remainingMatchesNote(groups: FileGroups, selected: readonly GrepMatch[], executionCwd: string, enginePartial: boolean): string {
  const shown = new Map<string, number>();
  for (const m of selected) shown.set(m.path, (shown.get(m.path) ?? 0) + 1);
  const remaining = groups.fileOrder
    .map((path) => ({ path, count: (groups.byFile.get(path)?.length ?? 0) - (shown.get(path) ?? 0) }))
    .filter((entry) => entry.count > 0);
  if (remaining.length === 0) return "";
  const listed = remaining
    .slice(0, REMAINING_FILES_LISTED)
    .map(({ path, count }) => `${resolveMatchPath(executionCwd, path).display} (${count})`)
    .join(", ");
  const overflow = remaining.length > REMAINING_FILES_LISTED ? `, +${remaining.length - REMAINING_FILES_LISTED} more file(s)` : "";
  const partial = enginePartial ? "; counts are partial (engine match cap reached)" : "";
  return `\nMatches not shown: ${listed}${overflow}${partial}.`;
}

export function formatContentOutput(
  matches: GrepMatch[],
  result: GrepResult,
  context: ToolContext,
  limit: number,
  skip: number,
  rank: RankOptions,
  observationPosition = 0,
): ToolResult {
  const executionCwd = context.executionCwd;


  // Pure selection pipeline: group -> rank files -> window -> rank matches -> distribute -> trim.
  const groups = rankFileGroups(groupByFile(matches), rank);
  const { windowMatches, fileLimitReached, skipFiles, windowFileCount, totalFiles } =
    selectWindow(groups, skip, DEFAULT_FILE_LIMIT);
  const ranked = rankMatches(windowMatches, rank);
  const distributed = distributeRoundRobin(ranked, limit); // tier-aware: round-robins ACROSS FILES WITHIN EACH TIER
  // The char budget is a ranking-mode affordance. With ranking OFF (the default)
  // we must match the old window/round-robin path byte-for-byte - the old code
  // never imposed a char cap - so the trim only runs when ranking is enabled.
  const uniqueFiles = new Set(distributed.map((r) => r.match.path)).size;
  const trimmed = rank.rankingEnabled
    ? trimToBudget(distributed, maxOutputChars(uniqueFiles)) // pure, renderer-independent estimate
    : distributed;
  const selectedMatches = trimmed.map((r) => r.match);
  recordMatchesSeen(selectedMatches, context, observationPosition);

  const rendered = renderMatchLines(selectedMatches, executionCwd);
  // limit hit OR engine hit its own limit OR the char budget dropped matches => recoverable.
  const truncated =
    result.limitReached || distributed.length >= limit || trimmed.length < distributed.length;
  const summary = truncated
    ? `${result.totalMatches} match(es) in ${result.filesWithMatches} file(s); showing ${selectedMatches.length}.${remainingMatchesNote(groups, selectedMatches, executionCwd, result.limitReached === true)}`
    : `${result.totalMatches} match(es) in ${result.filesWithMatches} file(s)`;

  let paginationNote = "";
  if (fileLimitReached) {
    const nextSkip = skipFiles + windowFileCount;
    paginationNote = `\nShowing files ${skipFiles + 1}-${nextSkip} of ${totalFiles}. Use skip=${nextSkip} for next page.`;
  }

  const content = `${summary}\n\n${rendered.modelLines.join("\n")}${paginationNote}`;
  const toolResult: ToolResult = { content, outcome: "ok" };
  toolResult.details = { displayContent: rendered.displayLines.join("\n") };
  if (truncated) {
    const fullRendered = renderMatchLines(matches, executionCwd);
    toolResult.fullContent = `${result.totalMatches} match(es) in ${result.filesWithMatches} file(s)\n\n${fullRendered.modelLines.join("\n")}\n`;
  }
  return toolResult;
}

/** Last-N content matches, the `grep pattern file | tail -N` analogue: the
 *  engine kept only the final `limit` matches (ring buffer over a full scan),
 *  so everything received renders, grouped by file. totalMatches is exact
 *  because a tail scan never stops early. */
/** Search shows lines without proving the whole file; the ledger records them as seen, not read. */
function recordMatchesSeen(matches: readonly GrepMatch[], context: ToolContext, observationPosition: number): void {
  const ledger = context.readLedger;
  if (!ledger) return;
  const byPath = new Map<string, { start: number; end: number }[]>();
  for (const match of matches) {
    const canonical = canonicalMutationPath(resolveMatchPath(context.executionCwd, match.path).absolute);
    const lines = byPath.get(canonical) ?? [];
    const numbers = [match.lineNumber, ...(match.contextBefore ?? []).map((line) => line.lineNumber), ...(match.contextAfter ?? []).map((line) => line.lineNumber)];
    lines.push({ start: Math.min(...numbers), end: Math.max(...numbers) });
    byPath.set(canonical, lines);
  }
  for (const [canonical, lines] of byPath) ledger.recordSeen(canonical, lines, observationPosition);
}

function formatTailOutput(matches: GrepMatch[], result: GrepResult, context: ToolContext, observationPosition: number): ToolResult {
  recordMatchesSeen(matches, context, observationPosition);
  const rendered = renderMatchLines(matches, context.executionCwd);
  const counts = `${result.totalMatches} match(es) in ${result.filesWithMatches} file(s)`;
  const summary = result.totalMatches > matches.length
    ? `${counts}; showing last ${matches.length}.`
    : counts;
  const toolResult: ToolResult = { content: `${summary}\n\n${rendered.modelLines.join("\n")}`, outcome: "ok" };
  toolResult.details = { displayContent: rendered.displayLines.join("\n") };
  return toolResult;
}

/** Per-file match counts, the `grep -c` analogue. Counts are exact: count
 *  mode runs without a match cap, bounded only by the search time budget. */
function formatCountOutput(matches: GrepMatch[], result: GrepResult, context: ToolContext, limit: number): ToolResult {
  const entries = matches
    .map((match) => ({
      display: resolveMatchPath(context.executionCwd, match.path).display,
      count: match.matchCount!, // SAFETY: count-mode entries always carry matchCount (grep.rs sets it for every counted file).
    }))
    .sort((a, b) => b.count - a.count || a.display.localeCompare(b.display));
  const lines = entries.map((entry) => `${entry.display}: ${entry.count}`);
  const summary = `${result.totalMatches} match(es) in ${result.filesWithMatches} file(s)`;
  if (entries.length <= limit) {
    return { content: `${summary}\n\n${lines.join("\n")}`, outcome: "ok" };
  }
  return {
    content: `${summary}; showing ${limit} file(s).\n\n${lines.slice(0, limit).join("\n")}`,
    outcome: "ok",
    fullContent: `${summary}\n\n${lines.join("\n")}\n`,
  };
}

type ValidatedSearchInput =
  | {
      kind: "ok";
      pattern: string;
      searchPath: string;
      effectiveLimit: number;
      outputMode: "content" | "filesWithMatches" | "count";
      globPattern: string | undefined;
      fileType: string | undefined;
      ignoreCase: boolean;
      multiline: boolean;
      contextLines: number | undefined;
      internalLimit: number | undefined;
      tail: boolean;
      skip: number;
      rank: RankOptions;
    }
  | { kind: "error"; result: ToolResult };

function searchInputError(content: string): ValidatedSearchInput {
  return { kind: "error", result: { content, outcome: "error" } };
}

export async function validateSearchInput(input: RuntimeToolInput, context: ToolAdmissionContext): Promise<ValidatedSearchInput> {
  const executionCwd = context.executionCwd;
  if (typeof input.pattern !== "string") {
    return searchInputError("search was called without a 'pattern' string. Provide the regex or literal you want to search for as 'pattern'.");
  }
  const pattern = input.pattern;
  if (!pattern.trim()) {
    return searchInputError("search was called with an empty 'pattern'. An empty regex would match everything; narrow the pattern to what you actually want to find.");
  }

  const rawSearchPath = typeof input.path === "string" ? input.path : undefined;
  const searchPath = rawSearchPath ? resolveToolPath(executionCwd, rawSearchPath) : executionCwd;

  if (!existsSync(searchPath)) {
    if (rawSearchPath) {
      const pathParts = rawSearchPath.trim().split(/\s+/);
      if (pathParts.length > 1 && pathParts.every((part) => existsSync(resolveToolPath(executionCwd, part)))) {
        const listedPaths = pathParts.map((part) => `'${part}'`).join(", ");
        return searchInputError(`search path '${rawSearchPath}' looks like multiple paths that one search cannot cover, because a path is outside the execution directory, protected, or inside an artifact or ignored directory. Issue separate independent search tool calls in the same response for ${listedPaths}.`);
      }
    }

    const rel = displayRelativePath(searchPath, executionCwd);
    return searchInputError(`search path '${rel}' does not exist (resolved to ${searchPath}). Check the directory name and retry; the execution directory is ${executionCwd}.${await missingPathHint(context, searchPath, "any")}`);
  }

  const limitCheck = checkNumericRange(input.limit, "limit", { min: 1 });
  if ("error" in limitCheck) return searchInputError(limitCheck.error);
  const effectiveLimit = limitCheck.value ?? DEFAULT_HEAD_LIMIT;

  const rawOutputMode = input.output_mode;
  if (
    rawOutputMode !== undefined &&
    rawOutputMode !== "matching_files" &&
    rawOutputMode !== "content" &&
    rawOutputMode !== "count"
  ) {
    return searchInputError("search output_mode must be 'matching_files', 'content', or 'count'.");
  }
  const tail = input.tail === true;
  if (tail && rawOutputMode !== undefined && rawOutputMode !== "content") {
    return searchInputError(`tail: true returns the last N matching lines, which is content mode; it cannot combine with output_mode '${rawOutputMode}'. Drop output_mode (tail implies content) or drop tail - matching_files already ranks recently modified files first, and count mode totals are always exact.`);
  }
  const outputMode: SearchOutputMode = rawOutputMode ?? (tail ? "content" : "matching_files");
  const isContent = outputMode === "content";
  const isCount = outputMode === "count";

  const skipCheck = checkNumericRange(input.skip, "skip", { min: 0 });
  if ("error" in skipCheck) return searchInputError(skipCheck.error);
  const rawSkip = skipCheck.value !== undefined ? Math.floor(skipCheck.value) : 0;
  const contextCheck = checkNumericRange(input.context, "context", { min: 0, max: MAX_CONTEXT_LINES });
  if ("error" in contextCheck || contextCheck.value !== undefined && !Number.isInteger(contextCheck.value)) {
    return searchInputError(`context must be a whole number from 0 through ${MAX_CONTEXT_LINES}. Provide a value in range and call the tool again.`);
  }

  return {
    kind: "ok",
    pattern,
    searchPath,
    effectiveLimit,
    outputMode: isContent ? "content" : isCount ? "count" : "filesWithMatches",
    globPattern: typeof input.glob === "string" ? input.glob : undefined,
    fileType: typeof input.type === "string" ? input.type : undefined,
    ignoreCase: input.case_insensitive === true,
    multiline: input.multiline === true,
    contextLines: contextCheck.value,
    // Count mode scans uncapped so counts are exact (grep -c semantics);
    // tail keeps exactly the last `limit` matches, so no oversampling.
    internalLimit: isCount
      ? undefined
      : isContent && !tail
        ? Math.min(effectiveLimit * OVERSAMPLE_FACTOR, MAX_MATCHES)
        : Math.min(effectiveLimit, MAX_MATCHES),
    tail,
    skip: rawSkip,
    // Ranking ships ON by default: the first-search benchmark shows a large
    // relevance gain with bounded output growth. prefer_tests flips the
    // source-vs-test weighting per call; the benchmark harness drives
    // rankingEnabled:false to measure the off baseline. Tail must preserve
    // file order and count mode has no lines to rank, so both disable it.
    rank: { rankingEnabled: !tail && !isCount, preferTests: input.prefer_tests === true },
  };
}

export function handleSearchError(failure: unknown, pattern: string, searchPath: string, executionCwd: string): ToolResult {
  if (failure instanceof SearchStoppedError) return { content: searchStoppedMessage("search", failure.stop), outcome: "error" };
  const msg = errorMessage(failure);
  if (msg.includes("regex parse error")) {
    return { content: `Invalid regex in 'pattern': ${msg}. Common causes: unescaped metacharacters (literal { } [ ] ( ) need backslash escapes), unbalanced groups, or syntax that neither the Rust regex engine nor PCRE2 accepts. Simplify the pattern or escape literal characters and retry.`, outcome: "error" };
  }
  const rel = displayRelativePath(searchPath, executionCwd);
  log.warn("search failed", { pattern, path: rel, error: msg });
  return { content: `search failed on path '${rel}': ${msg}. Verify the path exists and the constraints are correct, then retry.`, outcome: "error" };
}

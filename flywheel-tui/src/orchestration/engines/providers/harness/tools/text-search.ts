import { statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { errorMessage } from "../../../../../infra/error-message.js";
import { Log } from "../../../../../infra/log.js";
import { grep, type GrepMatch, type GrepResult } from "./ripgrep.js";
import type { ToolDefinition, ToolResult, ToolContext } from "./types.js";
import { truncateToolOutput } from "./tool-utils.js";

const log = Log.create({ service: "harness-text-search" });

const MAX_MATCHES = 500;
const DEFAULT_HEAD_LIMIT = 200;
const MAX_COLUMN_WIDTH = 500;
const OVERSAMPLE_FACTOR = 5;

function truncateColumn(line: string): string {
  if (line.length <= MAX_COLUMN_WIDTH) return line;
  return `${line.slice(0, MAX_COLUMN_WIDTH)}...`;
}

function getMtime(filePath: string): number {
  try { return statSync(filePath).mtimeMs; }
  catch { return 0; }
}

/** Distribute matches evenly across files so one large file can't dominate. */
function roundRobinSelect(matches: GrepMatch[], limit: number): GrepMatch[] {
  if (matches.length <= limit) return matches;

  const byFile = new Map<string, GrepMatch[]>();
  for (const m of matches) {
    const arr = byFile.get(m.path);
    if (arr) arr.push(m);
    else byFile.set(m.path, [m]);
  }

  const result: GrepMatch[] = [];
  const iterators = [...byFile.values()].map((arr) => ({ arr, idx: 0 }));

  while (result.length < limit) {
    let added = false;
    for (const it of iterators) {
      if (result.length >= limit) break;
      if (it.idx < it.arr.length) {
        result.push(it.arr[it.idx]!);
        it.idx++;
        added = true;
      }
    }
    if (!added) break;
  }
  return result;
}

function formatFilePathsOutput(
  matches: GrepMatch[],
  result: GrepResult,
  cwd: string,
  limit: number,
): ToolResult {
  const fileMap = new Map<string, string>();
  for (const match of matches) {
    const rel = relative(cwd, match.path);
    const display = rel || match.path;
    if (!fileMap.has(display)) fileMap.set(display, match.path);
  }

  const entries = [...fileMap.entries()].sort((a, b) => getMtime(b[1]) - getMtime(a[1]));
  const paths = entries.map(([display]) => display);

  const summary = `Found matches in ${paths.length} file(s)`;
  const truncationNote = result.limitReached || matches.length >= limit ? "\n\n... results truncated" : "";
  const output = `${summary}\n\n${paths.join("\n")}${truncationNote}`;
  return { content: truncateToolOutput(output), isError: false };
}

function formatContentOutput(
  matches: GrepMatch[],
  result: GrepResult,
  cwd: string,
  limit: number,
): ToolResult {
  const selected = roundRobinSelect(matches, limit);
  const lines: string[] = [];
  let currentFile = "";

  for (const match of selected) {
    const rel = relative(cwd, match.path);
    const displayPath = rel || match.path;

    if (displayPath !== currentFile) {
      if (currentFile) lines.push("");
      lines.push(`# ${displayPath}`);
      currentFile = displayPath;
    }

    if (match.contextBefore) {
      for (const ctx of match.contextBefore) {
        lines.push(`  ${ctx.lineNumber}: ${truncateColumn(ctx.line)}`);
      }
    }

    lines.push(`>> ${match.lineNumber}: ${truncateColumn(match.line)}`);

    if (match.contextAfter) {
      for (const ctx of match.contextAfter) {
        lines.push(`  ${ctx.lineNumber}: ${truncateColumn(ctx.line)}`);
      }
    }
  }

  const summary = `${result.totalMatches} match(es) in ${result.filesWithMatches} file(s)`;
  const truncationNote = result.limitReached || selected.length >= limit ? "\n\n... results truncated" : "";
  const output = `${summary}\n\n${lines.join("\n")}${truncationNote}`;
  return { content: truncateToolOutput(output), isError: false };
}

function runGrep(
  pattern: string,
  searchPath: string,
  globPattern: string | undefined,
  fileType: string | undefined,
  ignoreCase: boolean,
  multiline: boolean,
  maxCount: number,
  contextLines: number | undefined,
  mode: "content" | "filesWithMatches",
  gitignoreOverride?: boolean,
): GrepResult {
  return grep({
    pattern,
    path: searchPath,
    glob: globPattern,
    type: fileType,
    ignoreCase,
    multiline: multiline || undefined,
    maxCount,
    context: contextLines,
    maxColumns: MAX_COLUMN_WIDTH,
    mode,
    ...(gitignoreOverride !== undefined ? { gitignore: gitignoreOverride } : {}),
  });
}

function createTextSearchDefinition(): ToolDefinition {
  return {
    name: "text_search",
    description:
      "Search file contents using regex or literal patterns via native ripgrep. " +
      'Two output modes: "file_paths" (default, fast) lists matching files sorted by modification time, ' +
      '"content" shows matching lines with context (distributed evenly across files). ' +
      "Supports full regex syntax (e.g. \"log.*Error\", \"function\\\\s+\\\\w+\"). " +
      "Literal braces need escaping (\"interface\\\\{\\\\}\" to find \"interface{}\" in Go). " +
      "Respects .gitignore by default. " +
      "PERFORMANCE TIP: Make multiple speculative search calls in a single response " +
      "to speed up discovery.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regex or literal pattern to search for",
        },
        path: {
          type: "string",
          description: "File or directory to search (default: cwd)",
        },
        glob_pattern: {
          type: "string",
          description: 'Glob pattern to filter files (e.g. "*.ts")',
        },
        type: {
          type: "string",
          description: 'Ripgrep file type filter (e.g. "js", "py", "rust")',
        },
        case_insensitive: {
          type: "boolean",
          description: "Case-insensitive search (default: false)",
        },
        context: {
          type: "number",
          description: "Lines of context around each match",
        },
        output_mode: {
          type: "string",
          enum: ["file_paths", "content"],
          description: 'Output mode: "file_paths" (default) or "content"',
        },
        multiline: {
          type: "boolean",
          description: "Enable multiline matching for cross-line patterns (default: false)",
        },
        head_limit: {
          type: "number",
          description: "Maximum number of matches to return",
        },
      },
      required: ["pattern"],
    },
    async execute(input: Record<string, unknown>, context: ToolContext) {
      if (typeof input.pattern !== "string") {
        return { content: "text_search requires a string 'pattern' parameter", isError: true };
      }

      const pattern = input.pattern;
      if (!pattern.trim()) return { content: "Pattern must not be empty", isError: true };

      const searchPath = typeof input.path === "string"
        ? (input.path.startsWith("/") ? input.path : resolve(context.cwd, input.path))
        : context.cwd;

      const effectiveLimit = typeof input.head_limit === "number" ? input.head_limit : DEFAULT_HEAD_LIMIT;
      const isContent = input.output_mode === "content";
      const outputMode = isContent ? "content" : "filesWithMatches";
      const globPattern = typeof input.glob_pattern === "string" ? input.glob_pattern : undefined;
      const fileType = typeof input.type === "string" ? input.type : undefined;
      const ignoreCase = input.case_insensitive === true;
      const multiline = input.multiline === true;
      const contextLines = typeof input.context === "number" ? input.context : undefined;
      // Oversample for content mode so round-robin has material to distribute
      const internalLimit = isContent
        ? Math.min(effectiveLimit * OVERSAMPLE_FACTOR, MAX_MATCHES)
        : Math.min(effectiveLimit, MAX_MATCHES);

      try {
        let result = runGrep(pattern, searchPath, globPattern, fileType, ignoreCase, multiline, internalLimit, contextLines, outputMode);

        // Gitignore fallback: retry without gitignore if 0 results
        if (result.matches.length === 0) {
          result = runGrep(pattern, searchPath, globPattern, fileType, ignoreCase, multiline, internalLimit, contextLines, outputMode, false);
          if (result.matches.length > 0) {
            log.info("gitignore fallback found results", { pattern, count: result.matches.length });
          }
        }

        if (result.matches.length === 0) {
          return { content: "No matches found", isError: false };
        }

        if (isContent) {
          return formatContentOutput(result.matches, result, context.cwd, effectiveLimit);
        }
        return formatFilePathsOutput(result.matches, result, context.cwd, effectiveLimit);
      } catch (err) {
        const msg = errorMessage(err);
        if (msg.startsWith("regex parse error")) {
          return { content: `Invalid regex pattern: ${msg}`, isError: true };
        }
        log.warn("text_search failed", { pattern, error: msg });
        return { content: `Search error: ${msg}`, isError: true };
      }
    },
  };
}

export const textSearchDefinition = createTextSearchDefinition();

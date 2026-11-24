import { existsSync } from "node:fs";
import { join } from "node:path";

import { errorMessage } from "../../../../infra/error-message.js";
import { displayRelativePath } from "../../../../infra/tools/detail-helpers.js";
import { Log } from "../../../../infra/diagnostics/log.js";
import { executePathBatch, missingPathHint, prepareReadOnlyPathInput, resolveToolPath, widenToExistingParent } from "../files/tool-paths.js";
import { checkNumericRange } from "../input/numeric-input.js";
import { type ListFilesResult, listFiles, SearchStoppedError } from "../files/ripgrep.js";
import { PRUNED_DIR_GLOBS, prunedDirectoriesNote } from "./search-paths.js";
import { SEARCH_CPU_LIMIT_SECONDS, SEARCH_WALL_BACKSTOP_SECONDS, searchStoppedMessage } from "./search-rules.js";

import type { DispatchedToolContext, RuntimeTool, RuntimeToolInput, ToolResult } from "../types.js";

const log = Log.create({ service: "agent-list" });

type IncludeFilter = "all" | "files" | "directories";
const INCLUDE_VALUES: ReadonlySet<string> = new Set<IncludeFilter>(["all", "files", "directories"]);

function isIncludeFilter(value: string): value is IncludeFilter {
  return INCLUDE_VALUES.has(value);
}

function parseInclude(value: unknown): { include?: IncludeFilter } | { error: string } {
  if (value === undefined) return {};
  if (typeof value === "string" && isIncludeFilter(value)) return { include: value };
  return { error: "include must be one of: all, files, directories." };
}

function parseSort(value: unknown): { sort?: "name" | "mtime" } | { error: string } {
  if (value === undefined) return {};
  if (value === "name") return { sort: "name" };
  if (value === "mtime") return { sort: "mtime" };
  return { error: "sort must be one of: name, mtime." };
}

/** The native walk names entries relative to its root; the model reads and
 *  passes paths relative to the execution directory, so each entry is shown
 *  that way, keeping a directory's trailing slash. */
function formatListResult(result: ListFilesResult, root: string, executionCwd: string): ToolResult {
  const shown = result.entries.map((entry) => `${displayRelativePath(join(root, entry), executionCwd)}${entry.endsWith("/") ? "/" : ""}`);
  const lines = shown.length > 0 ? shown : ["No paths found."];
  if (result.traversalIssues > 0) lines.push("", `[${result.traversalIssues} linked directory branch(es) could not be traversed; other results are unaffected.]`);
  if (result.entryLimitReached) lines.push("", "[The filesystem walk reached its entry limit. Results are an incomplete prefix; narrow the path.]");
  const pruned = prunedDirectoriesNote(result.prunedDirectories ?? [], (directory) => displayRelativePath(join(root, directory), executionCwd));
  if (pruned) lines.push("", `[${pruned}]`);
  if (result.truncated) {
    lines.push(
      "",
      `[Results truncated. Continue with offset=${result.nextOffset}, limit=${result.limit}, or narrow path/pattern before continuing.]`,
    );
  }
  return { content: lines.join("\n"), outcome: "ok" };
}

const LIST_INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Directory to list, relative or absolute inside the workspace (default: '.')" },
    pattern: { type: "string", description: "Glob relative to path, such as '**/*.ts'" },
    depth: { type: "number", description: "Max depth, 1-12 (default: 1, or 8 with pattern)" },
    include: { type: "string", enum: ["all", "files", "directories"] },
    sort: { type: "string", enum: ["name", "mtime"], description: "name: directories first, then alphabetical (default). mtime: newest first, like `ls -t`" },
    hidden: { type: "boolean", description: "Include dot-segment paths (default: true)" },
    respect_gitignore: { type: "boolean", description: "Hide every ignored path (default: false)" },
    limit: { type: "number", description: "Max paths, 1-1000 (default: 200)" },
    offset: { type: "number", description: "Paths to skip, for paging (default: 0)" },
  },
} as const;

export const listDefinition: RuntimeTool = {
  name: "list",
  action: "list",
  description: "List file and directory paths, relative to cwd; directories end in '/'. Without pattern, lists one level. With pattern, finds matching paths recursively; narrow path and pattern first. Artifact and ignored directories are listed but not entered unless path names one. Use search for file contents.",
  inputSchema: LIST_INPUT_SCHEMA,
  inputValidationSchema: {
    ...LIST_INPUT_SCHEMA,
    properties: { ...LIST_INPUT_SCHEMA.properties, path: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] } },
  },
  isConcurrencySafe: true,
  async prepareAdmission(input, context, signal) {
    const kinds = typeof input.include === "string" ? input.include.split(/[,\s]+/).filter(Boolean) : [];
    const includeAll = kinds.includes("files") && kinds.includes("directories") && kinds.every(kind => kind === "files" || kind === "directories");
    const normalized = includeAll ? { ...input, include: "all" } : input;
    const healed = await prepareReadOnlyPathInput(normalized, context, "directory", "listed", undefined, signal);
    const prepared = healed.repair || healed.ambiguous ? healed : widenToExistingParent(normalized, context, "listed");
    return includeAll ? { ...prepared, repair: {
      input: prepared.repair?.input ?? normalized,
      notice: [`Note: include '${input.include}' was read as 'all'.`, prepared.repair?.notice].filter(Boolean).join("\n"),
    } } : prepared;
  },
  async execute(input: RuntimeToolInput, context: DispatchedToolContext): Promise<ToolResult> {
    if (Array.isArray(input.path) && input.path.every((path): path is string => typeof path === "string")) {
      return executePathBatch(input.path, (path) => listDefinition.execute({ ...input, path }, context));
    }
    const parsedInclude = parseInclude(input.include);
    if ("error" in parsedInclude) return { content: parsedInclude.error, outcome: "error" };
    const parsedSort = parseSort(input.sort);
    if ("error" in parsedSort) return { content: parsedSort.error, outcome: "error" };

    // Reject only the silent-nonsense lower bounds (a non-positive depth/limit
    // or negative offset). The native addon's upper clamp (depth->12, limit->1000)
    // is a deliberate, documented cap that preserves "as many/deep as allowed",
    // so it stays.
    const depthCheck = checkNumericRange(input.depth, "depth", { min: 1 });
    if ("error" in depthCheck) return { content: depthCheck.error, outcome: "error" };
    const limitCheck = checkNumericRange(input.limit, "limit", { min: 1 });
    if ("error" in limitCheck) return { content: limitCheck.error, outcome: "error" };
    const offsetCheck = checkNumericRange(input.offset, "offset", { min: 0 });
    if ("error" in offsetCheck) return { content: offsetCheck.error, outcome: "error" };

    const resolvedPath = typeof input.path === "string"
      ? resolveToolPath(context.executionCwd, input.path)
      : context.executionCwd;
    if (!existsSync(resolvedPath)) {
      return { content: `list failed: path '${String(input.path)}' does not exist.${await missingPathHint(context, resolvedPath, "directory")}`, outcome: "error" };
    }

    try {
      const result = await listFiles({
        path: resolvedPath,
        pattern: typeof input.pattern === "string" ? input.pattern : undefined,
        depth: depthCheck.value,
        include: parsedInclude.include,
        sort: parsedSort.sort,
        hidden: typeof input.hidden === "boolean" ? input.hidden : undefined,
        gitignore: input.respect_gitignore === true,
        excludeGlobs: PRUNED_DIR_GLOBS,
        limit: limitCheck.value,
        offset: offsetCheck.value,
        protectedTraversalRoots: context.protectedTraversalRoots,
        cpuLimitMs: SEARCH_CPU_LIMIT_SECONDS * 1000,
        timeoutMs: SEARCH_WALL_BACKSTOP_SECONDS * 1000,
      });
      return formatListResult(result, resolvedPath, context.executionCwd);
    } catch (err) {
      if (err instanceof SearchStoppedError) return { content: searchStoppedMessage("list", err.stop), outcome: "error" };
      const msg = errorMessage(err);
      log.warn("list failed", { error: msg });
      return { content: `list failed: ${msg}. Use list with a narrower path/pattern${context.capabilities?.("read") === false ? "" : ", or use read when you already know the file path"}.`, outcome: "error" };
    }
  },
};

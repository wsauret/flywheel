/**
 * What one search covers: the exclusion globs of the pruned directories, the
 * footer that names the ones a walk skipped, and the admission repairs that
 * turn a `path` input the model meant but the filesystem does not hold into a
 * search root that exists.
 */

import { existsSync } from "node:fs";
import { dirname, relative, sep } from "node:path";

import {
  existingParentInScope,
  existingPathList,
  hasKind,
  healMissingPathInput,
  inputPath,
  type PathInputRepair,
  resolveToolPath,
  sessionPathInput,
  widenToExistingParent,
  within,
} from "./tool-paths.js";
import { prunedDirectoryOnPath } from "./ripgrep.js";
import { PRUNED_DIR_NAMES } from "./search-rules.js";
import type { RuntimeToolInput, ToolAdmissionContext } from "./types.js";

// The native walker matches these against root-relative paths, so pointing
// `path` at a single file or at/inside a pruned tree bypasses the exclusion.
export const PRUNED_DIR_GLOBS = PRUNED_DIR_NAMES.map((dir) => `**/${dir}`);

const PRUNED_EXAMPLES_SHOWN = 5;

/** The footer line that names the directories a walk pruned without
 *  entering, so the model can name one in `path` when it needs its contents.
 *  `display` renders one directory for the model. Undefined when none. */
export function prunedDirectoriesNote(directories: readonly string[], display: (directory: string) => string): string | undefined {
  if (directories.length === 0) return undefined;
  const shown = directories.slice(0, PRUNED_EXAMPLES_SHOWN).map((directory) => `${display(directory)}/`).join(", ");
  const more = directories.length > PRUNED_EXAMPLES_SHOWN ? ` and ${directories.length - PRUNED_EXAMPLES_SHOWN} more` : "";
  return `Did not enter ${directories.length} artifact or ignored director${directories.length === 1 ? "y" : "ies"}: ${shown}${more}; name one in 'path' to look inside it.`;
}

// A wildcard or a brace alternation marks a path segment as a glob. A lone
// bracket does not: `app/[id]/page.tsx` is a common literal directory name.
const GLOB_SEGMENT = /[*?]|\{[^}]*,[^}]*\}/;
const GLOB_SYNTAX = /[*?[\]{}]/;
const PATH_SEPARATOR = process.platform === "win32" ? /[\\/]/ : /\//;

/** The glob that selects `glob` below the root-relative directory `directory`, with the native layer's meaning: a glob without a slash matches at any depth. */
function globBelow(directory: string, glob: string | undefined): string {
  if (glob === undefined) return `${directory}/**`;
  return glob.includes("/") ? `${directory}/${glob}` : `${directory}/**/${glob}`;
}

function commonDirectory(paths: readonly string[]): string {
  const [first = "", ...rest] = paths;
  let common = dirname(first);
  while (!rest.every((path) => within(path, common)) && dirname(common) !== common) common = dirname(common);
  return common;
}

/**
 * `src tests` or `src/a.ts, tests` (paths separated by spaces or commas, each
 * existing inside the execution directory) becomes one search of their common
 * directory, with a brace glob that selects only the named paths. The tool
 * description already directs a several-root search to a glob filter.
 * Returns undefined when the input is not several existing paths. Returns no
 * repair, so the tool refuses the call, when a part lies outside the execution
 * directory or in a protected root, or when a walk of the common root would
 * prune a directory on the way to a part (an artifact directory or one that
 * the ignore rules exclude): a named part is searched or the call is refused,
 * never skipped.
 */
function severalPathsInput(input: Readonly<RuntimeToolInput>, context: ToolAdmissionContext, rawPath: string): PathInputRepair | undefined {
  if (input.glob !== undefined && typeof input.glob !== "string") return undefined;
  const parts = existingPathList(rawPath, context, "any");
  if (parts === undefined) return undefined;
  if (parts.some((part) => GLOB_SYNTAX.test(part))) return {};
  const resolved = parts.map((part) => resolveToolPath(context.executionCwd, part));
  const roots = [...new Set(resolved)].filter((path, _, all) => !all.some((other) => other !== path && within(path, other)));
  const shown = roots.map((path) => `'${inputPath(context.executionCwd, path)}'`).join(", ");
  const notice = `[Path '${rawPath}' names several paths; searched ${shown}.]`;
  const [only] = roots;
  if (only !== undefined && roots.length === 1) return { repair: { input: { ...input, path: inputPath(context.executionCwd, only) }, notice } };

  const root = commonDirectory(roots);
  if (roots.some((path) => prunedDirectoryOnPath({ root, path, excludeGlobs: PRUNED_DIR_GLOBS }) !== undefined)) return {};
  const relativeRoots = roots.map((path) => relative(root, path).split(sep));
  const userGlob = typeof input.glob === "string" ? input.glob : undefined;
  const selectors = roots.map((path, index) => {
    // Literal commas must not become separators of the enclosing brace glob.
    const rel = (relativeRoots[index]?.join("/") ?? "").replaceAll(",", "[,]");
    return hasKind(path, "directory") ? globBelow(rel, userGlob) : rel;
  });
  return { repair: { input: { ...input, path: inputPath(context.executionCwd, root), glob: `{${selectors.join(",")}}` }, notice } };
}

/**
 * `src/**\/*.test.ts` becomes path `src` with glob `**\/*.test.ts`: the path
 * keeps the segments before the first glob segment, and the glob keeps the
 * rest. A missing base widens to its nearest existing parent with the missing
 * segments moved into the glob. An additional glob must have an exact
 * intersection; a conflict refuses instead of widening the search.
 */
function globInPathInput(input: Readonly<RuntimeToolInput>, context: ToolAdmissionContext, rawPath: string): PathInputRepair | undefined {
  const segments = rawPath.split(PATH_SEPARATOR);
  const first = segments.findIndex((segment) => GLOB_SEGMENT.test(segment));
  if (first === -1) return undefined;
  const base = resolveToolPath(context.executionCwd, segments.slice(0, first).join("/") || ".");
  let root = base;
  let glob = segments.slice(first).join("/");
  if (!hasKind(base, "directory")) {
    if (existsSync(base)) throw new Error(`Search path '${rawPath}' contains a glob below a file. Supply a directory path and a glob filter.`);
    const parent = existingParentInScope(context, base);
    if (parent === undefined) throw new Error(`Search path '${rawPath}' contains a glob but has no admissible existing directory. Supply an existing directory path and a glob filter.`);
    root = parent;
    glob = `${relative(parent, base).split(sep).join("/")}/${glob}`;
  }
  if (input.glob !== undefined && input.glob !== glob) {
    const filter = input.glob;
    const directory = glob.slice(0, glob.lastIndexOf("/") + 1);
    const name = glob.slice(directory.length);
    if (typeof filter === "string" && filter.length > 0 && filter === filter.trim()
      && !/[/\\]/.test(filter) && !filter.startsWith("**") && (glob === "**" || glob.endsWith("/**"))) {
      glob = `${glob}/${filter}`;
    } else if (typeof filter === "string" && /^[^.*?[\]{}!/\\]+\*$/.test(name) && /^\*\.[^*?[\]{}!/\\]+$/.test(filter)) {
      // A dot-free prefix and a dotted suffix cannot overlap.
      glob = `${directory}${name}${filter.slice(1)}`;
    } else throw new Error(`Search path glob '${glob}' and glob '${String(filter)}' cannot combine exactly. Supply one glob that expresses both filters, or use separate calls.`);
  }
  const path = inputPath(context.executionCwd, root);
  return { repair: { input: { ...input, path, glob }, notice: `[Path '${rawPath}' contains a glob; searched '${path}' with glob '${glob}' instead.]` } };
}

/**
 * Admission preparation for the search `path` input. An existing path is
 * left alone. A missing one is read as several paths or a path with a glob,
 * then healed when exactly one candidate exists, and last widened
 * to its nearest existing parent. Every repair leads the result with a notice,
 * so the model knows which root the search covered.
 */
export async function prepareSearchPathInput(input: Readonly<RuntimeToolInput>, context: ToolAdmissionContext): Promise<PathInputRepair> {
  const rawPath = input.path;
  if (typeof rawPath !== "string") return {};
  if (rawPath.startsWith("~")) {
    const home = sessionPathInput(input, context, "any");
    const expanded = home.repair?.input.path;
    if (typeof expanded !== "string" || existsSync(resolveToolPath(context.executionCwd, expanded))) return home;
    const glob = globInPathInput(home.repair?.input ?? input, context, expanded);
    return glob?.repair ? { ...glob, repair: {
      input: glob.repair.input,
      notice: [home.repair?.notice, glob.repair.notice].filter(Boolean).join("\n"),
    } } : home;
  }
  if (existsSync(resolveToolPath(context.executionCwd, rawPath))) return {};
  // A list ending in a filename must not heal to that basename alone.
  const several = severalPathsInput(input, context, rawPath);
  if (several) return several;
  const glob = globInPathInput(input, context, rawPath);
  if (glob) return glob;
  const healed = await healMissingPathInput(input, context, "any");
  if (healed.repair || healed.ambiguous) return healed;
  if (GLOB_SYNTAX.test(rawPath)) throw new Error(`Search path '${rawPath}' contains glob characters. Supply an existing directory path and a separate glob filter; the search was not widened.`);
  return widenToExistingParent(input, context, "searched");
}

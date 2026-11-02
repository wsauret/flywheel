import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";

import { listFiles } from "./ripgrep.js";
import { canonicalMutationPath } from "../../../infra/file-mutation-queue.js";
import type { RuntimeToolInput, ToolAdmissionContext, ToolResult } from "./types.js";

/**
 * Normalize a tool path argument. Absolute paths are passed through; relative
 * paths resolve against the agent's cwd.
 *
 * No containment check: agent tools run with the user's process permissions,
 * and bash can trivially fetch anything reachable on the filesystem. A path-
 * string sandbox here would be theater, not a boundary. Real isolation must
 * happen at process spawn (sandbox-exec, bwrap, container) if ever needed.
 */

// Shell metacharacters that terminal drag-and-drop backslash-escapes. Deliberately
// excludes alphanumerics so Windows path separators (\Users) are never collapsed.
const SHELL_ESCAPE_RE = /\\([ !"#$&'()*;<>?[\]^`{|}~])/g;
const SPACE_SEPARATOR_RE = /\p{Zs}/gu;

export function unescapeShellPath(rawPath: string): string {
  return rawPath.replace(SHELL_ESCAPE_RE, "$1");
}

function foldSpaceSeparators(value: string): string {
  return value.replace(SPACE_SEPARATOR_RE, " ");
}

/** Recover an existing path only when every missing segment has one visually
 * equivalent Unicode-space spelling. Exact segments always retain priority. */
function resolveUniqueSpaceEquivalent(path: string): string | undefined {
  const root = parse(path).root;
  let current = root;
  const remainder = path.slice(root.length);
  const segments = remainder.length === 0 ? [] : remainder.split(sep);

  for (const segment of segments) {
    const exact = join(current, segment);
    if (existsSync(exact)) {
      current = exact;
      continue;
    }

    let matches: string[];
    try {
      const folded = foldSpaceSeparators(segment);
      matches = readdirSync(current).filter((entry) => foldSpaceSeparators(entry) === folded);
    } catch {
      return undefined;
    }
    if (matches.length !== 1) return undefined;
    current = join(current, matches[0] ?? "");
  }

  return existsSync(current) ? current : undefined;
}

/** The home-directory reading of a leading `~`. A path that exists as written under `cwd`, such as a
 *  project folder named `~`, is already a valid value and keeps its literal meaning. The literal
 *  first segment must exist itself: `resolve` folds `~/..` away lexically, while the file system
 *  refuses to walk through a missing `~`. */
function homePath(cwd: string, rawPath: string): string | undefined {
  if (!rawPath.startsWith("~")) return undefined;
  const [literalFirst = rawPath] = rawPath.split(process.platform === "win32" ? /[\\/]/ : "/");
  if (existsSync(join(cwd, literalFirst)) && existsSync(resolve(cwd, rawPath))) return undefined;
  if (rawPath === "~") return homedir();
  if (rawPath.startsWith("~/") || (process.platform === "win32" && rawPath.startsWith("~\\"))) return join(homedir(), rawPath.slice(2));
  return undefined;
}

export function resolveToolPath(cwd: string, rawPath: string): string {
  const expanded = homePath(cwd, rawPath) ?? rawPath;
  const resolved = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  if (existsSync(resolved)) return resolved;
  const equivalent = resolveUniqueSpaceEquivalent(resolved);
  if (equivalent !== undefined) return equivalent;

  // Defensive: dragging a file into the terminal inserts a shell-escaped path
  // (e.g. "Screenshot\ 2026.png"). The real filename has no backslashes, so the
  // literal read fails. If an unescaped variant exists on disk, prefer it. Gated
  // on existence so legitimately backslashed filenames are left untouched.
  const unescaped = unescapeShellPath(expanded);
  if (unescaped === expanded) return resolved;
  const resolvedUnescaped = isAbsolute(unescaped) ? resolve(unescaped) : resolve(cwd, unescaped);
  if (existsSync(resolvedUnescaped)) return resolvedUnescaped;
  return resolveUniqueSpaceEquivalent(resolvedUnescaped) ?? resolved;
}

/** What a read-side tool needs to exist at a path it was given. */
export type PathKind = "file" | "directory" | "any";

type MissingPathRecovery =
  | { readonly kind: "healed"; readonly path: string }
  | { readonly kind: "missing"; readonly suggestions: readonly string[]; readonly ambiguous?: boolean };

const SUGGESTION_LIMIT = 5;
const LOOKUP_DEPTH = 12;
const LOOKUP_ENTRY_LIMIT = 1000;
const LOOKUP_TIMEOUT_MS = 2_000;
// Words shorter than this ("src", "ts", "v2") match too many unrelated names.
const MIN_NAME_WORD_LENGTH = 4;

interface Walk {
  readonly entries: readonly string[];
  /** False when the walk stopped early, so the entries prove no uniqueness. */
  readonly complete: boolean;
}

async function walk(scope: ToolAdmissionContext, options: { path: string; pattern?: string; include?: "directories"; depth?: number }, timeoutMs = LOOKUP_TIMEOUT_MS): Promise<Walk> {
  try {
    const result = await listFiles({
      ...options,
      gitignore: true,
      hidden: false,
      limit: LOOKUP_ENTRY_LIMIT,
      timeoutMs,
      protectedTraversalRoots: scope.protectedTraversalRoots,
    });
    return { entries: result.entries, complete: !result.truncated && !result.entryLimitReached && result.traversalIssues === 0 };
  } catch {
    // The lookup only improves an error the caller already has; a walk that
    // times out or cannot load the native addon leaves that error unchanged.
    return { entries: [], complete: false };
  }
}

export function hasKind(path: string, kind: PathKind): boolean {
  try {
    const stat = statSync(path);
    return kind === "any" || (kind === "file" ? stat.isFile() : stat.isDirectory());
  } catch {
    return false;
  }
}

export function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/**
 * Whether an existing path may be offered to the model or substituted for its
 * input. The walker follows symlinks, so a path below the execution directory
 * can lead outside it.
 */
function admissible(scope: ToolAdmissionContext, path: string): boolean {
  const real = realpathSync(path);
  return within(real, realpathSync(scope.executionCwd)) && !(scope.protectedTraversalRoots ?? []).some((root) => within(real, root));
}

/** Find exact basename matches below `directory`, without treating metacharacters as selectors. */
async function findLiteral(scope: ToolAdmissionContext, directory: string, name: string): Promise<Walk> {
  // The native layer rewrites escaped glob syntax (`[{]` breaks brace
  // balancing), so metacharacters match any character and only exact hits stay.
  const glob = name.replace(/[*?[\]{}!]/g, "?");
  const entries: string[] = [];
  const pending = [directory];
  const deadline = Date.now() + LOOKUP_TIMEOUT_MS;
  const frontierPattern = Array.from({ length: LOOKUP_DEPTH }, () => "*").join("/");
  for (let index = 0; index < pending.length; index++) {
    // SAFETY: this loop visits only indices below the array's current length.
    const root = pending[index]!;
    const remaining = deadline - Date.now();
    if (remaining <= 0 || pending.length > LOOKUP_ENTRY_LIMIT) return { entries, complete: false };
    // The native walk reports completion at its depth cap. Continue each
    // frontier under the same lookup budget to prove basename uniqueness.
    const [found, frontier] = await Promise.all([
      walk(scope, { path: root, pattern: `**/${glob}`, depth: LOOKUP_DEPTH }, remaining),
      walk(scope, { path: root, include: "directories", pattern: frontierPattern, depth: LOOKUP_DEPTH }, remaining),
    ]);
    entries.push(...found.entries
      .map((entry) => entry.replace(/\/$/, ""))
      .filter((entry) => entry === name || entry.endsWith(`/${name}`))
      .map((entry) => join(root, entry)));
    if (!found.complete || !frontier.complete || entries.length > LOOKUP_ENTRY_LIMIT) return { entries, complete: false };
    pending.push(...frontier.entries.map((entry) => join(root, entry)).filter((path) => admissible(scope, path)));
  }
  return { entries, complete: true };
}

function nearestExistingDirectory(path: string, stop: string): string {
  let current = path;
  while (current !== stop && !hasKind(current, "directory")) current = dirname(current);
  return current;
}

function nameWords(name: string): ReadonlySet<string> {
  const stem = name.replace(/\/$/, "").replace(/\.[^.]*$/, "");
  return new Set(stem.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).map((word) => word.toLowerCase()).filter((word) => word.length >= MIN_NAME_WORD_LENGTH));
}

/** The cwd-relative POSIX spelling of `path` that a repaired input carries; "." for the execution directory itself. */
export function inputPath(cwd: string, path: string): string {
  return relative(cwd, path).split(sep).join("/") || ".";
}

function displayPath(cwd: string, path: string): string {
  const shown = relative(cwd, path).split(sep).join("/");
  return hasKind(path, "directory") ? `${shown}/` : shown;
}

/**
 * Look for the path a read-side tool (read, list, search) meant when
 * `resolvedPath` does not exist. Only paths inside the execution directory are
 * considered.
 *
 * Every candidate comes from a gitignore-aware walk that skips hidden and
 * ignored paths and stops at fixed time and entry budgets:
 * - same name: the requested basename anywhere below the execution directory;
 * - same stem: the requested name with another extension in its own directory.
 *
 * Candidates that resolve outside the execution directory or inside a
 * protected root are dropped. Returns `healed` only when exactly one existing
 * path of the wanted kind remains and its lookup completed, including any
 * deeper directory frontiers that could hold a competing basename.
 * Otherwise returns
 * `missing` with up to five display paths: the requested name with another
 * extension in the requested directory, the candidates, then children of the
 * nearest existing parent whose names share a word with the requested name.
 *
 * A path outside the execution directory but inside its parent is never
 * healed: it is offered, rebased under the execution directory, only when
 * that rebased path exists (`/repo/src/a.ts` for `/repo/project/src/a.ts`).
 */
async function recoverMissingPath(scope: ToolAdmissionContext, resolvedPath: string, kind: PathKind, projectCandidate?: string): Promise<MissingPathRecovery> {
  const cwd = scope.executionCwd;
  const requested = relative(cwd, resolvedPath);
  if (requested === "" || requested === ".." || requested.startsWith(`..${sep}`) || isAbsolute(requested)) {
    const rebased = rebasedUnderCwd(cwd, resolvedPath);
    return { kind: "missing", suggestions: rebased !== undefined && hasKind(rebased, kind) && admissible(scope, rebased) ? [displayPath(cwd, rebased)] : [] };
  }

  const parent = nearestExistingDirectory(dirname(resolvedPath), cwd);
  const name = basename(resolvedPath);
  const [sameName, siblings] = await Promise.all([
    findLiteral(scope, cwd, name),
    walk(scope, { path: parent, depth: 1 }),
  ]);

  const otherExtensions = parent === dirname(resolvedPath) ? sameStemSiblings(parent, name) : [];
  // The sibling walk enforces the same ignore rules as basename discovery.
  const allowedSiblings = new Set(siblings.entries.map((entry) => join(parent, entry.replace(/\/$/, ""))));
  const localFits = otherExtensions.filter((path) => allowedSiblings.has(path) && hasKind(path, kind) && admissible(scope, path));
  const fits = [...new Set([...localFits, ...sameName.entries.filter((path) => hasKind(path, kind) && admissible(scope, path)), ...(projectCandidate ? [projectCandidate] : [])])];
  const complete = sameName.complete && siblings.complete;

  const [only] = fits;
  if (only !== undefined && fits.length === 1 && complete) return { kind: "healed", path: only };

  const words = nameWords(name);
  const similar = siblings.entries
    .map((entry) => ({ path: join(parent, entry), shared: [...nameWords(entry)].filter((word) => words.has(word)).length }))
    .filter((sibling) => sibling.shared > 0)
    .sort((a, b) => b.shared - a.shared)
    .map((sibling) => sibling.path);
  return { kind: "missing", ambiguous: fits.length > 1 || !complete, suggestions: [...new Set([...fits, ...similar.filter((path) => admissible(scope, path))])].slice(0, SUGGESTION_LIMIT).map((path) => displayPath(cwd, path)) };
}

// An extension a sibling may carry instead of the requested one: none, or one plain extension of up to 32 characters.
const PLAIN_EXTENSION = /^(\.[\p{L}\p{N}_+~#-]{1,32})?$/u;

/** The entries of `directory` that are `name` with another extension or none: `app.tsx` and `app` for `app.ts`. */
function sameStemSiblings(directory: string, name: string): string[] {
  const stem = basename(name, extname(name));
  try {
    return readdirSync(directory)
      .filter((entry) => entry !== name && basename(entry, extname(entry)) === stem && PLAIN_EXTENSION.test(extname(entry).normalize("NFC")))
      .map((entry) => join(directory, entry));
  } catch {
    return [];
  }
}

/** `resolvedPath`, which lies inside the parent of `cwd` but outside `cwd`, rebased from that parent onto `cwd`. */
function rebasedUnderCwd(cwd: string, resolvedPath: string): string | undefined {
  const fromParent = relative(dirname(cwd), resolvedPath);
  if (fromParent === "" || fromParent === ".." || fromParent.startsWith(`..${sep}`) || isAbsolute(fromParent)) return undefined;
  return join(cwd, fromParent);
}

/** The line a read-side tool appends to its not-found error for `resolvedPath`, or "" when nothing is close. */
export async function missingPathHint(context: ToolAdmissionContext, resolvedPath: string, kind: PathKind): Promise<string> {
  const recovery = await recoverMissingPath(context, resolvedPath, kind);
  const suggestions = recovery.kind === "healed" ? [displayPath(context.executionCwd, recovery.path)] : recovery.suggestions;
  if (suggestions.length === 0) return "";
  return suggestions.length === 1 ? `\nDid you mean ${suggestions[0]}?` : `\nDid you mean one of these existing paths? ${suggestions.join(", ")}`;
}

/** An input repair: the replacement input and the notice that leads the tool result. */
export interface PathInputRepair {
  readonly repair?: { readonly input: RuntimeToolInput; readonly notice: string };
  /** No unique target was established, so a search must not widen instead. */
  readonly ambiguous?: boolean;
  readonly reservedPaths?: readonly string[];
}

type PathSplit = (rawPath: string) => { readonly path: string; readonly suffix: string; readonly valid?: boolean };
const wholePath: PathSplit = (path) => ({ path, suffix: "" });

function projectPathCandidate(context: ToolAdmissionContext, requested: string, kind: PathKind, literal = false): string | undefined {
  if (context.projectRoot === undefined || isAbsolute(requested) || requested.startsWith("~")) return undefined;
  const root = resolve(context.projectRoot);
  const candidate = literal ? resolve(root, requested) : resolveToolPath(root, requested);
  if (within(candidate, root) && hasKind(candidate, kind)
    && within(realpathSync(candidate), realpathSync(root))
    && !(context.protectedTraversalRoots ?? []).some((protectedRoot) => within(realpathSync(candidate), protectedRoot))) return candidate;
  return undefined;
}

/**
 * Read an existing path list without choosing between valid separator
 * interpretations. An exact existing path, including a valid selector, wins.
 * Lookup work is bounded; uncertainty refuses rather than selecting a prefix.
 */
export function existingPathList(raw: string, context: ToolAdmissionContext, kind: PathKind, split: PathSplit = wholePath): readonly string[] | undefined {
  const exact = split(raw);
  if (exact.valid !== false && hasKind(resolveToolPath(context.executionCwd, exact.path), kind)) return undefined;
  if (raw.startsWith("~")) return undefined;
  const boundaries = [...raw.matchAll(/[,\s]/g)].map((match) => match.index);
  const tooMany = () => new Error(`Path '${raw}' has too many possible separators. Send each path in a separate call.`);
  if (boundaries.length > LOOKUP_ENTRY_LIMIT) throw tooMany();
  let probes = 0;
  const memo = new Map<number, readonly (readonly string[])[]>();
  const visit = (start: number): readonly (readonly string[])[] => {
    if (start === raw.length) return [[]];
    const cached = memo.get(start);
    if (cached) return cached;
    const alternatives = new Map<string, readonly string[]>();
    const add = (paths: readonly string[]) => { alternatives.set(JSON.stringify(paths), paths); };
    for (const end of [...boundaries.filter((boundary) => boundary >= start), raw.length]) {
      const part = raw.slice(start, end).trim();
      if (part.length === 0) {
        if (end < raw.length) for (const paths of visit(end + 1)) add(paths);
      } else {
        if (++probes > LOOKUP_ENTRY_LIMIT) throw tooMany();
        const parsed = split(part);
        const path = resolveToolPath(context.executionCwd, parsed.path);
        if (parsed.valid === false || !hasKind(path, kind) || !admissible(context, path)) continue;
        if (end === raw.length) add([part]);
        else for (const paths of visit(end + 1)) add([part, ...paths]);
      }
      if (alternatives.size > 1) break;
    }
    const result = [...alternatives.values()];
    memo.set(start, result);
    return result;
  };
  const alternatives = visit(0).filter((parts) => parts.length > 1);
  if (alternatives.length > 1) throw new Error(`Path '${raw}' can name different path lists: ${alternatives.map((parts) => parts.map((path) => `'${path}'`).join(", ")).join(" or ")}. Send each path in a separate call.`);
  const parts = alternatives[0];
  if (parts !== undefined && exact.valid !== false) {
    // Only literal whole paths compete with existing batch members. Basename
    // discovery drops written roots, so it cannot reinterpret a proven list.
    const whole = [...new Set([
      sessionPathFor(context, exact.path, kind),
      projectPathCandidate(context, exact.path, kind, true),
    ].filter((path): path is string => path !== undefined))];
    if (whole.length > 0) throw new Error(`Path '${raw}' can name the existing path ${whole.map((path) => `'${path}${exact.suffix}'`).join(" or ")} or the path list ${parts.map((path) => `'${path}'`).join(", ")}. Send one explicit path or each list member in a separate call.`);
  }
  return parts;
}

/**
 * Normalize read/list batches before admission. An exact path wins over its
 * possible separators. Every batch member must already exist inside the usual
 * healing scope; canonical targets let downstream gates inspect every member.
 */
export async function prepareReadOnlyPathInput(
  input: Readonly<RuntimeToolInput>,
  context: ToolAdmissionContext,
  kind: PathKind,
  action: "read" | "listed",
  split: PathSplit = wholePath,
  signal?: AbortSignal,
): Promise<PathInputRepair> {
  signal?.throwIfAborted();
  if (typeof input.path !== "string" && !Array.isArray(input.path)) return {};
  let paths: string[];
  let multiple = false;
  if (Array.isArray(input.path)) {
    if (!input.path.every((path): path is string => typeof path === "string")) return {};
    paths = input.path;
    multiple = true;
  } else {
    const raw = input.path;
    const parts = existingPathList(raw, context, kind, split);
    multiple = parts !== undefined;
    paths = parts ? [...parts] : [raw];
  }
  const notices: string[] = [];
  if (multiple && typeof input.path === "string") notices.push(`[Path '${input.path}' names several paths; ${action} each in order.]`);
  let ambiguous = false;
  const prepared: string[] = [];
  for (const path of paths) {
    signal?.throwIfAborted();
    const healed = await healMissingPathInput({ ...input, path }, context, kind, split);
    signal?.throwIfAborted();
    ambiguous ||= healed.ambiguous === true;
    const finalPath = healed.repair?.input.path;
    prepared.push(typeof finalPath === "string" ? finalPath : path);
    if (healed.repair) notices.push(healed.repair.notice);
  }
  return {
    ...(ambiguous ? { ambiguous: true } : {}),
    reservedPaths: prepared.map((path) => canonicalMutationPath(resolveToolPath(context.executionCwd, split(path).path))),
    ...(notices.length > 0 ? { repair: { input: { ...input, path: multiple ? prepared : prepared[0] }, notice: notices.join("\n") } } : {}),
  };
}

/** Run batch members in order, retaining text headers and image parts. */
export async function executePathBatch(paths: readonly string[], execute: (path: string) => Promise<ToolResult>): Promise<ToolResult> {
  const results: ToolResult[] = [];
  for (const path of paths) results.push(await execute(path));
  const outcome = results.some((result) => result.outcome === "error") ? "error"
    : results.some((result) => result.outcome === "interrupted") ? "interrupted" : "ok";
  if (results.every((result) => typeof result.content === "string")) {
    return { content: results.map((result, index) => `### ${paths[index]}\n${result.content}`).join("\n\n"), outcome };
  }
  return {
    content: results.flatMap((result, index) => [
      { type: "text" as const, text: `### ${paths[index]}` },
      ...(typeof result.content === "string" ? [{ type: "text" as const, text: result.content }] : result.content),
    ]),
    outcome,
  };
}

/** What a path tool needs at a session path: an existing entry of a kind, or a place for a new file. */
type SessionPathTarget = PathKind | "new-file";

/**
 * The session-directory path that a relative tool path names in Flywheel's
 * own vocabulary, or undefined. Flywheel names session files relative to the
 * session directory (`scratch/workflows/<slug>.workflow.yaml`), while a tool
 * resolves a relative path from the execution directory, so the model's read
 * of a path Flywheel showed it would miss.
 *
 * Only a path whose first segment is the scratch directory's name qualifies,
 * and the execution directory always wins: an existing entry there is never
 * redirected. A `new-file` target redirects only when the execution directory
 * has no entry with that first segment at all, so a project's own `scratch`
 * folder keeps every new file. Another target redirects only when the session
 * path exists with that kind.
 */
function sessionPathFor(scope: ToolAdmissionContext, rawPath: string, target: SessionPathTarget): string | undefined {
  const { executionCwd, scratchDir } = scope;
  if (scratchDir === undefined || isAbsolute(rawPath) || rawPath.startsWith("~")) return undefined;
  const normalized = normalize(rawPath);
  const [first] = normalized.split(sep);
  if (first !== basename(scratchDir) || existsSync(resolveToolPath(executionCwd, rawPath))) return undefined;
  const sessionDir = dirname(scratchDir);
  const sessionPath = join(sessionDir, normalized);
  if (target === "new-file") return existsSync(join(executionCwd, first)) || !hasKind(sessionDir, "directory") ? undefined : sessionPath;
  return hasKind(sessionPath, target) ? sessionPath : undefined;
}

/**
 * Admission preparation for a path tool: swaps a session-relative `path`
 * input (see `sessionPathFor`) for its absolute session-directory path,
 * keeping any selector suffix `split` separates. Every later resolution of
 * the call, including its reserved paths, then sees that one file.
 */
export function sessionPathInput(
  input: Readonly<RuntimeToolInput>,
  context: ToolAdmissionContext,
  target: SessionPathTarget,
  split: PathSplit = wholePath,
): PathInputRepair {
  if (typeof input.path !== "string") return {};
  const { path: requested, suffix } = split(input.path);
  const expanded = homePath(context.executionCwd, requested);
  if (expanded !== undefined) return { repair: {
    input: { ...input, path: `${expanded}${suffix}` },
    notice: `[Path '${requested}' was expanded to '${expanded}' in the user's home directory.]`,
  } };
  const sessionPath = sessionPathFor(context, requested, target);
  if (sessionPath === undefined) return {};
  return {
    repair: {
      input: { ...input, path: `${sessionPath}${suffix}` },
      notice: `[Path '${requested}' does not exist in the execution directory; using '${sessionPath}' in the session directory instead.]`,
    },
  };
}

/**
 * Admission preparation for a read-side tool whose `path` input must name an
 * existing path of `kind`. A session-relative path resolves first, through
 * `sessionPathInput`. When it does not and `recoverMissingPath` heals it,
 * returns a repair that swaps in the healed cwd-relative path, keeping any
 * selector suffix `split` separates (read's `:5-16`). Returns no repair when
 * the path exists, is absent, or cannot be healed; the tool then reports the
 * miss itself.
 */
export async function healMissingPathInput(
  input: Readonly<RuntimeToolInput>,
  context: ToolAdmissionContext,
  kind: PathKind,
  split: PathSplit = wholePath,
): Promise<PathInputRepair> {
  const session = sessionPathInput(input, context, kind, split);
  if (session.repair || typeof input.path !== "string") return session;
  const { path: requested, suffix } = split(input.path);
  if (requested.startsWith("~")) return {};
  const resolved = resolveToolPath(context.executionCwd, requested);
  if (existsSync(resolved)) return {};
  // A worktree can lack a path that was shown relative to the owning project.
  // This exact-root recovery alone may leave executionCwd; discovery cannot.
  const projectCandidate = projectPathCandidate(context, requested, kind);
  const recovery = await recoverMissingPath(context, resolved, kind, projectCandidate);
  if (recovery.kind === "missing") {
    if (projectCandidate && recovery.ambiguous) throw new Error(`Cannot resolve path '${requested}' to one existing path. Candidates: ${recovery.suggestions.join(", ")}; project-root candidate '${projectCandidate}'.`);
    return recovery.ambiguous ? { ambiguous: true } : {};
  }
  if (recovery.path === projectCandidate) return { repair: {
    input: { ...input, path: `${projectCandidate}${suffix}` },
    notice: `[Path '${requested}' does not exist in the execution directory; using '${projectCandidate}' under the project root instead.]`,
  } };
  const healed = inputPath(context.executionCwd, recovery.path);
  return {
    repair: {
      input: { ...input, path: `${healed}${suffix}` },
      notice: `[Path '${requested}' does not exist; showing '${healed}' instead.]`,
    },
  };
}

/**
 * The nearest existing directory above `resolvedPath`, a search root that does
 * not exist. Returns undefined when the path lies outside the execution
 * directory, or when the directory leads outside it or into a protected root:
 * those paths keep their not-found error.
 */
export function existingParentInScope(scope: ToolAdmissionContext, resolvedPath: string): string | undefined {
  const requested = relative(scope.executionCwd, resolvedPath);
  if (requested === "" || requested === ".." || requested.startsWith(`..${sep}`) || isAbsolute(requested)) return undefined;
  const parent = nearestExistingDirectory(dirname(resolvedPath), scope.executionCwd);
  return admissible(scope, parent) ? parent : undefined;
}

/**
 * The last admission repair for a search root (search, list) whose `path`
 * input does not exist, applied after healing found nothing: the tool runs on
 * the nearest existing parent inside the execution directory, and the notice
 * names that parent. Without the notice, an empty result would read as "not
 * in the requested path", which the call never proved.
 */
export function widenToExistingParent(input: Readonly<RuntimeToolInput>, context: ToolAdmissionContext, action: "searched" | "listed"): PathInputRepair {
  if (typeof input.path !== "string" || input.path.startsWith("~")) return {};
  const resolved = resolveToolPath(context.executionCwd, input.path);
  if (existsSync(resolved)) return {};
  const parent = existingParentInScope(context, resolved);
  if (parent === undefined) return {};
  const widened = inputPath(context.executionCwd, parent);
  return {
    repair: {
      input: { ...input, path: widened },
      notice: `[Path '${input.path}' does not exist; ${action} its nearest existing parent '${widened}' instead.]`,
    },
  };
}

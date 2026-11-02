/**
 * Native ripgrep search wrapper.
 *
 * The Rust addon's grep() and listFiles() return promises that the addon's
 * own threads settle, so a call never blocks the JS event loop or a thread
 * of the N-API pool. The addon's bounded worker pool is the only admission,
 * and a call waiting for it still settles by its own wall-clock limit. Each
 * call stops at its
 * processor-time limit (`cpuLimitMs`, summed across its threads) and rejects
 * at its wall-clock limit (`timeoutMs`) even when a worker is wedged in a
 * read; both rejections become a `SearchStoppedError`.
 */

import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { sourceCheckout } from "../../../infra/cli-subprocess.js";
import { errorMessage } from "../../../infra/error-message.js";
import { buildPlatformArch, nativeAssetDir } from "../../../infra/native-assets.js";
import { Log } from "../../../infra/log.js";
import type { SearchStop } from "./search-rules.js";

const log = Log.create({ service: "agent-ripgrep" });

interface ContextLine {
  lineNumber: number;
  line: string;
}

interface GrepOptions {
  pattern: string;
  /** PCRE2 supports look-around and backreferences; omitted uses the Rust regex engine. */
  engine?: "default" | "pcre2";
  path: string;
  glob?: string;
  type?: string;
  ignoreCase?: boolean;
  multiline?: boolean;
  hidden?: boolean;
  /** Glob patterns pruned from directory walks (matched against root-relative
   *  paths, e.g. "**\/node_modules"), in addition to the directories that the
   *  repository's ignore rules exclude. Single-file searches and roots inside
   *  a pruned tree bypass this, so explicit targeting always works. */
  excludeGlobs?: readonly string[];
  protectedTraversalRoots?: readonly string[];
  /** Maximum matching lines (content) or files (filesWithMatches); ignored in count mode. */
  maxCount?: number;
  /** Skip matching lines (content) or files (filesWithMatches); ignored in count mode. */
  offset?: number;
  /** Keep the last `maxCount` matches instead of the first (content mode
   *  only); the scan runs to the end of every file so `totalMatches` stays
   *  exact. `offset` is ignored when set. */
  tail?: boolean;
  contextBefore?: number;
  contextAfter?: number;
  context?: number;
  maxColumns?: number;
  /** Processor time the search may spend, summed across its threads. */
  cpuLimitMs: number;
  /** Wall-clock time the search may take, admission included. */
  timeoutMs: number;
  mode?: "content" | "filesWithMatches" | "count";
}

export interface GrepMatch {
  /** Absolute path of the matched file. The native layer reports a directory
   *  search's paths relative to its root; `grep` resolves them, so no caller
   *  can mistake a root-relative path for an execution-directory one. */
  path: string;
  lineNumber: number;
  line: string;
  contextBefore?: ContextLine[];
  contextAfter?: ContextLine[];
  truncated?: boolean;
  matchCount?: number;
}

export interface GrepResult {
  matches: GrepMatch[];
  /** Matching files in filesWithMatches mode, matching lines otherwise.
   * Count and tail totals are exact; capped content totals are a lower bound.
   * Totals exclude searchFailures and files beyond the walk's entry ceiling. */
  totalMatches: number;
  filesWithMatches: number;
  filesSearched: number;
  filesSkipped: number;
  /** Matcher failures excluded from results and totals; paths are absolute. */
  searchFailures?: { path: string; reason: string }[];
  skipReason?: string;
  traversalIssues: number;
  limitReached?: boolean;
  entryLimitReached?: boolean;
  /** Absolute paths of the directories the walk pruned without entering. */
  prunedDirectories?: string[];
}

interface ListFilesOptions {
  path: string;
  pattern?: string;
  depth?: number;
  include?: "all" | "files" | "directories";
  sort?: "name" | "mtime";
  hidden?: boolean;
  /** True leaves out every ignored path. Otherwise the walk does not enter
   *  the directories that the repository's ignore rules exclude, and keeps
   *  ignored files. */
  gitignore?: boolean;
  /** Glob patterns of directories the walk lists but does not enter. */
  excludeGlobs?: readonly string[];
  limit?: number;
  offset?: number;
  protectedTraversalRoots?: readonly string[];
  /** Processor time the listing may spend; omitted sets no limit. */
  cpuLimitMs?: number;
  /** Wall-clock time the listing may take, admission included. */
  timeoutMs: number;
}

export interface ListFilesResult {
  entries: string[];
  truncated: boolean;
  nextOffset: number;
  limit: number;
  traversalIssues: number;
  entryLimitReached: boolean;
  /** Root-relative directories listed but not entered, although the depth
   *  reached their contents. */
  prunedDirectories?: string[];
}

interface PrunedOnPathOptions {
  root: string;
  path: string;
  excludeGlobs?: readonly string[];
}

interface NativeAddon {
  grep(options: GrepOptions, signal?: AbortSignal): Promise<GrepResult>;
  listFiles(options: ListFilesOptions): Promise<ListFilesResult>;
  prunedDirectoryOnPath(options: PrunedOnPathOptions): string | null;
}

// Process-global by nature: the native addon is dlopen'd once per process; cache
// the handle and the load failure (same pattern as the image-resize sharp cache).
let addonCache: NativeAddon | null = null;
let addonLoadError: string | null = null;

/** A native search or listing stopped at one of its limits, or never found a free worker; no partial results exist. */
export class SearchStoppedError extends Error {
  constructor(readonly stop: SearchStop) {
    super(`search stopped: ${stop}`);
    this.name = "SearchStoppedError";
  }
}

// The addon's rejection reasons (crates/ripgrep/src/budget.rs and fs_worker.rs).
const NATIVE_STOPS: ReadonlyMap<string, SearchStop> = new Map([
  ["stopped at the processing time limit", "cpu-limit"],
  ["stopped at the wall time limit", "wall-backstop"],
  ["found no free search worker before the wall time limit", "no-worker"],
]);

function rethrowNative(err: unknown): never {
  const stop = NATIVE_STOPS.get(errorMessage(err));
  throw stop === undefined ? err : new SearchStoppedError(stop);
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function loadAddon(): NativeAddon | null {
  if (addonCache) return addonCache;
  if (addonLoadError) return null;

  const require = createRequire(import.meta.url);
  const addonName = `flywheel-ripgrep.${buildPlatformArch()}.node`;
  const candidates = [
    resolve(nativeAssetDir(), addonName),
    resolve(sourceCheckout(), "crates/ripgrep", addonName),
  ];
  const errors: string[] = [];

  for (const addonPath of candidates) {
    try {
      // SAFETY: external boundary - require() of the dlopen'd .node addon yields an
      // opaque export whose runtime shape (grep/listFiles) is the NativeAddon contract
      // the Rust crate builds against; there is nothing structural to narrow here.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the native addon export is opaque until dlopen completes
      addonCache = require(addonPath) as NativeAddon;
      return addonCache;
    } catch (err) {
      errors.push(`${addonPath}: ${errorMessage(err)}`);
    }
  }

  addonLoadError = errors.join("; ");
  log.warn("ripgrep addon not available, search will be unavailable", {
    error: addonLoadError,
  });
  return null;
}

export async function grep(
  options: GrepOptions,
  signal?: AbortSignal,
): Promise<GrepResult> {
  const addon = loadAddon();
  if (!addon) throw new Error("Ripgrep native addon not available");
  // Bun never fires napi's on_abort for an already-aborted signal, so the
  // native side would run to completion; reject up front instead. Mid-flight
  // aborts reject via napi; normalize that rejection to the AbortError shape
  // isAbortError expects, whatever the embedder threw.
  if (signal?.aborted) throw abortError();
  try {
    const result = await addon.grep(options, signal);
    const root = resolve(options.path);
    return {
      ...result,
      matches: result.matches.map((match) => isAbsolute(match.path) ? match : { ...match, path: resolve(root, match.path) }),
      ...(result.searchFailures ? { searchFailures: result.searchFailures.map((failure) => ({ ...failure, path: resolve(root, failure.path) })) } : {}),
      ...(result.prunedDirectories ? { prunedDirectories: result.prunedDirectories.map((directory) => resolve(root, directory)) } : {}),
    };
  } catch (err) {
    if (signal?.aborted) throw abortError();
    return rethrowNative(err);
  }
}

/**
 * The root-relative path of the first directory that a directory search of
 * `root` with `excludeGlobs` prunes on the way to `path` (inside `root`),
 * `path` itself included when it is a directory; undefined when the search
 * reaches `path`. It applies the walker's own pruning rules and reads the
 * ignore files on the way synchronously.
 */
export function prunedDirectoryOnPath(options: PrunedOnPathOptions): string | undefined {
  const addon = loadAddon();
  if (!addon) throw new Error("Ripgrep native addon not available");
  return addon.prunedDirectoryOnPath(options) ?? undefined;
}

export async function listFiles(options: ListFilesOptions): Promise<ListFilesResult> {
  const addon = loadAddon();
  if (!addon) throw new Error("Ripgrep native addon not available");
  try {
    return await addon.listFiles(options);
  } catch (err) {
    return rethrowNative(err);
  }
}

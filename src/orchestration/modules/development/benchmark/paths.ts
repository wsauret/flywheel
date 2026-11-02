import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Stats } from "node:fs";
import { fsyncDirectory } from "../../../../infra/atomic-write.js";

/** Every path the benchmark names is derived from a configured root and must
 *  stay inside it, including the ones built from directory names read off disk.
 *  This is the lexical half of that rule; the resolving functions below add the
 *  on-disk half. */
export function containedPath(root: string, ...segments: readonly string[]): string {
  const target = resolve(root, ...segments);
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Benchmark path "${segments.join("/")}" escapes ${root}`);
  }
  return target;
}

interface WalkedPath {
  /** The target below the canonical root. */
  readonly path: string;
  /** The target's own metadata, or undefined when it does not exist. */
  readonly stats: Stats | undefined;
}

function isMissing(error: Error): boolean {
  return "code" in error && error.code === "ENOENT";
}

function isAlreadyPresent(error: Error): boolean {
  return "code" in error && error.code === "EEXIST";
}

async function ensureDurableDirectory(path: string): Promise<void> {
  const stats = await lstat(path).catch((error) => {
    if (error instanceof Error && isMissing(error)) return undefined;
    throw error;
  });
  if (stats) {
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`Benchmark directory path must be a real directory: ${path}`);
    return;
  }
  const parent = dirname(path);
  if (parent === path) throw new Error(`Benchmark directory has no existing ancestor: ${path}`);
  await ensureDurableDirectory(parent);
  await mkdir(path).catch(async (error) => {
    if (!(error instanceof Error) || !isAlreadyPresent(error)) throw error;
    const raced = await lstat(path);
    if (!raced.isDirectory() || raced.isSymbolicLink()) throw new Error(`Benchmark directory path must be a real directory: ${path}`);
  });
  fsyncDirectory(parent);
}

/** The path of `target` relative to `root`, or undefined when it is not inside. */
function inside(root: string, target: string): string | undefined {
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return undefined;
  return fromRoot;
}

/** Walk `target` one component at a time below `root`, refusing a symlink at any
 *  component.
 *
 *  A fixture or results path is data on disk: a fixture author, an earlier run,
 *  or anything with write access to the bench tree shapes it. A symlink
 *  anywhere along it would make that data name a file outside the root, so this
 *  fails closed instead of following the link. Components below a component
 *  that does not exist are reported as missing rather than probed. */
async function walkUnder(root: string, target: string, label: string): Promise<WalkedPath> {
  const rootPath = await realpath(root);
  // A caller names the target either the way the layout builds it or already
  // canonical, and both are inside the same root.
  const fromRoot = inside(root, target) ?? inside(rootPath, target);
  if (fromRoot === undefined) throw new Error(`${label} (${target}) is not inside ${root}`);
  let path = rootPath;
  let stats: Stats | undefined;
  let missing = false;
  for (const segment of fromRoot.split(sep)) {
    path = join(path, segment);
    if (missing) continue;
    stats = await lstat(path).catch((error) => {
      if (error instanceof Error && isMissing(error)) return undefined;
      throw error;
    });
    if (!stats) {
      missing = true;
      continue;
    }
    if (stats.isSymbolicLink()) throw new Error(`${label} resolves through the symlink ${path}; benchmark paths must be real files and directories inside ${rootPath}`);
  }
  return { path, stats: missing ? undefined : stats };
}

/** The canonical path of an existing directory below `root`. */
export async function realDirectoryUnder(root: string, target: string, label: string): Promise<string> {
  const walked = await walkUnder(root, target, label);
  if (!walked.stats) throw new Error(`${label} is missing: ${walked.path}`);
  if (!walked.stats.isDirectory()) throw new Error(`${label} must be a directory: ${walked.path}`);
  return walked.path;
}

/** The canonical path of an existing regular file below `root`. */
export async function realFileUnder(root: string, target: string, label: string): Promise<string> {
  const walked = await walkUnder(root, target, label);
  if (!walked.stats) throw new Error(`${label} is missing: ${walked.path}`);
  if (!walked.stats.isFile()) throw new Error(`${label} must be a regular file: ${walked.path}`);
  return walked.path;
}

/** The canonical path of a directory below `root`, created if it is absent.
 *  Every component that already exists must be a real directory, so a run that
 *  writes into a preexisting symlink fails before it writes anything. */
export async function ensuredDirectoryUnder(root: string, target: string, label: string): Promise<string> {
  // The root is Flywheel's own layout rather than fixture data, so the first
  // run of a project creates it.
  await ensureDurableDirectory(resolve(root));
  const walked = await walkUnder(root, target, label);
  if (walked.stats && !walked.stats.isDirectory()) throw new Error(`${label} must be a directory: ${walked.path}`);
  if (!walked.stats) {
    let current = await realpath(root);
    const fromRoot = inside(root, target) ?? inside(current, target);
    if (fromRoot === undefined) throw new Error(`${label} (${target}) is not inside ${root}`);
    for (const segment of fromRoot.split(sep)) {
      current = join(current, segment);
      await ensureDurableDirectory(current);
    }
  }
  return walked.path;
}

/** Whether anything at all is at `path`, without following a final symlink: a
 *  symlink is present, and the caller that requires a real file rejects it. */
export async function isPresent(path: string): Promise<boolean> {
  return await lstat(path).then(() => true, (error) => {
    if (error instanceof Error && isMissing(error)) return false;
    throw error;
  });
}

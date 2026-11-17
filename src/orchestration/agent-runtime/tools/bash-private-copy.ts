/**
 * The private copy of a project that one mutating bash command runs in.
 *
 * Git metadata is private; only the object store is read through alternates.
 * Git's listings run here through the owned
 * launcher. The tree work, which visits every project file, runs as jobs on
 * the private copy Worker of the caller's `PrivateCopyJobs`
 * (`bash-private-copy-tree.ts`), so no project size holds the runtime event
 * loop. Reading a copy's record is such a job too, because the record holds
 * one entry per copied file.
 */

import { existsSync, lstatSync } from "node:fs";
import { readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { Log } from "../../../infra/log.js";
import type { OwnedCommandRunner } from "../../../infra/owned-command.js";
import type { MutationGuardKind } from "./bash-mutation-guard.js";
import { readRepositoryRefs, readReftableStack } from "./bash-copy-refs.js";
import { digestStateEntries, readCopyRepositoryState, readIndexDigest, type RepositoryState, type StateDigest } from "./bash-copy-repository-state.js";
import { PrivateCopyStateDropped, type PrivateCopyJobs } from "./bash-private-copy-jobs.js";
import { PRIVATE_COPY_RECORD, type RecordedCopy } from "./bash-private-copy-record.js";
import type { CopyGeometry, PrivateCopyPool, ReusableCopy } from "./bash-private-copy-pool.js";
import { rootAtPathBoundary, type CopyRecordRead, type CopyTopologyRequest, type ScannedChanges } from "./bash-private-copy-tree.js";
import { BEFORE_IMAGE, type SessionFolderSnapshot } from "./bash-session-observation.js";

const log = Log.create({ service: "bash-private-copy" });

const GIT_TIMEOUT_MS = 30_000;
const GIT_LISTING_MAX_BYTES = 64 * 1024 * 1024;

/** A taken copy as its landing reads it: from memory in the build that took
 *  it, from its record in a later build that adopted its command. Its entries
 *  (one per copied file and link) stay on the private copy Worker, which
 *  holds them or reads them from the record. */
export type LandableCopy = Extract<CopyRecordRead, { readonly kind: "recorded" }>["copy"] & {
  /** The directory that holds everything this copy owns, its record included; deleting it deletes the copy. */
  readonly home: string;
  readonly observedSession?: SessionFolderSnapshot;
};

/** What reading the record of the copy in a home found. */
export type LandableCopyRead = { readonly kind: "recorded"; readonly copy: LandableCopy } | Exclude<CopyRecordRead, { readonly kind: "recorded" }>;

export interface PrivateProjectCopy extends LandableCopy {
  readonly git: RecordedCopy["git"];
  readonly scratchDir: string;
  /** What a pool keeps of this copy for the next take of its session. */
  readonly reuse: ReusableCopy;
  /** Present when the take refreshed an idle copy in place instead of taking a new one. */
  readonly refresh?: CopyRefresh;
}

/** What one refresh wrote: entries cloned or placed again and entries removed,
 *  over the tree, base, and session image, and the take's duration. In a
 *  repository, `reseeded` tells whether the private Git directory was seeded
 *  again because the real repository moved, or kept. */
export interface CopyRefresh {
  readonly recloned: number;
  readonly removed: number;
  readonly refreshMs: number;
  readonly reseeded?: boolean;
}

/** A cwd outside the project needs a containing Git work tree before a command can run. */
export class NoContainingWorkTreeError extends Error {
  constructor(cwd: string) {
    super(`'mutates=true' requires a cwd inside the project or a Git work tree. Could not find a Git work tree containing ${cwd}.`);
    this.name = "NoContainingWorkTreeError";
  }
}

/** Takes the project when it contains executionCwd, otherwise its containing
 *  Git work tree. Both paths must be canonical physical paths. Records the
 *  copy under home. With a pool that holds an idle copy of the same geometry,
 *  refreshes that copy in its own home instead: only what drifted is written
 *  again, and the returned `home` is the reused one. Its private Git directory
 *  keeps its refs and objects when the real repository's HEAD, refs, stash,
 *  index, formats, and linked trees are as the last take seeded them;
 *  otherwise it is seeded again. Its index is always copied again from the
 *  real one, because a command can set index flags that no state read sees.
 *  A reused home whose
 *  directories were replaced is retired before anything is written into it,
 *  and a refresh that fails retires the home and takes a new copy under
 *  `home`. The tree work runs on `jobs`, the pool's with a pool. Throws
 *  NoContainingWorkTreeError when cwd is outside both, or
 *  another error when the selected tree cannot be listed or copied; the real
 *  project is only read: Git runs read-only listings, and no real index, ref,
 *  config, or file is written. */
export async function takePrivateProjectCopy(input: { readonly projectRoot: string; readonly executionCwd: string; readonly home: string; readonly scratchDir?: string; readonly runGit: OwnedCommandRunner; readonly guard: MutationGuardKind; readonly jobs: PrivateCopyJobs; readonly pool?: PrivateCopyPool }): Promise<PrivateProjectCopy> {
  const started = performance.now();
  const { projectRoot, executionCwd } = input;
  const fromProject = relative(projectRoot, executionCwd);
  const outside = fromProject === ".." || fromProject.startsWith(`..${sep}`) || isAbsolute(fromProject);
  let reused: ReusableCopy | undefined;
  let held: ReusableCopy["git"];
  let prepared: Promise<void> | undefined;
  /** The home whose entries the Worker holds until the take records them. */
  let unrecorded: string | undefined;
  const { pool } = input;
  // Runs once the geometry is known: selects the home, resets a reused one,
  // and starts the private Git directory in it unless the reused one holds one.
  const prepare = (geometry: CopyGeometry, format: string | undefined): Promise<void> => {
    prepared = (async () => {
      const idle = pool?.checkout(geometry);
      if (pool && idle && await intactHome(idle, pool)) {
        reused = idle;
        if (await resetHome(idle)) held = idle.git;
      }
      if (format !== undefined && !held) await initializePrivateGit(input.runGit, join(reused?.home ?? input.home, "git"), format);
    })();
    return prepared;
  };
  try {
    const git = await discoverGit(outside ? executionCwd : projectRoot, outside, input.runGit, prepare);
    if (outside && !git) throw new NoContainingWorkTreeError(executionCwd);
    const geometry = geometryOf(git?.realRoot ?? projectRoot, git?.topLevel);
    if (!git) await prepare(geometry, undefined);
    const home = reused?.home ?? input.home;
    const { realRoot } = geometry;
    const treeRoot = join(home, "tree", geometry.treeName);
    const copyRoot = join(treeRoot, geometry.projectInTree);
    const baseRoot = join(home, "base");
    const privateGit = join(home, "git");
    // The held directory is kept only while the real repository is as its seed
    // left it; a moved HEAD, ref, stash, or index seeds a new one first.
    let kept: ReusableCopy["git"];
    if (git && held) {
      const [index, stack] = await Promise.all([readIndexDigest(git.gitDir, input.runGit, input.jobs), reftable(git) ? readReftableStack(git.commonDir) : undefined]);
      const fingerprint = realFingerprint(git, index, stack);
      if (fingerprint === held.fingerprint) kept = held;
      else {
        await rm(privateGit, { recursive: true, force: true, maxRetries: 3 });
        await initializePrivateGit(input.runGit, privateGit, git.format);
      }
    }
    const execute = async (args: string[], stdin?: string): Promise<string> => {
      const result = await input.runGit(["git", `--git-dir=${privateGit}`, "-c", `core.hooksPath=${join(home, "seed-hooks")}`, ...args], { timeoutMs: GIT_TIMEOUT_MS, ...(stdin === undefined ? {} : { stdin }) });
      if (result.exitCode !== 0 || result.timedOut || result.stdoutTruncated) throw new Error(result.stderr || "Git seeding did not finish completely");
      return result.stdout;
    };
    let seededStack: ReadonlyMap<string, Buffer> | undefined;
    const tree = await input.jobs.run({
      kind: "copy",
      request: {
        realRoot, home, copyRoot, baseRoot, guard: input.guard, whollyIgnored: git?.whollyIgnored ?? [],
        ...(input.scratchDir ? { scratchDir: input.scratchDir } : {}),
        git: git && { ...git, privateGitDir: privateGit, projectInTree: geometry.projectInTree, treeRoot, kept: kept !== undefined },
      },
      reuse: reused !== undefined,
    }, git && !kept ? async () => { seededStack = await seedPrivateRefs(privateGit, git, execute); } : undefined);
    unrecorded = home;
    if (git && (await readdir(privateGit)).some(name => name.startsWith("sharedindex."))) await execute(["update-index", "--no-split-index"]);
    if (git && geometry.projectInTree) await hideEntriesOutsideProject(treeRoot, geometry.projectInTree, input.runGit);
    let repository: RepositoryState | null = null;
    let seeded: ReusableCopy["git"];
    if (git) {
      repository = kept?.baseline ?? await readCopyRepositoryState(privateGit, input.runGit, input.jobs);
      // The seed copied the real index and reftable stack, so the fingerprint digests what was seeded, not a later read.
      seeded = kept ?? { fingerprint: realFingerprint(git, repository.index, seededStack), baseline: repository };
    }
    const { observedSession, tally, shared } = tree;
    const copy = await input.jobs.run({
      kind: "finalize", home, treeRoot, repository,
      copy: { realRoot, copyRoot, baseRoot, guard: input.guard, git: git ? { kind: "repository", gitDir: git.gitDir, privateGitDir: privateGit, commonDir: git.commonDir, workTrees: git.workTrees } : { kind: "none" }, shared },
    });
    unrecorded = undefined;
    return {
      ...copy, home, scratchDir: input.scratchDir ?? home,
      ...(observedSession ? { observedSession } : {}),
      reuse: { home, geometry, beforeImage: observedSession !== undefined, refreshedAt: Date.now(), ...(seeded ? { git: seeded } : {}) },
      ...(reused ? { refresh: { recloned: tally.recloned, removed: tally.removed, refreshMs: Math.round(performance.now() - started), ...(git ? { reseeded: kept === undefined } : {}) } } : {}),
    };
  } catch (error) {
    // A Git listing can fail while the checkout is still being prepared; the
    // checked-out copy is retired only once that preparation settled.
    await prepared?.catch(() => undefined);
    if (unrecorded !== undefined) void input.jobs.run({ kind: "forget", home: unrecorded }).catch(() => undefined);
    if (!reused || !pool) throw error;
    void pool.discard(reused);
    if (error instanceof PrivateCopyStateDropped) log.info("private copy state was dropped; taking a new copy");
    else log.warn("private copy refresh failed; taking a new copy", { kind: error instanceof Error ? error.name : typeof error });
    return takePrivateProjectCopy({ ...input, pool: undefined });
  }
}

/** Copies the real refs into the new private Git directory: direct refs as
 *  one `packed-refs` file, symbolic refs in one transaction, then HEAD, the
 *  stash and its reflog, and the branches of the real linked trees. Answers
 *  the reftable stack it copied, or undefined in a files repository. */
async function seedPrivateRefs(privateGit: string, git: GitLayout, execute: (args: string[], stdin?: string) => Promise<string>): Promise<ReadonlyMap<string, Buffer> | undefined> {
  const stack = reftable(git) ? await readReftableStack(git.commonDir) : undefined;
  if (stack) {
    const directory = join(privateGit, "reftable");
    for (const name of await readdir(directory)) await rm(join(directory, name));
    for (const [name, bytes] of stack) await writeFile(join(directory, name), bytes, { flag: "wx" });
  }
  // A reftable repository lists no refs here: its stack is copied whole above.
  const refs = git.refs.trim().split("\n").filter(Boolean).map(line => {
    const [oid = "", ref = "", target] = line.split(" ");
    return { oid, ref, name: Buffer.from(ref), target };
  });
  const direct = refs.filter(({ ref, target }) => !target && ref !== "refs/stash");
  // One packed-refs file instead of a loose file per ref: a repository can hold
  // thousands of refs, and each loose file costs a create and a delete on the
  // file system. Packed names also stay exact where loose names that differ
  // only in case would share one file on a case-insensitive volume. Git compares
  // names byte by byte; the header claims no peeled lines, so Git peels tags itself.
  if (direct.length > 0) {
    const lines = direct.sort((a, b) => Buffer.compare(a.name, b.name)).map(({ oid, ref }) => `${oid} ${ref}\n`);
    await writeFile(join(privateGit, "packed-refs"), `# pack-refs with: sorted \n${lines.join("")}`, { flag: "wx" });
  }
  const symbolic = refs.filter(({ target }) => target).map(({ ref, target }) => `option no-deref\nsymref-create ${ref} ${target}`);
  // Git refuses an empty transaction.
  if (symbolic.length > 0) await execute(["-c", "core.logAllRefUpdates=false", "update-ref", "--stdin"], `start\n${symbolic.join("\n")}\nprepare\ncommit\n`);
  // Git rejects HEAD and its current referent in the same transaction.
  if (git.head.startsWith("ref: ")) await execute(["symbolic-ref", "HEAD", git.head.trim().slice(5)]);
  else await execute(["update-ref", "--no-deref", "HEAD", git.head.trim()]);
  const entries = stack ? [] : git.stash.split("\n").filter(Boolean).toReversed();
  if (entries.length === 0) {
    const stashObject = refs.find(({ ref }) => ref === "refs/stash")?.oid;
    if (stashObject) await execute(["update-ref", "refs/stash", stashObject]);
  }
  for (const entry of entries) {
    const space = entry.indexOf(" ");
    const subject = entry.slice(space + 1);
    await execute(["update-ref", "--create-reflog", ...(subject ? ["-m", subject] : []), "refs/stash", entry.slice(0, space)]);
  }
  if (stack) {
    const others = git.worktreeListing.split("\0\0").filter(row => !row.startsWith(`worktree ${git.topLevel}\0`));
    for (const [i, row] of others.entries()) {
      const branch = row.split("\0").find(field => field.startsWith("branch "))?.slice(7);
      if (!branch) continue;
      const directory = join(privateGit, "worktrees", `protected-${i}`);
      await execute([`--git-dir=${directory}`, "symbolic-ref", "HEAD", branch]);
    }
  }
  return stack;
}

function reftable(git: GitLayout): boolean {
  return /extensions.refstorage reftable/i.test(git.format);
}

/** Digests every input the seed copies from the real repository: HEAD, the
 *  refs, the stash, the formats, the linked trees, the reftable stack (present
 *  exactly in a reftable repository), and the index entries. Equal
 *  fingerprints seed equal private Git state. */
function realFingerprint(git: GitLayout, index: StateDigest, stack: ReadonlyMap<string, Buffer> | undefined): string {
  const parts = [git.head, git.refs, git.stash, git.format, git.worktreeListing, JSON.stringify(index)].map(part => Buffer.from(part));
  return digestStateEntries([...parts, ...[...stack ?? []].flatMap(([name, bytes]) => [Buffer.from(name), bytes])]).sha256;
}

async function initializePrivateGit(runGit: OwnedCommandRunner, privateGit: string, format: string): Promise<void> {
  const initialized = await runGit(["git", "init", "--bare", "--template=", `--object-format=${format.match(/extensions.objectformat (.+)/)?.[1] ?? "sha1"}`, `--ref-format=${format.match(/extensions.refstorage (.+)/)?.[1] ?? "files"}`, privateGit], { timeoutMs: GIT_TIMEOUT_MS });
  if (initialized.exitCode !== 0 || initialized.timedOut) throw new Error(initialized.stderr || "Git initialization did not finish");
}

function geometryOf(realRoot: string, topLevel: string | undefined): CopyGeometry {
  return { realRoot, treeName: basename(topLevel ?? realRoot), projectInTree: topLevel === undefined ? "" : relative(topLevel, realRoot), repository: topLevel !== undefined };
}

/** Whether each directory a refresh writes below is still a real directory:
 *  the home's chain (`homeChain`), the chain from `tree` to the copy root, the
 *  base, and the session image. A copy that fails is retired here, before
 *  anything is written into it. */
async function intactHome(copy: ReusableCopy, pool: PrivateCopyPool): Promise<boolean> {
  const { home, geometry } = copy;
  const tree = join(home, "tree");
  const chain = homeChain(home);
  const inside = [tree, ...chainBelow(tree, join(tree, geometry.treeName, geometry.projectInTree)), join(home, "base"), ...(copy.beforeImage ? [join(home, BEFORE_IMAGE)] : [])];
  const replaced = firstReplaced([...chain, ...inside]);
  if (!replaced) return true;
  log.warn("private copy directory was replaced; taking a new copy", { kind: replaced.kind });
  const removal = pool.discard(copy);
  // The new copy's home goes below the same scratch directory, so a replaced
  // entry of the chain must be gone first. Its removal removes only that entry.
  if (chain.includes(replaced.path)) await removal;
  return false;
}

/** The entries of a home `<parent>/mutations/<id>` that Flywheel creates: the
 *  directory of the copies and the home. A command can replace either, by a
 *  link, a junction, or a file. The parent is the session scratch directory
 *  or the system temporary directory, which can be a person's own link, so
 *  it is never checked or removed. */
function homeChain(home: string): readonly [mutations: string, home: string] {
  return [dirname(home), home];
}

/** The first of `paths`, in order, that is not a real directory. Reads with
 *  `lstat` only, so a link or junction is never followed, and a path below a
 *  replaced one is never read. A path that cannot be read counts as replaced. */
function firstReplaced(paths: readonly string[]): { readonly path: string; readonly kind: "link" | "other" | "missing" } | undefined {
  for (const path of paths) {
    let stats;
    try {
      stats = lstatSync(path, { throwIfNoEntry: false });
    } catch {
      return { path, kind: "other" };
    }
    if (stats?.isDirectory()) continue;
    return { path, kind: stats?.isSymbolicLink() ? "link" : stats ? "other" : "missing" };
  }
  return undefined;
}

/** Returns a reused home to what a new take finds: no record, no entry beside
 *  `tree`, `base`, the session image, and a held private Git directory without
 *  its index, and
 *  nothing under `tree` beside the chain to the copy root. Every generated
 *  file is then created again with exclusive create, which fails on any entry
 *  left in its place. Answers whether the home still holds the private Git
 *  directory of `copy.git` (see `pruneHeldGit`). */
async function resetHome(copy: ReusableCopy): Promise<boolean> {
  const { home, geometry } = copy;
  const removal = { recursive: true, force: true, maxRetries: 3 } as const;
  // The record goes first, as in a discard: a home without one is a copy no landing reads.
  await rm(join(home, PRIVATE_COPY_RECORD), removal);
  const kept = new Set(["tree", "base", ...(copy.beforeImage ? [BEFORE_IMAGE] : []), ...(copy.git ? ["git"] : [])]);
  for (const name of await readdir(home)) if (!kept.has(name)) await rm(join(home, name), removal);
  let directory = join(home, "tree");
  for (const next of [geometry.treeName, ...geometry.projectInTree.split(sep).filter(Boolean)]) {
    for (const name of await readdir(directory)) if (name !== next) await rm(join(directory, name), removal);
    directory = join(directory, next);
  }
  // At the Git top level the pointer sits at the copy root, which the mirror keeps.
  await rm(join(home, "tree", geometry.treeName, ".git"), removal);
  if (!copy.git) return false;
  const privateGit = join(home, "git");
  if (await pruneHeldGit(privateGit)) return true;
  await rm(privateGit, removal);
  return false;
}

/** The entries of a private Git directory that hold the refs, HEAD, and stash
 *  of `RepositoryState`, the protected linked trees, and the object store,
 *  each with its seeded kind. A landing proved the state they hold equal to
 *  the baseline. The index is not one of them: its entries are proven equal,
 *  but a command can set skip-worktree and assume-unchanged flags that no
 *  state read sees, so every take copies the real index again. */
const HELD_GIT_ENTRIES: ReadonlyMap<string, "file" | "directory"> = new Map([
  ["HEAD", "file"], ["packed-refs", "file"],
  ["objects", "directory"], ["refs", "directory"], ["logs", "directory"], ["reftable", "directory"], ["worktrees", "directory"],
]);

/** Removes every entry of a held private Git directory that the seed writes
 *  again or that a command left, such as its config, info, hooks, index, lock
 *  files, and the alternates file, and keeps `HELD_GIT_ENTRIES`. A command
 *  could have put a link where a kept entry was, and this
 *  process writes below `objects/info` without the command's guard, so a kept
 *  entry of another kind answers false and the caller seeds a new directory. */
async function pruneHeldGit(privateGit: string): Promise<boolean> {
  const kindOf = (path: string): "file" | "directory" | "other" | "missing" => {
    const stats = lstatSync(path, { throwIfNoEntry: false });
    return !stats ? "missing" : stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other";
  };
  if (kindOf(privateGit) !== "directory") return false;
  for (const name of await readdir(privateGit)) {
    const kind = HELD_GIT_ENTRIES.get(name);
    if (kind === undefined) await rm(join(privateGit, name), { recursive: true, force: true, maxRetries: 3 });
    else if (kindOf(join(privateGit, name)) !== kind) return false;
  }
  const info = join(privateGit, "objects", "info");
  if (kindOf(join(privateGit, "objects")) !== "directory" || !["directory", "missing"].includes(kindOf(info))) return false;
  await rm(join(info, "alternates"), { force: true });
  return true;
}

/** Each directory from below `from` down to `to`. */
function chainBelow(from: string, to: string): string[] {
  const parts = relative(from, to).split(sep).filter(Boolean);
  return parts.map((_, index) => join(from, ...parts.slice(0, index + 1)));
}

/** Reads copy-local registrations on a Worker. Compare the result with the current-policy topology baseline before publishing files. */
export async function inspectPrivateCopyTopology(request: CopyTopologyRequest, jobs: PrivateCopyJobs): Promise<StateDigest> {
  return jobs.run({ kind: "topology", request });
}

/** Reads the record of the copy in `home`, without its entries, on a Worker.
 *  Throws only when the Worker fails; a record that is missing or unreadable
 *  is an answer. */
export async function readPrivateProjectCopy(home: string, jobs: PrivateCopyJobs): Promise<LandableCopyRead> {
  const read = await jobs.run({ kind: "read", home });
  return read.kind === "recorded" ? { kind: "recorded", copy: { ...read.copy, home } } : read;
}

/** Finds every change the command made in its copy, on the Worker of `jobs`
 *  (see `scanCopyChanges`). For a copy that `jobs` took, the entries and base
 *  listings that the take left spare reading the record and the base, and the
 *  scan's listings become the copy's state for its next take. Any other copy
 *  is scanned with the entries of its record. With `topology`, the answer
 *  also holds the copy's topology from the scan's own walk (see `scannedTopology`),
 *  or none when it could not be observed completely. */
export async function detectCopyChanges(copy: Pick<LandableCopy, "home" | "realRoot" | "copyRoot" | "baseRoot" | "shared">, jobs: PrivateCopyJobs, topology?: Omit<CopyTopologyRequest, "copyRoot" | "shared">): Promise<ScannedChanges> {
  const { home, realRoot, copyRoot, baseRoot, shared } = copy;
  return jobs.run({ kind: "scan", copy: { realRoot, copyRoot, baseRoot, shared }, home, ...(topology ? { topology } : {}) });
}

/** A project below the Git top level is copied alone, so the rest of the
 *  work tree is absent from the copy. Marking every index entry outside the
 *  project skip-worktree in the private index makes Git treat those files as
 *  unchanged instead of deleted. The real index is never touched. */
async function hideEntriesOutsideProject(treeRoot: string, projectInTree: string, runGit: OwnedCommandRunner): Promise<void> {
  const options = { cwd: treeRoot, timeoutMs: GIT_TIMEOUT_MS };
  const outside = await runGit(["git", "ls-files", "-z", "--", `:(top,exclude)${projectInTree.split(sep).join("/")}/`], { ...options, maxOutputBytes: GIT_LISTING_MAX_BYTES });
  if (outside.exitCode !== 0 || outside.timedOut || outside.stdoutTruncated) throw new Error(`git ls-files did not enumerate outside-project entries completely (exit ${outside.exitCode})`);
  if (!outside.stdout) return;
  const marked = await runGit(["git", "update-index", "-z", "--skip-worktree", "--stdin"], { ...options, stdin: outside.stdout });
  if (marked.exitCode !== 0 || marked.timedOut) throw new Error(`git update-index exited with ${marked.exitCode}: ${marked.stderr.trim()}`);
}

/** Maps a real path inside the project to the same place in the copy; other paths stay as they are. */
export function pathInCopy(copy: PrivateProjectCopy, path: string): string {
  const inside = relative(copy.realRoot, path);
  return inside.startsWith("..") || isAbsolute(inside) ? path : join(copy.copyRoot, inside);
}

/** Rewrites each literal occurrence of the real project root that ends at a path boundary to the copy root. */
export function rewriteProjectRoot(copy: PrivateProjectCopy, command: string): string {
  return command.replace(rootAtPathBoundary(copy.realRoot), () => copy.copyRoot);
}

/** Deletes the copy off the command's critical path. Links are removed, never
 *  followed. The record goes first: a home without one is a copy no landing
 *  can read, which the idle scratch sweep removes within an hour, so a copy
 *  whose files cannot be removed now, such as a full clone on Windows with a
 *  file still open, never waits for the sweep's large-entry rule. Before each
 *  removal the home's chain (`homeChain`) is checked: an entry of it that is
 *  no longer a real directory is removed itself, never joined through, and
 *  the removal ends there. The returned promise settles when the removal
 *  ended; it never rejects. Only the pool that owns the copy calls this
 *  (`PrivateCopyPool.discard`), so its close waits for the removal. */
export function discardPrivateCopy(copy: Pick<PrivateProjectCopy, "home">): Promise<void> {
  const { home } = copy;
  return (async () => {
    for (const path of [join(home, PRIVATE_COPY_RECORD), home]) {
      const replaced = firstReplaced(homeChain(home));
      if (replaced?.kind === "missing") return;
      if (replaced) {
        log.warn("private copy removal met a replaced directory; only the replacement is removed", { kind: replaced.kind });
        await rm(replaced.path, { force: true, maxRetries: 3 });
        return;
      }
      await rm(path, { recursive: path === home, force: true, maxRetries: 3 });
    }
  })()
    .catch((error: unknown) => {
      log.warn("private copy removal failed; the scratch sweep retries it", { home: copy.home, error: error instanceof Error ? error.message : String(error) });
    });
}

/** Whether `projectRoot` or a directory above it holds a `.git` entry. Git's
 *  answer stays the authority on the repository; this only tells a refusal
 *  from a directory outside every repository without reading Git's localized
 *  message. */
function hasGitAncestor(projectRoot: string): boolean {
  for (let directory = projectRoot; ; directory = dirname(directory)) {
    if (existsSync(join(directory, ".git"))) return true;
    if (dirname(directory) === directory) return false;
  }
}

interface GitLayout {
  readonly realRoot: string;
  readonly topLevel: string;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly refs: string;
  readonly head: string;
  readonly format: string;
  readonly workTrees: readonly string[];
  readonly worktreeListing: string;
  readonly stash: string;
  /** Project-relative wholly ignored directories. */
  readonly whollyIgnored: readonly string[];
  /** The effective `core.excludesFile`, which may not exist. */
  readonly excludesFile: string;
}

/** Asks Git for the layout of the selected tree. `prepare` runs once with the
 *  copy's geometry and the repository formats as soon as rev-parse answered,
 *  in parallel with the remaining listings; outside Git it does not run. */
async function discoverGit(projectRoot: string, wholeWorkTree: boolean, runGit: OwnedCommandRunner, prepare: (geometry: CopyGeometry, format: string) => Promise<void>): Promise<GitLayout | undefined> {
  const listIgnored = (root: string) => runGit(["git", "-C", root, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], { timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: GIT_LISTING_MAX_BYTES });
  // Only an outside cwd needs the top level before it can list the selected tree.
  // Capture rejection now so the eager read is owned even when discovery refuses.
  const eagerListing = !wholeWorkTree && hasGitAncestor(projectRoot)
    ? listIgnored(projectRoot).then(result => ({ kind: "answered" as const, result }), error => ({ kind: "failed" as const, error }))
    : undefined;
  const layout = await runGit(["git", "-C", projectRoot, "rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir", "--show-object-format", "--show-ref-format"], { timeoutMs: GIT_TIMEOUT_MS }).catch(async error => {
    await eagerListing;
    throw error;
  });
  // A project is outside Git only when Git says so and no `.git` entry stands
  // at or above it. Git that timed out, was ended, or refused a repository it
  // found (unsafe ownership, a damaged index) has not said that, and a copy
  // taken as if it had shares no ignored directory, so it clones every
  // dependency tree and build output of the project.
  if (layout.exitCode === null) {
    await eagerListing;
    throw new Error(`git rev-parse ${layout.timedOut ? "timed out" : "ended"} before it answered`);
  }
  if (layout.exitCode !== 0) {
    await eagerListing;
    if (!hasGitAncestor(projectRoot)) return undefined;
    throw new Error(`git rev-parse exited with ${layout.exitCode} below a .git entry: ${layout.stderr.trim().split("\n")[0] ?? ""}`);
  }
  const [topLevel, gitDir, commonDir, objectFormat, refFormat] = layout.stdout.trim().split("\n");
  if (!topLevel || !gitDir || !commonDir) {
    await eagerListing;
    throw new Error("git rev-parse did not report the work tree and Git directories");
  }
  const realRoot = wholeWorkTree ? join(topLevel) : projectRoot;
  const formatRead = runGit(["git", "-C", realRoot, "config", "--local", "--get-regexp", "^(core.repositoryformatversion|extensions\\.)"], { timeoutMs: GIT_TIMEOUT_MS });
  const geometry = geometryOf(realRoot, join(topLevel));
  // The complete extension snapshot still goes into the copy. Only init can
  // use the formats from rev-parse without waiting for the config read.
  const initialized = objectFormat && refFormat && !refFormat.startsWith("--")
    ? prepare(geometry, `extensions.objectformat ${objectFormat}\nextensions.refstorage ${refFormat}`)
    : formatRead.then(async format => {
      if (format.exitCode !== 0 || format.stdoutTruncated) throw new Error(`Git could not list the repository format (exit ${format.exitCode ?? "none"})`);
      await prepare(geometry, format.stdout);
    });
  const [listing, configured, workTrees, format, stash, symbolic, refs] = await Promise.all([
    eagerListing ? eagerListing.then(answer => {
      if (answer.kind === "failed") throw answer.error;
      return answer.result;
    }) : listIgnored(realRoot),
    runGit(["git", "-C", realRoot, "config", "--path", "--get", "core.excludesFile"], { timeoutMs: GIT_TIMEOUT_MS }),
    runGit(["git", "-C", realRoot, "worktree", "list", "--porcelain", "-z"], { timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: GIT_LISTING_MAX_BYTES }),
    formatRead,
    runGit(["git", "-C", realRoot, "reflog", "show", "--format=%H %gs", "refs/stash"], { timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: GIT_LISTING_MAX_BYTES }),
    runGit(["git", "-C", realRoot, "symbolic-ref", "-q", "--no-recurse", "HEAD"], { timeoutMs: GIT_TIMEOUT_MS }),
    // A reftable repository's refs are its stack, which the seed copies whole.
    formatRead.then(listed => /extensions.refstorage reftable/i.test(listed.stdout) ? undefined : readRepositoryRefs({ gitDir: join(gitDir), commonDir: join(commonDir), runGit })),
    initialized,
  ]);
  if (listing.exitCode !== 0 || listing.stdoutTruncated) throw new Error(`git ls-files could not list ignored directories (exit ${listing.exitCode ?? "none"})`);
  for (const [name, result] of [["worktrees", workTrees], ["repository format", format]] as const) {
    if (result.exitCode !== 0 || result.timedOut || result.stdoutTruncated) throw new Error(`Git could not list ${name} (exit ${result.exitCode ?? "none"})`);
  }
  const whollyIgnored = listing.stdout.split("\0")
    .filter(entry => entry.endsWith("/"))
    .map(entry => entry.slice(0, -1).split("/").join(sep));
  // Unset, Git reads its XDG default, which the private excludes file must carry over too.
  const excludesFile = configured.exitCode === 0 && configured.stdout.trim() !== ""
    ? configured.stdout.trim()
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "git", "ignore");
  if (stash.timedOut || stash.exitCode === null || stash.stdoutTruncated || (stash.exitCode !== 0 && stash.exitCode !== 128)) throw new Error("Git could not snapshot the complete stash reflog");
  if (symbolic.timedOut || symbolic.stdoutTruncated || (symbolic.exitCode !== 0 && symbolic.exitCode !== 1)) throw new Error("Git could not read HEAD");
  let head: string;
  if (symbolic.exitCode === 0) head = `ref: ${symbolic.stdout.trim()}\n`;
  else {
    const resolved = await runGit(["git", "-C", realRoot, "rev-parse", "--verify", "HEAD"], { timeoutMs: GIT_TIMEOUT_MS });
    if (resolved.exitCode !== 0 || resolved.timedOut || resolved.stdoutTruncated) throw new Error("Git could not resolve HEAD");
    head = resolved.stdout;
  }
  const refText = refs === undefined ? "" :
    [...refs]
      .map(([name, ref]) => `${ref.object ?? "0".repeat(40)} ${name}${ref.kind === "symbolic" ? ` ${ref.target}` : ""}`).join("\n");
  // Git keeps listing a linked tree whose directory was deleted until `git worktree
  // prune`. Such a tree has nothing to protect, and the guard cannot resolve its path.
  const existingTrees = workTrees.stdout.split("\0").filter(field => field.startsWith("worktree ")).map(field => field.slice(9)).filter(tree => existsSync(tree));
  return { realRoot, topLevel: join(topLevel), gitDir: join(gitDir), commonDir: join(commonDir), refs: refText, head, format: format.stdout, stash: stash.exitCode === 0 ? stash.stdout : "", worktreeListing: workTrees.stdout, workTrees: existingTrees, whollyIgnored, excludesFile };
}


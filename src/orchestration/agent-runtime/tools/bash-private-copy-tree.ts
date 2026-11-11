/**
 * The filesystem half of a private project copy: cloning the project tree and
 * finding what a command changed in it. Both visit every project file, so both
 * run on the private copy Worker, never on a runtime event loop.
 *
 * The copy holds every project file outside the wholly ignored directories Git
 * reports, cloned copy-on-write where the filesystem supports it. A directory
 * that holds no wholly ignored directory is cloned in one call. Wholly ignored
 * directories (node_modules, .flywheel, dist, ...) are shared, not copied:
 * cloning them costs tens of seconds, and writes into them are shared by
 * design. The session scratch stays shared too; a separate before image
 * observes its landed changes without changing these sharing rules.
 *
 * Taking the copy records, per copied file, the real file's state before it
 * was cloned. That state is the expected state the publisher checks before it
 * overwrites or deletes the real file, so a file another writer changed after
 * the copy was taken is a conflict rather than a lost write. The copy's files
 * are cloned once more, before the command starts, as the base against which
 * such a conflict is merged; nothing writes the base after that. Taking the
 * copy ends by writing its record into the copy's home, so a later build that
 * adopts the command can land the copy too (`bash-private-copy-record.ts`).
 */

import { createHash } from "node:crypto";
import { constants, copyFileSync, cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync, type BigIntStats } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileFingerprint, observeFileState, sameObservedState, type ExpectedFileState, type FileFingerprint } from "../../file-edits/file-state.js";
import type { MutationGuardKind } from "./bash-mutation-guard.js";
import { cloneEntry, mirrorTree, PERMISSION_BITS, type CloneEntry, type MirroredFile, type MirrorPlan, type MirrorState, type MirrorTally } from "./bash-private-copy-mirror.js";
import { PRIVATE_INDEX, writePrivateCopyRecord, type PrivateCopyRecordRead, type RecordedCopy } from "./bash-private-copy-record.js";
import { digestStateEntries, type RepositoryState, type StateDigest } from "./bash-copy-repository-state.js";
import type { SessionFolderObservation, SessionFolderSnapshot } from "./bash-session-observation.js";

/** A real project file's state when the copy was taken, pinned by hash when it changed too recently for its timestamps alone. */
export type RealFileState = MirroredFile["source"];

export interface CopiedFile {
  /** The real file's state when the copy was taken. */
  readonly real: RealFileState;
  /** The clone's own state and permission bits before the command started. */
  readonly copy: FileFingerprint;
  readonly mode: number;
}

/** How the copy reaches a shared entry. `link` places a symlink (a junction on
 *  Windows) to the real entry. `bind` places an empty entry of the same kind
 *  for a mount namespace to bind the writable real entry onto.
 *  A mount namespace needs bind targets; every other guard reaches shared entries through links. */
function sharedEntryForm(guard: MutationGuardKind): "link" | "bind" {
  return guard === "mount-namespace" ? "bind" : "link";
}

/** What the tree copy needs, decided on the calling thread from Git's answers. */
export interface CopyTreeRequest {
  readonly realRoot: string;
  /** The directory that holds everything the copy owns. */
  readonly home: string;
  readonly copyRoot: string;
  /** Where the copy's own files are cloned again before the command starts, as the base of a later merge. */
  readonly baseRoot: string;
  readonly scratchDir?: string;
  /** The guard the command runs under, which decides how the copy shares entries. */
  readonly guard: MutationGuardKind;
  /** Project-relative wholly ignored directories. */
  readonly whollyIgnored: readonly string[];
  /** The real Git directory, whose index the copy's home carries, and the effective excludes file; absent outside Git. */
  readonly git: {
    readonly gitDir: string; readonly commonDir: string; readonly privateGitDir: string; readonly treeRoot: string;
    readonly refs: string; readonly head: string; readonly format: string; readonly workTrees: readonly string[]; readonly topLevel: string; readonly worktreeListing: string;
    readonly excludesFile: string; readonly projectInTree: string;
  } | undefined;
  /** What the previous take into this home left, so that only drifted entries are written again. */
  readonly prior?: CopyTreeState;
}

/** What each mirror of a take left in its target: the copy, its base, and the session before image. */
export interface CopyTreeState {
  readonly tree: MirrorState;
  readonly base: MirrorState;
  readonly session?: MirrorState;
}

/** A taken copy as the change scan reads it. */
export interface CopiedProject {
  readonly realRoot: string;
  readonly copyRoot: string;
  /** The copy's own files as the command started, which nothing writes after that. */
  readonly baseRoot: string;
  /** Project-relative entries through which the command reaches the real project instead of its copy. */
  readonly shared: readonly string[];
  /** Copied regular files by project-relative path. */
  readonly files: ReadonlyMap<string, CopiedFile>;
  /** Copied symlinks by project-relative path, with their targets. */
  readonly links: ReadonlyMap<string, string>;
}

export type CopiedTree = Pick<CopiedProject, "shared" | "files" | "links"> & { readonly observedSession?: SessionFolderSnapshot; readonly state: CopyTreeState; readonly tally: MirrorTally };

/** One regular file the command added, changed, or deleted in its copy. `after` undefined is a deletion. */
export interface CopyChange {
  readonly path: string;
  readonly after: Uint8Array | undefined;
  readonly expected: ExpectedFileState;
  /** POSIX permission bits of a file the command created; an existing file keeps its own. */
  readonly mode: number | undefined;
}

/** A change the publisher cannot land, which only regular file contents do, and why. */
export interface UnsupportedChange {
  readonly path: string;
  readonly reason: string;
}

export interface CopyChanges {
  readonly changes: readonly CopyChange[];
  readonly unsupported: readonly UnsupportedChange[];
  readonly removedDirectories: readonly RemovedDirectory[];
}

/** A directory that existed before a command and is gone after it, topmost only, with the number and total bytes of the files it held, both 0 for an empty one. */
export interface RemovedDirectory {
  readonly path: string;
  readonly files: number;
  readonly bytes: number;
}

/** The topmost directories of the before tree at `beforeRoot` that `afterRoot` no longer holds at the same
 *  relative path, in path order, each with the tally of `files` (relative path to byte size before the
 *  command) below it. `skip` names the entries, by parent directory and name, that neither tree observes.
 *  Links are never followed. */
export function removedDirectories(beforeRoot: string, afterRoot: string, files: Iterable<readonly [string, number]>, skip: (directory: string, name: string) => boolean): RemovedDirectory[] {
  const removed = new Map<string, { files: number; bytes: number }>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(beforeRoot, directory), { withFileTypes: true })) {
      if (!entry.isDirectory() || skip(directory, entry.name)) continue;
      const path = join(directory, entry.name);
      const after = lstatSync(join(afterRoot, path), { throwIfNoEntry: false });
      // A directory replaced by another kind of entry is no removal; the file scans report what replaced it.
      if (!after) removed.set(path, { files: 0, bytes: 0 });
      else if (after.isDirectory()) walk(path);
    }
  };
  walk("");
  if (removed.size > 0) {
    for (const [path, bytes] of files) {
      const tally = ancestorsOf(path).map(ancestor => removed.get(ancestor)).find(Boolean);
      if (tally) {
        tally.files += 1;
        tally.bytes += bytes;
      }
    }
  }
  return [...removed].map(([path, tally]) => ({ path, ...tally })).sort((a, b) => a.path.localeCompare(b.path));
}

/** One job of the private copy Worker. */
export type PrivateCopyJob =
  | { readonly kind: "copy"; readonly request: CopyTreeRequest }
  | { readonly kind: "finalize"; readonly copy: Omit<RecordedCopy, "execution">; readonly home: string; readonly treeRoot: string; readonly repository: RepositoryState | null }
  | { readonly kind: "topology"; readonly request: CopyTopologyRequest }
  | { readonly kind: "index"; readonly bytes: Uint8Array }
  | { readonly kind: "scan"; readonly copy: CopiedProject }
  | { readonly kind: "session"; readonly home: string; readonly projectRoot: string | undefined; readonly snapshot?: SessionFolderSnapshot }
  | { readonly kind: "read"; readonly home: string };

/** A copy job answers with its `CopiedTree`, a scan job with its
 *  `CopyChanges`, and a read job with what it found of the copy's record. */
export type PrivateCopyAnswer =
  | { readonly kind: "done"; readonly value: CopiedTree | CopyChanges | PrivateCopyRecordRead | RecordedCopy | StateDigest | SessionFolderObservation }
  | { readonly kind: "git-ready" }
  | { readonly kind: "failed"; readonly message: string };

/** Clones the project into `request.copyRoot`, then the copy into
 *  `request.baseRoot`, and writes the private Git index and excludes file.
 *  With `request.prior`, both mirrors write only what drifted since that
 *  take. Finalization writes the record after all Git setup. Throws when the
 *  project cannot be read or copied; the real project is only read. `clone`
 *  defaults to the platform's clone; a test replaces it to put a concurrent
 *  write between a file's observation and its clone. */
export function copyProjectTree(request: CopyTreeRequest, clone: CloneEntry = cloneEntry, gitReady?: () => void): CopiedTree {
  const { realRoot, home, copyRoot, baseRoot, prior } = request;
  const startedNs = BigInt(Date.now()) * 1_000_000n;
  mkdirSync(copyRoot, { recursive: true });
  const shared = new Set(request.whollyIgnored);
  // The copy's own home must never be copied into itself, so its top project directory is shared.
  const [homeTop] = relative(realRoot, home).split(sep);
  if (homeTop && homeTop !== ".." && !isAbsolute(homeTop)) shared.add(homeTop);
  const sharedRoots = [...shared].filter(path => !hasAncestorIn(path, shared));
  if (request.git) {
    writePrivateGitFiles(request.git, home, sharedRoots);
    gitReady?.();
  }
  const sharedSet = new Set(sharedRoots);
  const descend = new Set(sharedRoots.flatMap(ancestorsOf));
  const planFrom = (root: string, sharing: "share" | "omit") => (directory: string, name: string): MirrorPlan => {
    const path = join(directory, name);
    if (directory === "" && isGitMetadata(root, name)) return "omit";
    if (sharedSet.has(path)) return sharing;
    return descend.has(path) ? "descend" : "mirror";
  };
  const tally: MirrorTally = { recloned: 0, removed: 0 };
  const tree = mirrorTree({
    source: realRoot, target: copyRoot, plan: planFrom(realRoot, "share"), prior: prior?.tree, startedNs, share: sharedEntryForm(request.guard), pin: true, clone, tally,
    // The pointer to the private Git directory sits at the copy root when the project is the Git top level.
    generated: new Set(request.git && !request.git.projectInTree ? [".git"] : []),
  });
  // The base is cloned from the copy, not from the real project, so it holds
  // exactly the bytes the command starts from even when a real write lands
  // between the two clones. Copy files are private, so their fingerprints are trusted without a pin.
  const base = mirrorTree({ source: copyRoot, target: baseRoot, plan: planFrom(copyRoot, "omit"), prior: prior?.base, startedNs, pin: false, clone, tally });
  return {
    shared: sharedRoots,
    files: new Map([...tree.files].map(([path, file]) => [path, { real: file.source, copy: file.target, mode: file.mode }])),
    links: new Map([...tree.links].map(([path, link]) => [path, link.target])),
    state: { tree, base },
    tally,
  };
}

export interface CopyTopologyRequest {
  readonly copyRoot: string;
  readonly treeRoot: string;
  readonly shared: readonly string[];
  readonly privateGitDir: string | null;
}

/** Binds copy-local Git registrations without following a shared entry, symlink, or gitdir target.
 * Throws if a complete bounded observation cannot be made. */
export function observeCopyTopology(request: CopyTopologyRequest): StateDigest {
  let bytes = 0;
  let count = 0;
  const bounded = (entry: Buffer): Buffer => {
    bytes += entry.byteLength;
    if (++count > 100_000 || bytes > 64 * 1024 * 1024) throw new Error("Copy repository topology exceeds the inspection bound");
    return entry;
  };
  function* metadata(path: string, name: string, depth: number): Generator<Buffer> {
    if (depth > 256) throw new Error("Copy repository topology exceeds the inspection depth");
    const stats = lstatSync(path, { throwIfNoEntry: false });
    if (!stats) return;
    if (stats.isSymbolicLink()) yield bounded(Buffer.from(JSON.stringify([name, "link", readlinkSync(path)])));
    else if (stats.isFile()) {
      if (stats.size > 64 * 1024 * 1024 - bytes) throw new Error("Copy repository topology exceeds the inspection bound");
      yield bounded(Buffer.from(JSON.stringify([name, "file", createHash("sha256").update(readFileSync(path)).digest("hex")])));
      bytes += stats.size;
      if (bytes > 64 * 1024 * 1024) throw new Error("Copy repository topology exceeds the inspection bound");
    } else if (stats.isDirectory()) {
      yield bounded(Buffer.from(JSON.stringify([name, "directory"])));
      for (const child of readdirSync(path).sort()) yield* metadata(join(path, child), `${name}/${child}`, depth + 1);
    } else throw new Error("Copy repository topology contains an unsupported entry");
  }
  const shared = new Set(request.shared.map(path => join(request.copyRoot, path)));
  function* tree(directory: string, depth: number): Generator<Buffer> {
    if (depth > 256 || ++count > 100_000) throw new Error("Copy repository topology exceeds the inspection bound");
    if (!lstatSync(directory).isDirectory()) throw new Error("Copy tree root is not a directory");
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (isGitMetadata(directory, name)) {
        const stats = lstatSync(path);
        // Existing nested repositories are registrations, not another file tree to inspect.
        if (stats.isDirectory()) yield bounded(Buffer.from(JSON.stringify([relative(request.treeRoot, path), "directory"])));
        else yield* metadata(path, relative(request.treeRoot, path), depth + 1);
      } else if (!shared.has(path) && lstatSync(path).isDirectory()) yield* tree(path, depth + 1);
    }
  }
  function* entries(): Generator<Buffer> {
    yield* tree(request.treeRoot, 0);
    if (request.privateGitDir) {
      for (const name of ["worktrees", "modules"]) yield* metadata(join(request.privateGitDir, name), `private/${name}`, 0);
    }
  }
  return digestStateEntries(entries());
}

/** Writes V4 only after parent-side Git setup, preserving the original file observation maps. */
export function finalizePrivateCopy(job: Extract<PrivateCopyJob, { readonly kind: "finalize" }>): RecordedCopy {
  const topology = observeCopyTopology({ copyRoot: job.copy.copyRoot, treeRoot: job.treeRoot, shared: job.copy.shared, privateGitDir: job.copy.git.kind === "repository" ? job.copy.git.privateGitDir : null });
  const copy: RecordedCopy = { ...job.copy, execution: { kind: "file-only-v4", treeRoot: job.treeRoot, baseline: { repository: job.repository, topology } } };
  writePrivateCopyRecord(job.home, copy);
  return copy;
}

/** The private index starts as a copy of the real one; a repository with no index
 *  yet has none, which Git reads as an empty index. A linked directory is
 *  a symlink to Git, which a directory-only ignore pattern such as
 *  `node_modules/` does not match, so the private excludes file keeps the
 *  effective one's patterns and ignores each link by exact path.
 *  The home is writable by the command, so every file is created exclusively:
 *  a create fails on any entry already there, a link included, and never
 *  writes through one. */
function writePrivateGitFiles(git: NonNullable<CopyTreeRequest["git"]>, home: string, sharedRoots: readonly string[]): void {
  const privateGit = git.privateGitDir;
  mkdirSync(join(privateGit, "objects", "info"), { recursive: true });
  mkdirSync(join(privateGit, "refs"), { recursive: true });
  writeFileSync(join(privateGit, "objects", "info", "alternates"), `${join(git.commonDir, "objects")}\n`, { flag: "wx" });
  const configValue = (value: string): string => JSON.stringify(value);
  const format = git.format.trim().split("\n").map(line => {
    const space = line.indexOf(" ");
    const key = line.slice(0, space);
    const dot = key.indexOf(".");
    return `[${key.slice(0, dot)}]\n${key.slice(dot + 1)} = ${configValue(line.slice(space + 1))}`;
  }).join("\n");
  const worktreeConfig = join(git.gitDir, "config.worktree");
  const config = [
    format, `[include]\npath = ${configValue(join(git.commonDir, "config"))}`,
    ...(/extensions.worktreeconfig true/i.test(git.format) && lstatSync(worktreeConfig, { throwIfNoEntry: false }) ? [`[include]\npath = ${configValue(worktreeConfig)}`] : []),
    `[core]\nbare = false\nworktree = ${configValue(git.treeRoot)}\nexcludesFile = ${configValue(join(home, "exclude"))}`,
    "[gc]\nauto = 0",
  ].join("\n") + "\n";
  // Git init writes a default config, which the private one replaces.
  rmSync(join(privateGit, "config"), { force: true });
  writeFileSync(join(privateGit, "config"), config, { flag: "wx" });
  const info = join(git.commonDir, "info", "exclude");
  if (lstatSync(info, { throwIfNoEntry: false })) {
    mkdirSync(join(privateGit, "info"), { recursive: true });
    copyFileSync(info, join(privateGit, "info", "exclude"), constants.COPYFILE_EXCL);
  }
  const hooks = join(git.commonDir, "hooks");
  // Git runs a hook only by its exact name, so the `.sample` files it installs
  // never run; leaving them out saves each take a file to create and remove.
  if (lstatSync(hooks, { throwIfNoEntry: false })) cpSync(hooks, join(privateGit, "hooks"), { recursive: true, errorOnExist: true, force: false, filter: source => !source.endsWith(".sample") });
  writeFileSync(join(git.treeRoot, ".git"), `gitdir: ${privateGit}\n`, { flag: "wx" });
  const index = join(git.gitDir, "index");
  if (observeFileState(index).kind === "file") {
    copyFileSync(index, join(privateGit, PRIVATE_INDEX), constants.COPYFILE_EXCL);
    for (const entry of readdirSync(git.gitDir)) if (entry.startsWith("sharedindex.")) copyFileSync(join(git.gitDir, entry), join(privateGit, entry), constants.COPYFILE_EXCL);
  }
  const inherited = observeFileState(git.excludesFile).kind === "file" ? readFileSync(git.excludesFile, "utf8") : "";
  const linked = sharedRoots.map(path => `/${join(git.projectInTree, path).split(sep).join("/")}`);
  writeFileSync(join(home, "exclude"), [inherited, ...linked].join("\n"), { flag: "wx" });
  const others = git.worktreeListing.split("\0\0").filter(row => !row.startsWith(`worktree ${git.topLevel}\0`));
  for (const [i, row] of others.entries()) {
    const branch = row.split("\0").find(field => field.startsWith("branch "))?.slice(7);
    const tree = row.split("\0").find(field => field.startsWith("worktree "))?.slice(9);
    if (!branch || !tree) continue;
    const directory = join(privateGit, "worktrees", `protected-${i}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "HEAD"), `ref: ${branch}\n`, { flag: "wx" });
    writeFileSync(join(directory, "gitdir"), `${join(tree, ".git")}\n`, { flag: "wx" });
    writeFileSync(join(directory, "commondir"), "../..\n", { flag: "wx" });
    writeFileSync(join(directory, "locked"), "Protected real worktree\n", { flag: "wx" });
    if (/extensions.refstorage reftable/i.test(git.format)) mkdirSync(join(directory, "reftable"));
  }
}

/** Finds every change the command made in its copy. A regular file it added,
 *  changed, or deleted is a change, unless its bytes equal the real file's
 *  current bytes. Everything the publisher cannot land is reported instead:
 *  symlink changes, permission changes, a file replaced by another kind of
 *  entry, which never publishes as a deletion, and a file below a real
 *  directory that is a symlink or no directory at all, which would place it
 *  outside the project or fail. Shared entries are not walked. */
export function scanCopyChanges(copy: CopiedProject): CopyChanges {
  const changes: CopyChange[] = [];
  const unsupported: UnsupportedChange[] = [];
  // An entry whose kind changed is reported once, by the loop over the kind it had when the copy was taken.
  const nestedGit = new Set<string>();
  const shared = new Set(copy.shared);
  for (const { path, stats } of walkCopy(copy.copyRoot, "", shared, nestedGit)) {
    const copyPath = join(copy.copyRoot, path);
    const linked = copy.links.get(path);
    if (stats.isSymbolicLink()) {
      if (linked === undefined && !copy.files.has(path)) unsupported.push({ path, reason: "symbolic link created" });
      else if (linked !== undefined && linked !== readlinkSync(copyPath)) unsupported.push({ path, reason: "symbolic link changed" });
      continue;
    }
    if (linked !== undefined) continue;
    const before = copy.files.get(path);
    if (before && sameObservedState(fileFingerprint(stats), before.copy)) continue;
    const mode = Number(stats.mode) & PERMISSION_BITS;
    if (before && mode !== before.mode) unsupported.push({ path, reason: "permissions changed" });
    const blocked = blockedParent(copy.realRoot, path);
    if (blocked) {
      unsupported.push({ path, reason: blocked });
      continue;
    }
    const after = withRealRoot(copy, readFileSync(copyPath));
    if (sameRealBytes(join(copy.realRoot, path), after)) continue;
    changes.push({ path, after, expected: before?.real ?? { kind: "absent" }, mode: before ? undefined : mode });
  }
  for (const path of nestedGit) unsupported.push({ path, reason: "Git repository or submodule registration was not applied" });
  for (const [path, file] of copy.files) {
    const now = lstatSync(join(copy.copyRoot, path), { throwIfNoEntry: false });
    if (!now) {
      if (observeFileState(join(copy.realRoot, path)).kind !== "absent") changes.push({ path, after: undefined, expected: file.real, mode: undefined });
    } else if (!now.isFile()) unsupported.push({ path, reason: `replaced by ${kindOf(now)}` });
  }
  for (const path of copy.links.keys()) {
    const now = lstatSync(join(copy.copyRoot, path), { throwIfNoEntry: false });
    if (!now) unsupported.push({ path, reason: "symbolic link removed" });
    else if (!now.isSymbolicLink()) unsupported.push({ path, reason: `symbolic link replaced by ${kindOf(now)}` });
  }
  // Directory order differs across filesystems; path order keeps reports and publication stable.
  const byPath = (a: { readonly path: string }, b: { readonly path: string }): number => a.path.localeCompare(b.path);
  const removed = removedDirectories(copy.baseRoot, copy.copyRoot, [...copy.files].map(([path, file]) => [path, file.real.size] as const),
    (directory, name) => shared.has(join(directory, name)) || isGitMetadata(join(copy.baseRoot, directory), name));
  return { changes: changes.sort(byPath), unsupported: unsupported.sort(byPath), removedDirectories: removed };
}

/** Matches each literal occurrence of `root` that ends at a path boundary:
 *  the next character is no word character, `.`, or `-`. */
export function rootAtPathBoundary(root: string): RegExp {
  return new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`, "g");
}

/** The command ran with the real root rewritten to the copy root, and its own
 *  working directory is the copy, so a file it wrote can name the copy root.
 *  The landed file names the real root there instead. Bytes that hold no copy
 *  root are returned unchanged. */
function withRealRoot(copy: CopiedProject, bytes: Buffer): Buffer {
  const copyRoot = Buffer.from(copy.copyRoot);
  if (!bytes.includes(copyRoot)) return bytes;
  // Latin-1 maps each byte to one character and back, so every other byte is kept.
  const realRoot = Buffer.from(copy.realRoot).toString("latin1");
  return Buffer.from(bytes.toString("latin1").replace(rootAtPathBoundary(copyRoot.toString("latin1")), () => realRoot), "latin1");
}

function isGitMetadata(directory: string, name: string): boolean {
  if (name === ".git") return true;
  if (name.toLowerCase() !== ".git") return false;
  const git = lstatSync(join(directory, ".git"), { bigint: true, throwIfNoEntry: false });
  if (!git) return false;
  const entry = lstatSync(join(directory, name), { bigint: true });
  return git.dev === entry.dev && git.ino === entry.ino;
}

/**
 * Shared entries are skipped: a link is never followed, and a bind placeholder is no project file.
 * @yields {object} Each regular file and symlink below `directory`, relative to `root`, with its own stats.
 */
function* walkCopy(root: string, directory: string, shared: ReadonlySet<string>, nestedGit?: Set<string>): Generator<{ readonly path: string; readonly stats: BigIntStats }> {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (shared.has(path)) continue;
    if (isGitMetadata(join(root, directory), entry.name)) {
      if (directory !== "") nestedGit?.add(path);
      continue;
    }
    if (entry.isDirectory()) yield* walkCopy(root, path, shared, nestedGit);
    else if (entry.isFile() || entry.isSymbolicLink()) yield { path, stats: lstatSync(join(root, path), { bigint: true }) };
  }
}

/** Names the first real ancestor of `path` that cannot hold it: a symlink would place the file outside the project, and a file cannot hold one at all. */
function blockedParent(realRoot: string, path: string): string | undefined {
  for (const ancestor of ancestorsOf(path)) {
    const stats = lstatSync(join(realRoot, ancestor), { throwIfNoEntry: false });
    if (!stats) return undefined;
    if (stats.isSymbolicLink()) return `${ancestor} is a symbolic link in the project`;
    if (!stats.isDirectory()) return `${ancestor} is not a directory in the project`;
  }
  return undefined;
}

function sameRealBytes(path: string, bytes: Uint8Array): boolean {
  const real = observeFileState(path);
  return real.kind === "file" && real.size === bytes.byteLength && readFileSync(path).equals(bytes);
}

function kindOf(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): string {
  if (stats.isFile()) return "a regular file";
  if (stats.isSymbolicLink()) return "a symbolic link";
  return stats.isDirectory() ? "a directory" : "a special file";
}

function ancestorsOf(path: string): string[] {
  const parts = path.split(sep);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join(sep));
}

function hasAncestorIn(path: string, paths: ReadonlySet<string>): boolean {
  return ancestorsOf(path).some(ancestor => paths.has(ancestor));
}

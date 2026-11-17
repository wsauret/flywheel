/**
 * Makes one directory tree of a private copy home mirror its source: the
 * project tree, the copy's base, and the session folder's before image all
 * clone through `mirrorTree`. A first mirror fills an empty target. A later
 * mirror with the record of the previous one writes only what drifted: an
 * entry whose source and target both still match the record is not touched,
 * an entry that drifted is removed and cloned again, and a target entry the
 * source no longer holds is removed.
 *
 * The mirror reads entries with `lstat` and `readdir` only. It never follows a
 * symbolic link or a junction, in the source or in the target, and removing a
 * link removes the link, never its referent.
 *
 * Reading a directory's entries costs far more than reading one entry's
 * stamps, so a directory listing that an earlier read holds stands in for a
 * new read while the directory's stamps prove that no entry was added,
 * removed, or renamed since (`readListing`). Each file is still compared with
 * its record by its own stamps.
 */

import { FFIType } from "bun:ffi";
import { createHash } from "node:crypto";
import { chmodSync, constants, copyFileSync, cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, type BigIntStats, type Dirent } from "node:fs";
import { join } from "node:path";
import { bindLibc } from "../../../infra/libc.js";
import { fileFingerprint, observeFileState, sameObservedState, type ExpectedFileState, type FileFingerprint } from "../../file-edits/file-state.js";

/** A change inside this window of the copy's start can share a timestamp tick
 *  with a later write (ext4 coarse ctime, FAT's two seconds), so such a file's
 *  cloned bytes are pinned by hash as well. */
export const RACY_WINDOW_NS = 2_000_000_000n;
/** POSIX permission bits; Windows has none to compare. */
export const PERMISSION_BITS = process.platform === "win32" ? 0 : 0o777;

/** Copies one regular file or one whole directory tree from a source into a target that does not hold it. */
export type CloneEntry = (source: string, destination: string, kind: "file" | "directory") => void;

/** What the mirror does with one source entry. `omit` leaves it out, and
 *  removes a target entry of that name. `share` places a link to it, or an
 *  empty bind target. `descend` keeps a real target directory and mirrors its
 *  entries one by one; it is never cloned whole. `mirror` clones it. */
export type MirrorPlan = "omit" | "share" | "descend" | "mirror";

export interface MirroredFile {
  /** The source file's state when it was observed, before it was cloned. */
  readonly source: Extract<ExpectedFileState, { readonly kind: "file" }>;
  /** The target file's own state after the mirror. */
  readonly target: FileFingerprint;
  /** The target file's POSIX permission bits. */
  readonly mode: number;
}

/** A mirrored symbolic link's text in the source and as the target reads it
 *  back. A link that appeared during a whole-directory clone has no source observation. */
interface MirroredLink {
  readonly source: string | undefined;
  readonly target: string;
}

/** A shared entry's placeholder as placed: a link with its read-back text, or an empty bind target. */
type SharedPlaceholder = { readonly kind: "link"; readonly target: string } | { readonly kind: "file" | "directory" };

/** What one mirror left in its target, by target-relative path. */
export interface MirrorState {
  readonly files: ReadonlyMap<string, MirroredFile>;
  readonly links: ReadonlyMap<string, MirroredLink>;
  readonly shared: ReadonlyMap<string, SharedPlaceholder>;
  /** The listing of each target directory ("" is the target itself) that
   *  is still exact after the mirror: one its own writes did not change. */
  readonly listings: ReadonlyMap<string, HeldListing>;
  /** Every directory the mirror left in its target ("" is the target itself), shared placeholders excepted. */
  readonly directories: ReadonlySet<string>;
}

export type EntryKind = "file" | "directory" | "link" | "other";

/** A directory's entries as one read found them, with the directory's
 *  identity and stamps from just before that read. Adding, removing, or
 *  renaming an entry changes both stamps, so equal stamps prove equal entries. */
export interface HeldListing {
  readonly identity: string;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  /** A time no later than the read. */
  readonly readNs: bigint;
  readonly entries: ReadonlyMap<string, EntryKind>;
}

/** The entries of the directory at `path`, without following a final link.
 *  Answers `held` when the directory still has its identity and stamps and
 *  both stamps are older than `RACY_WINDOW_NS` before `held` was read: a
 *  change in the same timestamp tick as that read would leave equal stamps.
 *  Otherwise reads the directory, its stamps first, so an entry added during
 *  the read changes the stamps it answers. `readNs` must be no later than
 *  this call. Throws when `path` cannot be read. */
export function readListing(path: string, held: HeldListing | undefined, readNs: bigint): HeldListing {
  const stats = lstatSync(path, { bigint: true });
  if (held && sameStamps(stats, held) && held.mtimeNs < held.readNs - RACY_WINDOW_NS && held.ctimeNs < held.readNs - RACY_WINDOW_NS) return held;
  const entries = new Map(readdirSync(path, { withFileTypes: true }).map(entry => [entry.name, entryKind(entry)]));
  return { identity: `${stats.dev}:${stats.ino}`, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs, readNs, entries };
}

function sameStamps(stats: BigIntStats, listing: HeldListing): boolean {
  return `${stats.dev}:${stats.ino}` === listing.identity && stats.mtimeNs === listing.mtimeNs && stats.ctimeNs === listing.ctimeNs;
}

export function entryKind(entry: Dirent): EntryKind {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  return entry.isSymbolicLink() ? "link" : "other";
}

export interface MirrorRequest {
  readonly source: string;
  readonly target: string;
  /** Decides each source entry by its parent's source-relative directory and its name. */
  readonly plan: (directory: string, name: string) => MirrorPlan;
  /** Target-relative paths the caller writes itself. The mirror never removes,
   *  replaces, or mirrors over them, and omits a source entry at such a path. */
  readonly generated?: ReadonlySet<string>;
  /** The state the previous mirror into this target returned. */
  readonly prior: MirrorState | undefined;
  /** The state a mirror into `source` answered just before, with nothing
   *  written into `source` since: its listings and file states stand in for
   *  reading the source again. */
  readonly sourceState?: MirrorState;
  /** The start of the take, which decides which files are recent enough to pin. */
  readonly startedNs: bigint;
  /** How a `share` entry is placed: a symlink (a junction on Windows) to the
   *  source entry, or an empty entry of its kind for a mount namespace to bind
   *  the source entry onto. Defaults to `link`. */
  readonly share?: "link" | "bind";
  /** Whether a file that changed within `RACY_WINDOW_NS` of the start, or
   *  that appeared during a whole-directory clone, records the hash of its
   *  cloned bytes. */
  readonly pin: boolean;
  readonly clone: CloneEntry;
  /** Counts what this mirror writes, added to whatever the tally already holds. */
  readonly tally?: MirrorTally;
}

/** Target entries that mirrors cloned or placed again, and target entries they removed. A whole directory cloned in one call counts once. */
export interface MirrorTally {
  recloned: number;
  removed: number;
}

/** Mirrors `request.source` into `request.target` and returns what the target
 *  now holds. The source is only read. Each source file is observed before it
 *  is cloned, so a write between the two leaves a newer source state than the
 *  recorded one, which a landing reads as a conflict. A file is skipped only
 *  when its source state equals the prior record, pinned bytes included, and
 *  its target is the regular file the record names. Throws when an entry
 *  cannot be read, removed, or cloned; the target is then incomplete. */
export function mirrorTree(request: MirrorRequest): MirrorState {
  const { source, target, prior, startedNs } = request;
  const generated = request.generated ?? new Set<string>();
  const tally = request.tally ?? { recloned: 0, removed: 0 };
  const files = new Map<string, MirroredFile>();
  const links = new Map<string, MirroredLink>();
  const shared = new Map<string, SharedPlaceholder>();
  const listings = new Map<string, HeldListing>();
  const directories = new Set<string>();
  const targetEntry = (path: string) => lstatSync(join(target, path), { bigint: true, throwIfNoEntry: false });
  const remove = (path: string): void => {
    rmSync(join(target, path), { recursive: true, force: true, maxRetries: 3 });
    tally.removed += 1;
  };
  const clone: CloneEntry = (from, to, kind) => {
    request.clone(from, to, kind);
    tally.recloned += 1;
  };

  // A file the source no longer holds as a regular file leaves the target as
  // well. `placed` is the target file's stats when the caller just read them.
  const record = (path: string, observed: FileFingerprint | undefined, placed?: BigIntStats): void => {
    const state = observed ?? observeFileState(join(source, path));
    if (state.kind !== "file") {
      remove(path);
      return;
    }
    const stats = placed ?? lstatSync(join(target, path), { bigint: true });
    const racy = !observed || state.mtimeNs >= startedNs - RACY_WINDOW_NS || state.ctimeNs >= startedNs - RACY_WINDOW_NS;
    files.set(path, {
      source: request.pin && racy ? { ...state, sha256: sha256Of(join(target, path)) } : state,
      target: fileFingerprint(stats),
      mode: Number(stats.mode) & PERMISSION_BITS,
    });
  };

  // Each cloned entry is read with `lstat` before it is entered: the source
  // can change kind between its observation and the clone, and a directory
  // that the clone holds as a link must never be read or removed through.
  const adoptClone = (path: string, observedFiles: ReadonlyMap<string, FileFingerprint>, observedLinks: ReadonlyMap<string, string>): void => {
    const cloned = targetEntry(path);
    if (cloned?.isDirectory()) {
      directories.add(path);
      for (const name of readdirSync(join(target, path))) adoptClone(join(path, name), observedFiles, observedLinks);
    } else if (cloned?.isSymbolicLink()) {
      // A link retargeted between its observation and the clone has no
      // observation that matches the clone, so the next mirror replaces it.
      const text = readlinkSync(join(target, path));
      links.set(path, { source: observedLinks.get(path) === text ? text : undefined, target: text });
    } else if (cloned?.isFile()) record(path, observedFiles.get(path), cloned);
  };

  // Every entry below the directory is observed first and cloned after, so the
  // observation precedes the clone for each of them.
  const cloneDirectory = (path: string): void => {
    const observedFiles = new Map<string, FileFingerprint>();
    const observedLinks = new Map<string, string>();
    const observe = (directory: string): void => {
      for (const entry of readdirSync(join(source, directory), { withFileTypes: true })) {
        const child = join(directory, entry.name);
        if (entry.isDirectory()) observe(child);
        else if (entry.isSymbolicLink()) observedLinks.set(child, readlinkSync(join(source, child)));
        else if (entry.isFile()) {
          const state = observeFileState(join(source, child));
          if (state.kind === "file") observedFiles.set(child, state);
        }
      }
    };
    observe(path);
    clone(join(source, path), join(target, path), "directory");
    adoptClone(path, observedFiles, observedLinks);
  };

  const mirrorFile = (path: string): void => {
    const state = request.sourceState?.files.get(path)?.target ?? observeFileState(join(source, path));
    const before = prior?.files.get(path);
    if (state.kind === "file" && before && sameObservedState(state, before.source) && (before.source.sha256 === undefined || sha256Of(join(source, path)) === before.source.sha256)) {
      const existing = targetEntry(path);
      if (existing?.isFile() && sameObservedState(fileFingerprint(existing), before.target)) {
        record(path, state, existing);
        return;
      }
    }
    if (targetEntry(path)) remove(path);
    clone(join(source, path), join(target, path), "file");
    record(path, state.kind === "file" ? state : undefined);
  };

  const mirrorLink = (path: string): void => {
    const text = readlinkSync(join(source, path));
    const before = prior?.links.get(path);
    const existing = targetEntry(path);
    if (before?.source === text && existing?.isSymbolicLink() && readlinkSync(join(target, path)) === before.target) {
      links.set(path, before);
      return;
    }
    if (existing) remove(path);
    symlinkSync(text, join(target, path));
    tally.recloned += 1;
    links.set(path, { source: text, target: readlinkSync(join(target, path)) });
  };

  const placeShared = (path: string, entry: EntryKind): void => {
    const form = request.share ?? "link";
    const kind = form === "link" ? "link" : entry === "file" ? "file" : "directory";
    const before = prior?.shared.get(path);
    const existing = targetEntry(path);
    const placed = before?.kind === kind && existing !== undefined && (before.kind === "link"
      ? existing.isSymbolicLink() && readlinkSync(join(target, path)) === before.target
      : kind === "file" ? existing.isFile() && existing.size === 0n : existing.isDirectory() && readdirSync(join(target, path)).length === 0);
    if (placed) {
      shared.set(path, before);
      return;
    }
    if (existing) remove(path);
    tally.recloned += 1;
    if (kind === "link") {
      symlinkSync(join(source, path), join(target, path), "junction");
      shared.set(path, { kind, target: readlinkSync(join(target, path)) });
      return;
    }
    if (kind === "file") writeFileSync(join(target, path), "", { flag: "wx" });
    else mkdirSync(join(target, path));
    shared.set(path, { kind });
  };

  const mirrorDirectory = (directory: string): void => {
    directories.add(directory);
    // A previous command may have removed write permission from a target
    // directory, which would make the removals below fail.
    if (prior && PERMISSION_BITS) {
      const bits = Number(lstatSync(join(source, directory)).mode) & PERMISSION_BITS;
      if ((Number(lstatSync(join(target, directory)).mode) & PERMISSION_BITS) !== bits) chmodSync(join(target, directory), bits);
    }
    const entries = readListing(join(source, directory), request.sourceState?.listings.get(directory), startedNs).entries;
    const held = readListing(join(target, directory), prior?.listings.get(directory), startedNs);
    const plans = new Map([...entries.keys()].map(name => [name, generated.has(join(directory, name)) ? "omit" : request.plan(directory, name)]));
    // Removals go first, so an old spelling leaves before a case-only rename clones the new one.
    for (const name of held.entries.keys()) {
      const path = join(directory, name);
      if (!generated.has(path) && (plans.get(name) ?? "omit") === "omit") remove(path);
    }
    for (const [name, kind] of entries) {
      const path = join(directory, name);
      const plan = plans.get(name);
      if (plan === "omit") continue;
      if (plan === "share") placeShared(path, kind);
      else if (kind === "directory") {
        const existing = targetEntry(path);
        if (existing?.isDirectory()) mirrorDirectory(path);
        else {
          if (existing) remove(path);
          if (plan === "descend") {
            mkdirSync(join(target, path));
            mirrorDirectory(path);
          } else cloneDirectory(path);
        }
      } else if (kind === "file") mirrorFile(path);
      else if (kind === "link") mirrorLink(path);
      // Sockets, FIFOs, and devices are not copied.
      else if (targetEntry(path)) remove(path);
    }
    // Writes into the directory changed its stamps; a child directory's own writes do not.
    if (sameStamps(lstatSync(join(target, directory), { bigint: true }), held)) listings.set(directory, held);
  };

  mkdirSync(target, { recursive: true });
  mirrorDirectory("");
  return { files, links, shared, listings, directories };
}

function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

let clonefile: ((source: Buffer, destination: Buffer, flags: number) => number) | null | undefined;
/** `<sys/clonefile.h>`: a source that became a link since it was observed is cloned as that link, never as its referent. */
const CLONE_NOFOLLOW = 0x0001;

/** Copies a regular file or a whole directory tree, symlinks as symlinks. On
 *  macOS one `clonefile` call clones a whole tree in the kernel, about a tenth
 *  of the cost of cloning it file by file through Node's copy. A volume
 *  without clones (ENOTSUP) or a copy on another volume (EXDEV) gets a plain
 *  copy instead. Elsewhere a file is cloned where the filesystem can (Linux
 *  FICLONE) and copied where it cannot. */
export const cloneEntry: CloneEntry = (source, destination, kind) => {
  if (process.platform === "darwin") {
    clonefile ??= bindLibc({ clonefile: { args: [FFIType.cstring, FFIType.cstring, FFIType.u32], returns: FFIType.i32 } })?.clonefile ?? null;
    if (clonefile?.(Buffer.from(`${source}\0`), Buffer.from(`${destination}\0`), CLONE_NOFOLLOW) === 0) return;
  }
  if (kind === "file") copyFileSync(source, destination, constants.COPYFILE_FICLONE);
  else cpSync(source, destination, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
};

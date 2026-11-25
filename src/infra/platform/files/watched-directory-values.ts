/** Values derived from the files of one directory, held between changes.
 *
 *  A request path that revalidates a file on every call pays an open, a
 *  read, and a hash each time, and a parallel dispatch of many agents
 *  multiplies that by every request. A watch on the directory already knows when its files
 *  change, so a value derived from them stays correct until its files change.
 *
 *  A directory holds values only while a confirmed watch lease exists for it.
 *  A lease confirms at its watch's first periodic revalidation after the watch
 *  armed, because a platform watch can miss a change made in the first moments
 *  after it arms (observed with FSEvents on macOS). Without a confirmed lease
 *  every read computes, which is the check each caller made before: a
 *  directory whose watch cannot arm, failed, or watches a replaced directory
 *  keeps that check and never a weaker one.
 *
 *  This module owns the freshness of what it holds. A held value records the
 *  identity (device, inode, size, and change times) of each file it derives
 *  from, taken before it was computed. Each periodic revalidation of a lease
 *  compares those identities with the files now, and compares each directory
 *  the path resolves through with the one the lease armed on, so a change that
 *  no watch event reports, such as an edit in place, a replaced directory, or
 *  a symlink in place of a parent, is seen within one revalidation period of
 *  the watch. A revalidation that cannot examine the path ends the hold, so a
 *  failed examination never reaches the timer that runs it. Watch events (`changed`) and writers in
 *  this process (`noteDirectoryChange`, which runs before the writer returns,
 *  so this process never reads its own write stale) are faster paths. */

import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Holding is unproven on Windows: a watch event can name an entry by its 8.3
 *  short name or with backslashes, and NTFS can update times late, so every
 *  read there computes, as each caller did before, until a native Windows run
 *  proves the watch. */
const HOLDS_VALUES = process.platform !== "win32";

/** One derivation's held values, which a directory forgets when an input changes. */
interface Holder {
  /** Whether the value held for `path` derives from the entry `name`, or from any entry when `name` is undefined. */
  reads(path: string, name: string | undefined): boolean;
  /** Whether an input of the value held for `path` has another identity than when the value was computed. */
  stale(path: string): boolean;
  forget(path: string): void;
}

interface WatchedDirectory {
  confirmedLeases: number;
  leases: number;
  readonly holders: Set<Holder>;
}

export interface DirectoryWatchLease {
  /** The watch saw an event for `name`, or for an entry it cannot name: drop the values that read it. */
  changed(name?: string): void;
  /** The watch's periodic revalidation: drops the values whose files changed,
   *  stops holding when a directory on the path changed or cannot be examined,
   *  and confirms the lease at the first call while `watching` states that
   *  the watch armed. It never throws. */
  revalidate(watching: boolean): void;
  /** The watch stopped, failed, or no longer watches the directory at this path. Idempotent. */
  release(): void;
}

/** One value derived from the same files of any directory. */
export interface HeldDirectoryDerivation<T> {
  /** Returns what `compute` derives from the files of `directory` and from
   *  the non-file inputs that `inputs` names. It is computed again after one of
   *  its files changes, when `inputs` differs from the held value's, and on
   *  every call while no confirmed watch holds the directory. A throw is never
   *  held; a returned value that the derivation holds is held until an input
   *  changes, so `compute` must return nothing it holds that can change without one.
   *  Every caller of a held value receives the same object. */
  read(directory: string, compute: () => T, inputs?: string): T;
}

export interface HeldDirectoryDerivationOptions<T> {
  /** Lists more input entries for a directory before each computation. The
   *  identities of the declared files are taken before it lists, so a declared
   *  file that names the listed directory makes a membership change during the
   *  listing drop the value at the next revalidation. */
  readonly listed?: (directory: string) => readonly string[];
  /** Whether a computed value is held. A value that depends on state the file
   *  identities do not show, such as a refusal, is not held. Default: every value. */
  readonly holds?: (value: T) => boolean;
}

const directories = new Map<string, WatchedDirectory>();

function forgetWhere(path: string, entry: WatchedDirectory, test: (holder: Holder) => boolean): void {
  for (const holder of entry.holders) {
    if (!test(holder)) continue;
    holder.forget(path);
    entry.holders.delete(holder);
  }
}

/** The identity of each component that `path` resolves through, from the
 *  root to `path` itself, so a replaced parent or a symlink in its place
 *  differs. Undefined when a component cannot be examined or `path` is no directory. */
function containmentIdentity(path: string): string | undefined {
  try {
    const identities: string[] = [];
    for (let component = path; ; component = dirname(component)) {
      const stats = lstatSync(component, { throwIfNoEntry: false });
      if (stats === undefined || (component === path && !stats.isDirectory())) return undefined;
      identities.push(`${stats.dev}:${stats.ino}`);
      if (dirname(component) === component) return identities.join("/");
    }
  } catch {
    return undefined;
  }
}

/** An entry that cannot be examined has the identity of an absent one. */
function fileIdentity(directory: string, name: string): string {
  try {
    const stats = lstatSync(join(directory, name), { throwIfNoEntry: false });
    return stats === undefined ? "" : `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
  } catch {
    return "";
  }
}

/** Starts one watch's claim on `directory`. Reads hold nothing until the lease confirms. */
export function leaseDirectoryWatch(directory: string): DirectoryWatchLease {
  const path = resolve(directory);
  const armed = containmentIdentity(path);
  const entry = directories.get(path) ?? { confirmedLeases: 0, leases: 0, holders: new Set<Holder>() };
  directories.set(path, entry);
  entry.leases += 1;
  let state: "pending" | "confirmed" | "released" = "pending";
  const release = (): void => {
    if (state === "released") return;
    if (state === "confirmed") entry.confirmedLeases -= 1;
    state = "released";
    entry.leases -= 1;
    forgetWhere(path, entry, () => true);
    if (entry.leases === 0) directories.delete(path);
  };
  return {
    changed: (name) => { if (state !== "released") forgetWhere(path, entry, (holder) => holder.reads(path, name)); },
    revalidate: (watching) => {
      if (state === "released") return;
      if (armed === undefined || containmentIdentity(path) !== armed) {
        release();
        return;
      }
      forgetWhere(path, entry, (holder) => holder.stale(path));
      if (state !== "pending" || !watching || !HOLDS_VALUES) return;
      state = "confirmed";
      entry.confirmedLeases += 1;
    },
    release,
  };
}

/** A writer in this process changed the entry `name` of `directory`, or
 *  entries it does not name. Call it after the write, before the writer returns. */
export function noteDirectoryChange(directory: string, name?: string): void {
  const path = resolve(directory);
  const entry = directories.get(path);
  if (entry !== undefined) forgetWhere(path, entry, (holder) => holder.reads(path, name));
}

/** Declares one derivation from `files`, entry names relative to the
 *  directory. Every caller of one derivation must compute the same thing. */
export function heldDirectoryDerivation<T>(files: readonly string[], options: HeldDirectoryDerivationOptions<T> = {}): HeldDirectoryDerivation<T> {
  const values = new Map<string, { readonly value: T; readonly inputs: string; readonly identities: ReadonlyMap<string, string> }>();
  const holder: Holder = {
    reads: (path, name) => name === undefined || (values.get(path)?.identities.has(name) ?? false),
    stale: (path) => [...values.get(path)?.identities ?? []].some(([name, identity]) => fileIdentity(path, name) !== identity),
    forget: (path) => { values.delete(path); },
  };
  return {
    read: (directory, compute, inputs = "") => {
      const path = resolve(directory);
      const entry = directories.get(path);
      if (entry === undefined || entry.confirmedLeases === 0) return compute();
      const held = values.get(path);
      if (held !== undefined && held.inputs === inputs) return held.value;
      // Taken before the computation, so a file that changes while it reads is computed again.
      const identities = new Map(files.map((name) => [name, fileIdentity(path, name)]));
      for (const name of options.listed?.(path) ?? []) identities.set(name, fileIdentity(path, name));
      const value = compute();
      if (options.holds?.(value) === false) {
        values.delete(path);
        return value;
      }
      values.set(path, { value, inputs, identities });
      entry.holders.add(holder);
      return value;
    },
  };
}

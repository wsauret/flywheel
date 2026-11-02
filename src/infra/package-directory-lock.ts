/** Exclusion of one managed package's directory, in this process and across
 * processes. The durable lock is held inside a contained `.locks` directory,
 * so every lock operation stays below the store that owns the package.
 *
 * Writers hold the lock exclusively. Readers hold it shared: a reader takes the
 * lock only long enough to register itself beside it, so many readers of one
 * package run at once, and a writer waits until every registered reader has
 * left. A reader's work is complete when it leaves, so a writer that holds the
 * lock sees everything that every earlier reader recorded. */

import { basename, dirname } from "node:path";
import { ContainedDirectory } from "./descriptor-directory.js";
import { canonicalMutationPath, queuedMutationsSettled, withFileMutationQueues } from "./file-mutation-queue.js";
import {
  acquireDrainedGateIn,
  liveSharedHoldersIn,
  registerSharedHolderIn,
  releaseLockIn,
  releaseSharedHolderIn,
  tryAcquireLockSyncIn,
  withLockIn,
  type LockHold,
} from "./ownership-file-lock.js";

export async function withPackageLocks<T>(packageDirs: readonly string[], fn: () => Promise<T>): Promise<T> {
  const ordered = canonicalPackageDirs(packageDirs);
  return withFileMutationQueues(ordered, () => withDurableLocks(ordered, fn));
}

/** Run `fn` as one shared reader of `packageDir`. It waits for the writers
 *  that hold or wait for the package, but never for other readers. */
export async function withPackageRead<T>(packageDir: string, fn: () => Promise<T>): Promise<T> {
  const dir = canonicalMutationPath(packageDir);
  await queuedMutationsSettled(dir);
  const directory = openLockDirectory(dir);
  try {
    const gate = lockName(dir);
    // The lock is held only while the reader registers, released before the
    // reader yields, so readers of one package never find it held by each other.
    const shared = await withLockIn(directory, gate, () => registerSharedHolderIn(directory, gate));
    try {
      return await fn();
    } finally {
      releaseSharedHolderIn(directory, shared);
    }
  } finally {
    directory.close();
  }
}

async function withDurableLocks<T>(ordered: readonly string[], fn: () => Promise<T>): Promise<T> {
  const held: Array<{ readonly directory: ContainedDirectory; readonly hold: LockHold }> = [];
  try {
    for (const dir of ordered) {
      const directory = openLockDirectory(dir);
      try {
        const hold = await acquireDrainedGateIn(directory, lockName(dir));
        held.push({ directory, hold });
      } catch (error) {
        directory.close();
        throw error;
      }
    }
    return await fn();
  } finally {
    for (const { directory, hold } of held.toReversed()) {
      releaseLockIn(directory, hold);
      directory.close();
    }
  }
}

/** One attempt at every package lock, with no waiting. A package that a reader
 *  still holds counts as held. */
export function tryWithPackageLocksSync(packageDirs: readonly string[], fn: () => void): boolean {
  const ordered = canonicalPackageDirs(packageDirs);
  const held: Array<{ readonly directory: ContainedDirectory; readonly hold: LockHold }> = [];
  try {
    for (const dir of ordered) {
      const directory = openLockDirectory(dir);
      let hold: LockHold | undefined;
      try {
        hold = tryAcquireLockSyncIn(directory, lockName(dir));
        if (hold !== undefined && liveSharedHoldersIn(directory, hold.name) > 0) {
          releaseLockIn(directory, hold);
          hold = undefined;
        }
      } finally {
        if (hold === undefined) directory.close();
      }
      if (hold === undefined) return false;
      held.push({ directory, hold });
    }
    fn();
    return true;
  } finally {
    for (const { directory, hold } of held.toReversed()) {
      releaseLockIn(directory, hold);
      directory.close();
    }
  }
}

function lockName(packageDir: string): string {
  return `${basename(packageDir)}.lock`;
}

function openLockDirectory(packageDir: string): ContainedDirectory {
  const missing: string[] = [".locks"];
  let ancestor = dirname(packageDir);
  for (;;) {
    const held = ContainedDirectory.openExisting(ancestor, []);
    if (held) {
      let current = held;
      try {
        for (const component of missing) {
          const child = current.openChild(component, { privateDirectories: true });
          current.close();
          current = child;
        }
        return current;
      } catch (error) {
        current.close();
        throw error;
      }
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`no existing ancestor contains ${packageDir}`);
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
}

function canonicalPackageDirs(packageDirs: readonly string[]): string[] {
  return [...new Set(packageDirs.map(canonicalMutationPath))].sort((a, b) => a.localeCompare(b));
}

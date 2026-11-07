/** Replacing one file by a rename on Windows.
 *
 *  Windows refuses a replacing rename while another process has the target
 *  open, even a reader that shares delete access, and it refuses to rename a
 *  file that a process holds without delete sharing. Both refusals are
 *  sharing refusals (`EPERM`, `EACCES`, `EBUSY`) that clear once the other
 *  process lets go. Two replacements answer them:
 *
 *  - `replaceFileOnWindows` publishes a regular file, such as a config or a
 *    record. It retries briefly, and when the refusal lasts it renames the
 *    old file aside, publishes, and deletes the aside copy, because a moment
 *    without the file is acceptable for a file that is rewritten whole.
 *  - `renameThroughSharing` never moves the target aside. It retries for a
 *    bounded time and then fails with the target unchanged. It is the rename
 *    of a pointer a launch reads, where a moment with no pointer is a launch
 *    that finds no build, and of an executable a process may hold. */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { errnoCode } from "./error-message.js";

const MAX_RENAME_ATTEMPTS = 5;
const RETRY_DELAY_MS = 25;
const SHARING_REFUSALS: ReadonlySet<string> = new Set(["EACCES", "EBUSY", "EPERM"]);

/** How long `renameThroughSharing` retries, and its pause between attempts.
 *  Probes on Windows 11 saw a quarter of pointer renames refused while a
 *  reader held the pointer, and none refused for longer than one read. */
const SHARING_RETRY_BOUND_MS = 2_000;
const SHARING_RETRY_STEP_MS = 5;

interface WindowsFileReplacementStat {
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface WindowsFileReplacementOperations {
  readonly rename: (sourcePath: string, targetPath: string) => void;
  readonly unlink: (targetPath: string) => void;
  /** Must not follow a link at the target name. */
  readonly lstat: (targetPath: string) => WindowsFileReplacementStat;
  readonly delay: (milliseconds: number) => void;
}

const pause = (milliseconds: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); };

const defaultOperations: WindowsFileReplacementOperations = {
  rename: (sourcePath, targetPath) => { fs.renameSync(sourcePath, targetPath); },
  unlink: (targetPath) => { fs.unlinkSync(targetPath); },
  lstat: (targetPath) => fs.lstatSync(targetPath),
  delay: pause,
};

/** Whether `error` is Windows refusing a rename or a deletion because
 *  another process holds the file: a refusal that clears by itself. */
export function isSharingRefusal(error: unknown): boolean {
  const code = errnoCode(error);
  return code !== undefined && SHARING_REFUSALS.has(code);
}

/** Replace `targetPath` with `sourcePath` on Windows. A rename is retried
 *  only when the failure is a sharing refusal and the current target is a
 *  regular file. After the fixed retry bound, a fresh proof that the target
 *  is a regular file is required before it is renamed aside. Every other
 *  failure is thrown without changing the target. */
export function replaceFileOnWindows(sourcePath: string, targetPath: string, operations: WindowsFileReplacementOperations = defaultOperations): void {
  let attempt = 0;
  while (true) {
    try {
      operations.rename(sourcePath, targetPath);
      return;
    } catch (error) {
      if (!isSharingRefusal(error)) throw error;
      if (!isRegularTarget(operations, targetPath)) throw error;
      if (attempt === MAX_RENAME_ATTEMPTS - 1) {
        if (!isRegularTarget(operations, targetPath)) throw error;
        replaceThroughAside(sourcePath, targetPath, operations);
        return;
      }
      attempt += 1;
      operations.delay(RETRY_DELAY_MS);
    }
  }
}

function replaceThroughAside(sourcePath: string, targetPath: string, operations: WindowsFileReplacementOperations): void {
  const asidePath = `${targetPath}.__flywheel-replaced__.${process.pid}.${crypto.randomBytes(3).toString("hex")}`;
  operations.rename(targetPath, asidePath);
  try {
    operations.rename(sourcePath, targetPath);
  } catch (error) {
    operations.rename(asidePath, targetPath);
    throw error;
  }
  try {
    operations.unlink(asidePath);
  } catch {
    // The replacement is published; stale aside cleanup is best effort.
  }
}

function isRegularTarget(operations: WindowsFileReplacementOperations, targetPath: string): boolean {
  try {
    const stats = operations.lstat(targetPath);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/** The rename, clock, and pause one bounded rename uses, so a test can stand
 *  in for a Windows reader that holds the file open. */
export interface SharingRetryOperations {
  readonly rename: (from: string, to: string) => void;
  readonly nowMs: () => number;
  readonly pause: (ms: number) => void;
}

const systemSharingRetry: SharingRetryOperations = {
  rename: (from, to) => { fs.renameSync(from, to); },
  nowMs: () => Date.now(),
  pause,
};

/** Rename `from` to `to`, retrying a sharing refusal until the bound. Any
 *  other failure, and a refusal that outlasts the bound, is thrown with both
 *  names as they were. The target is never moved aside. */
export function renameThroughSharing(from: string, to: string, operations: SharingRetryOperations = systemSharingRetry): void {
  const deadline = operations.nowMs() + SHARING_RETRY_BOUND_MS;
  for (;;) {
    try {
      operations.rename(from, to);
      return;
    } catch (error) {
      if (!isSharingRefusal(error) || operations.nowMs() >= deadline) throw error;
    }
    operations.pause(SHARING_RETRY_STEP_MS);
  }
}

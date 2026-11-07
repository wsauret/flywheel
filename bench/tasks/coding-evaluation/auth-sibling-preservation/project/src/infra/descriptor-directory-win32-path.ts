import * as fs from "node:fs";
import * as path from "node:path";

import { replaceFileOnWindows } from "./windows-file-replacement.js";
import { ContainedPathError, type ContainedDirectoryOptions, validateComponent } from "./descriptor-directory-contract.js";
import { errnoCode } from "./error-message.js";
import type { WindowsPrivateDirectoryAclPort } from "./windows-private-directory-acl.js";

const DIRECTORY_MODE = 0o700;
export const FILE_MODE = 0o600;
/** A link is one short relative path. The Windows launcher reads at most this
 *  many bytes of the pointer, and a longer file is not a pointer. */
export const POINTER_MAX_BYTES = 4096;

export function isMissing(error: unknown): boolean {
  return errnoCode(error) === "ENOENT";
}

export function isReparse(stats: fs.Stats): boolean {
  return stats.isSymbolicLink();
}

export function pathError(message: string, cause?: unknown): ContainedPathError {
  return cause === undefined ? new ContainedPathError(message) : new ContainedPathError(message, { cause });
}

export function validateWindowsComponent(name: string): void {
  validateComponent(name);
  if (name.includes("\\") || name.includes(":") || path.win32.isAbsolute(name)) {
    throw new Error(`a contained Windows operation takes one relative component, not ${JSON.stringify(name)}`);
  }
}

export function relativeTargetComponents(target: string): readonly string[] {
  if (target === "" || target.includes("\\") || target.includes("\0") || path.win32.isAbsolute(target) || target.includes(":")) {
    throw new Error(`a contained link names a relative Windows child, not ${JSON.stringify(target)}`);
  }
  const components = target.split("/");
  if (Buffer.byteLength(target, "utf8") > POINTER_MAX_BYTES || components.some((component) => component === "" || component === "." || component === "..")) {
    throw new Error(`a contained link names a bounded relative child, not ${JSON.stringify(target)}`);
  }
  for (const component of components) validateWindowsComponent(component);
  return components;
}

export function unlinkIfPresent(entryPath: string): void {
  try {
    fs.unlinkSync(entryPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export function writeAll(fd: number, chunk: Uint8Array): void {
  let offset = 0;
  while (offset < chunk.byteLength) offset += fs.writeSync(fd, chunk, offset, chunk.byteLength - offset);
}

export function writeAndClose(fd: number, content: string, mode: number): void {
  try {
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** A symlink or a junction: a reparse point this backend never follows. */
export function isLinkEntry(stats: fs.Stats): boolean {
  return stats.isSymbolicLink();
}

/** Refuses anything at this name that is not the regular file the container owns, and names a link as a link. */
export function requireRegularFile(stats: fs.Stats, subject: string): void {
  if (isLinkEntry(stats)) throw pathError(`the contained ${subject} is a symlink or junction`);
  if (!stats.isFile()) throw pathError(`the contained ${subject} is not a regular file`);
}

/** Windows has no portable directory fsync boundary; file fsync is the durability boundary. */
export function publishRegularFile(pendingPath: string, targetPath: string): void {
  replaceFileOnWindows(pendingPath, targetPath);
}

export function removeTreePath(entryPath: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(entryPath);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (isReparse(stats) || !stats.isDirectory()) {
    fs.unlinkSync(entryPath);
    return;
  }
  for (const child of fs.readdirSync(entryPath)) removeTreePath(path.join(entryPath, child));
  try {
    fs.rmdirSync(entryPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function openDirectoryPath(directoryPath: string, noFollow: boolean): string {
  const absolute = path.resolve(directoryPath);
  const named = fs.lstatSync(absolute);
  if (noFollow && isReparse(named)) throw pathError(`the contained directory is a symlink or junction: ${absolute}`);
  const actual = fs.statSync(absolute);
  if (!actual.isDirectory()) throw pathError(`the contained path is not a directory: ${absolute}`);
  return fs.realpathSync(absolute);
}

export function openBase(baseDir: string, options: ContainedDirectoryOptions): string {
  return openDirectoryPath(baseDir, options.noFollowBase === true);
}

function warnPrivateAclFailure(directory: string, error: unknown): void {
  void import("./log.js")
    .then(({ Log }) => { Log.create({ service: "descriptor-directory-win32" }).warn("Windows private directory ACL was not applied", { directory, error }); })
    .catch(() => {});
}

export function openChildPath(
  parentPath: string,
  name: string,
  create: boolean,
  privateDirectory: boolean,
  privateRoot: boolean,
  applyPrivateDirectoryAcl: WindowsPrivateDirectoryAclPort,
): string | undefined {
  validateWindowsComponent(name);
  const childPath = path.join(parentPath, name);
  let stats: fs.Stats;
  let created = false;
  try {
    stats = fs.lstatSync(childPath);
  } catch (error) {
    if (!isMissing(error) || !create) {
      if (isMissing(error)) return undefined;
      throw pathError(`the contained child cannot be inspected: ${name}`, error);
    }
    try {
      fs.mkdirSync(childPath, { mode: DIRECTORY_MODE });
      created = true;
    } catch (raceError) {
      if (errnoCode(raceError) !== "EEXIST") throw pathError(`the contained child cannot be created: ${name}`, raceError);
    }
    stats = fs.lstatSync(childPath);
  }
  if (isReparse(stats)) throw pathError(`the contained child is a symlink or junction: ${name}`);
  if (!stats.isDirectory()) throw pathError(`the contained child is not a directory: ${name}`);
  if (privateDirectory) fs.chmodSync(childPath, DIRECTORY_MODE);
  if (created && privateRoot) {
    try {
      applyPrivateDirectoryAcl(childPath);
    } catch (error) {
      warnPrivateAclFailure(childPath, error);
    }
  }
  return fs.realpathSync(childPath);
}

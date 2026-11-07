/** Private-by-construction storage paths: a directory tree only its owner may
 *  enter, and final files only its owner may read.
 *
 *  The directory guarantee is descriptor-rooted: every component below the
 *  trusted base is created and opened relative to its parent's descriptor and
 *  never followed through a symlink (see write-file-under.ts), so a component
 *  replaced between the admission and the mode change cannot redirect either.
 *
 *  A final file is admitted by opening it with `O_NOFOLLOW` and acting on that
 *  descriptor. An `lstat` followed by a path-based `chmod` is two resolutions of
 *  one name, and the second need not be the file the first measured; and a
 *  reader handed a name that is a link would follow it out of the workspace
 *  before any check of ours ran.
 *
 *  Windows offers no `O_NOFOLLOW`, so the same refusal is stated there by
 *  naming the link before the open. A check and then an open is weaker than one
 *  atomic open, and it is what the platform gives: on POSIX the atomic open
 *  still stands behind it. */

import { closeSync, constants, fstatSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { applyWindowsPrivateDirectoryAcl, applyWindowsPrivateDirectoryAclAsync, type WindowsPrivateDirectoryAclPort, type WindowsPrivateDirectoryAclAsyncPort } from "./windows-private-directory-acl.js";
import { ensureDirectoryUnder } from "./write-file-under.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export interface PrivateRootDirectoryOptions {
  readonly platform?: NodeJS.Platform;
  readonly windowsAcl?: WindowsPrivateDirectoryAclPort;
}

/** Every open of a final file this module admits: the file itself, never a link
 *  at its name, and never a wait for a writer of a named pipe put in its place. */
const ADMIT_FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const CREATE_FILE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/** Create one private directory this process owns, its parents included. This is
 *  for a root whose own parents need not exist yet, such as a learning store the
 *  first write beside it creates. The tree below a root is created with
 *  `ensurePrivateDirectoryUnder`, which follows no link. Windows protection is
 *  enforced on every admission. Filesystem and ACL errors throw. */
export function ensurePrivateRootDirectory(dir: string, options: PrivateRootDirectoryOptions = {}): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if ((options.platform ?? process.platform) !== "win32") return;
  refuseLinkAt(dir);
  (options.windowsAcl ?? applyWindowsPrivateDirectoryAcl)(dir);
}

/** Admit a private root with async creation and Windows identity lookup. Filesystem and ACL errors reject. POSIX permissions of existing roots are unchanged. */
export async function ensurePrivateRootDirectoryAsync(
  dir: string,
  options: { readonly platform?: NodeJS.Platform; readonly windowsAcl?: WindowsPrivateDirectoryAclAsyncPort } = {},
): Promise<void> {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if ((options.platform ?? process.platform) !== "win32") return;
  refuseLinkAt(dir);
  await (options.windowsAcl ?? applyWindowsPrivateDirectoryAclAsync)(dir);
}

/** Create or tighten a private directory tree below a trusted base without
 *  following links, and return the directory it names. */
export function ensurePrivateDirectoryUnder(baseDir: string, relativeDir: string): string {
  const resolvedBase = resolve(baseDir);
  const target = resolve(resolvedBase, relativeDir);
  const withinBase = relative(resolvedBase, target);
  if (withinBase === ".." || withinBase.startsWith(`..${sep}`) || isAbsolute(withinBase)) {
    throw new Error(`private directory escapes its trusted root: ${relativeDir}`);
  }
  const components = withinBase.split(sep).filter(Boolean);
  ensureDirectoryUnder(resolvedBase, components.length === 0 ? "." : components.join("/"), { privateDirectories: true });
  return target;
}

/** Create one private regular file, or tighten the one already there. */
export function ensurePrivateFile(filePath: string): void {
  if (admitPrivateFileIfPresent(filePath)) return;
  let fd: number;
  try {
    fd = openSync(filePath, CREATE_FILE_FLAGS, PRIVATE_FILE_MODE);
  } catch (error) {
    // Another process or Worker created the file between the admission and
    // this exclusive create; the file it made is admitted like any other.
    if (isErrnoCode(error, "EEXIST") && admitPrivateFileIfPresent(filePath)) return;
    throw error;
  }
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Admit one final file as a private regular file, and report whether it was
 *  there at all. A symlink or a non-regular file at that name is refused: it is
 *  not the file this workspace owns, and no reader may be handed it. A caller
 *  that already holds the file's directory open admits an entry of that
 *  descriptor instead (see descriptor-directory.ts). */
function admitPrivateFileIfPresent(filePath: string): boolean {
  refuseLinkAt(filePath);
  let fd: number;
  try {
    fd = openSync(filePath, ADMIT_FILE_FLAGS);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return false;
    if (isErrnoCode(error, "ELOOP")) throw new Error(`private file is a symlink: ${filePath}`, { cause: error });
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`private file is not a regular file: ${filePath}`);
    fchmodSync(fd, PRIVATE_FILE_MODE);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Admit one SQLite database and the sidecars beside it before any reader opens
 *  them. SQLite follows the names it is handed, so a link at the database, the
 *  write-ahead log, or the shared-memory file must be refused before it can:
 *  every file it will read, and every file it will replace, is admitted here. */
export function admitPrivateDatabaseFiles(dbFile: string): void {
  for (const file of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) admitPrivateFileIfPresent(file);
}

/** Refuses a link at this exact name. It is what states the refusal where the
 *  open cannot: `O_NOFOLLOW` exists only on POSIX, and a Windows open follows a
 *  reparse point at the final component. */
function refuseLinkAt(filePath: string): void {
  let entry;
  try {
    entry = lstatSync(filePath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return;
    throw error;
  }
  if (entry.isSymbolicLink()) throw new Error(`private file is a symlink: ${filePath}`);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
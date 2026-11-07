/** POSIX implementation of the contained-directory contract. Native descriptor
 * calls and their buffers stay here so the public boundary has no POSIX state. */

import { FFIType } from "bun:ffi";
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, openSync, readFileSync, realpathSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { bindLibc, libcError, NO_LIBC_REASON } from "./libc.js";
import { openAt } from "./open-at.js";
import { readDirAt, type DirectoryEntry } from "./read-dir-at.js";
import {
  ContainedFileTooLargeError,
  ContainedPathError,
  type ContainedDirectoryBackend,
  type ContainedDirectoryContract,
  type ContainedDirectoryOptions,
  type ContainedOwnedFile,
  type ContainedFileMetadata,
  type ContainedFileSnapshot,
  type ContainedRegularFileEntry,
  type FileMutationAttemptResult,
  type ContainedStreamOptions,
  sameFileSnapshot,
} from "./descriptor-directory-contract.js";
import { componentBuffer } from "./descriptor-directory-posix-component.js";

/** The base is opened as a directory and read-only; a symlink at its own final
 * component is followed. */
const BASE_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY;

/** A base whose own final component Flywheel owns: a directory, and never a link. */
const BASE_NOFOLLOW_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** Every component below the base: a directory, and never a link. */
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;

/** A file this module creates: by this call or not at all, and never through a
 * link. */
const NEW_FILE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/** Every open of an existing entry this module admits: the entry itself, never
 * a link at its name, and never a wait for the writer of a named pipe put in its
 * place. */
const EXISTING_ENTRY_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/** `AT_REMOVEDIR`, which selects the directory half of `unlinkat`. The value is
 * the platform's, not one constant: darwin numbers it 0x080 and Linux 0x200. */
const AT_REMOVEDIR = process.platform === "darwin" ? 0x080 : 0x200;

interface DescriptorCalls {
  openat(dirFd: number, name: Buffer, flags: number, mode: number): number;
  mkdirat(dirFd: number, name: Buffer, mode: number): number;
  renameat(oldDirFd: number, oldName: Buffer, newDirFd: number, newName: Buffer): number;
  linkat(oldDirFd: number, oldName: Buffer, newDirFd: number, newName: Buffer, flags: number): number;
  symlinkat(target: Buffer, dirFd: number, name: Buffer): number;
  unlinkat(dirFd: number, name: Buffer, flags: number): number;
}

let calls: DescriptorCalls | null | undefined;

function descriptorCalls(): DescriptorCalls {
  if (calls === undefined) {
    calls = bindLibc({
      openat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
      mkdirat: { args: [FFIType.i32, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
      renameat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring], returns: FFIType.i32 },
      linkat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
      symlinkat: { args: [FFIType.cstring, FFIType.i32, FFIType.cstring], returns: FFIType.i32 },
      unlinkat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
    }) ?? null;
  }
  if (calls === null) throw new Error(NO_LIBC_REASON);
  return calls;
}

function escapeFailure(err: unknown, stage?: string): Error {
  const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
  const errno = typeof err === "object" && err !== null && "errno" in err ? err.errno : undefined;
  const operation = typeof err === "object" && err !== null && "operation" in err ? err.operation : undefined;
  const flags = typeof err === "object" && err !== null && "flags" in err ? err.flags : undefined;
  const diagnostic = [
    `code=${String(code ?? "unknown")}`,
    ...(typeof errno === "number" ? [`errno=${errno}`] : []),
    ...(typeof operation === "string" ? [`operation=${operation}`] : []),
    ...(typeof flags === "number" ? [`flags=${flags}`] : []),
    ...(stage ? [`stage=${stage}`] : []),
  ].join(", ");
  const fields = { code, errno, operation, flags, stage };
  if (code === "ELOOP" || code === "ENOTDIR" || code === "EISDIR") {
    return Object.assign(
      new ContainedPathError(`the operation escapes its trusted root: a symlink or non-directory holds part of its path (${diagnostic})`, { cause: err }),
      fields,
    );
  }
  return Object.assign(new Error(`the contained operation cannot open part of its path (${diagnostic})`, { cause: err }), fields);
}

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

/** Apply the private-directory mode while this function still owns `fd`. A mode
 * failure must not strand the descriptor in a failed walk. */
function admitDirectoryFd(fd: number, privateDirectory: boolean): number {
  try {
    if (privateDirectory) fchmodSync(fd, DIRECTORY_MODE);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Open one directory below `parent`, creating it when absent. A component that
 * is a symlink or a non-directory fails: it is not this directory's entry. */
function openDirectoryAt(parent: number, name: string, privateDirectory: boolean): number {
  try {
    return admitDirectoryFd(openAt(parent, name, DIRECTORY_FLAGS), privateDirectory);
  } catch (err) {
    if (!isErrnoCode(err, "ENOENT")) throw escapeFailure(err, "open-child-initial");
  }
  const libc = descriptorCalls();
  if (libc.mkdirat(parent, componentBuffer(name), DIRECTORY_MODE) < 0) {
    const failure = libcError("mkdirat");
    if (!isErrnoCode(failure, "EEXIST")) throw escapeFailure(failure, "mkdir-child");
  }
  try {
    return admitDirectoryFd(openAt(parent, name, DIRECTORY_FLAGS), privateDirectory);
  } catch (err) {
    throw escapeFailure(err, "open-child-after-mkdir");
  }
}

function openExistingDirectoryAt(parent: number, name: string, privateDirectory: boolean): number | undefined {
  try {
    return admitDirectoryFd(openAt(parent, name, DIRECTORY_FLAGS), privateDirectory);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return undefined;
    throw escapeFailure(err, "open-existing-child");
  }
}

/** Resolve filesystem entries whose directory stream reports no useful type. */
export function isDirectoryEntryAt(parent: number, entry: DirectoryEntry): boolean {
  if (entry.type === "directory") return true;
  if (entry.type !== "other") return false;
  let fd: number;
  try {
    fd = openAt(parent, entry.name, DIRECTORY_FLAGS);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT") || isErrnoCode(err, "ENOTDIR") || isErrnoCode(err, "ELOOP")) return false;
    throw escapeFailure(err, "classify-directory-entry");
  }
  closeSync(fd);
  return true;
}

function regularFileEntryAt(parent: number, entry: DirectoryEntry): ContainedRegularFileEntry | undefined {
  if (entry.type === "directory" || entry.type === "symlink") return undefined;
  let fd: number;
  try {
    fd = openAt(parent, entry.name, EXISTING_ENTRY_FLAGS);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT") || isErrnoCode(err, "ENOTDIR") || isErrnoCode(err, "ELOOP")) return undefined;
    throw escapeFailure(err, "classify-regular-file-entry");
  }
  try {
    const stats = fstatSync(fd);
    return stats.isFile()
      ? { name: entry.name, createdAt: stats.birthtimeMs, updatedAt: stats.mtimeMs }
      : undefined;
  } finally {
    closeSync(fd);
  }
}

/** Walk every directory component below one base descriptor, closing what the
 * walk already owns when a component fails. `create` decides whether a missing
 * component is created or reported as absent. */
function walk(baseFd: number, dirs: readonly string[], privateDirectory: boolean, create: boolean): number | undefined {
  let parent = baseFd;
  let owned = false;
  for (const component of dirs) {
    let child: number | undefined;
    try {
      child = create
        ? openDirectoryAt(parent, component, privateDirectory)
        : openExistingDirectoryAt(parent, component, privateDirectory);
    } catch (err) {
      if (owned) closeSync(parent);
      throw err;
    }
    if (child === undefined) {
      if (owned) closeSync(parent);
      return undefined;
    }
    if (owned) closeSync(parent);
    parent = child;
    owned = true;
  }
  return parent;
}

/** One POSIX directory held open for the length of one window. */
class PosixContainedDirectory implements ContainedDirectoryContract {
  readonly #fd: number;
  readonly #path: string;
  #canonicalPath: string | undefined;

  private constructor(fd: number, path: string, canonicalPath?: string) {
    this.#fd = fd;
    this.#path = path;
    this.#canonicalPath = canonicalPath;
  }

  /** Hold the directory at `dirs` below `baseDir`, creating missing components. */
  static open(baseDir: string, dirs: readonly string[], options: ContainedDirectoryOptions): PosixContainedDirectory {
    const path = join(resolve(baseDir), ...dirs);
    if (dirs.length === 0) return new PosixContainedDirectory(openBase(baseDir, options), path);
    return new PosixContainedDirectory(withBaseFd(baseDir, options, (baseFd) => {
      const fd = walk(baseFd, dirs, options.privateDirectories === true, true);
      if (fd === undefined) throw new Error("a created contained directory cannot be absent");
      return fd;
    }), path);
  }

  /** Hold the directory at `dirs` below `baseDir` when it is already there. */
  static openExisting(baseDir: string, dirs: readonly string[], options: ContainedDirectoryOptions): PosixContainedDirectory | undefined {
    const base = PosixContainedDirectory.#openBaseIfPresent(baseDir, options);
    if (!base || dirs.length === 0) return base;
    try {
      const fd = walk(base.#fd, dirs, options.privateDirectories === true, false);
      return fd === undefined ? undefined : new PosixContainedDirectory(fd, join(base.#path, ...dirs));
    } finally {
      base.close();
    }
  }

  static #openBaseIfPresent(baseDir: string, options: ContainedDirectoryOptions): PosixContainedDirectory | undefined {
    try {
      return new PosixContainedDirectory(openBase(baseDir, options), resolve(baseDir));
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return undefined;
      throw escapeFailure(err, "open-base");
    }
  }

  openChild(name: string, options: ContainedDirectoryOptions = {}): PosixContainedDirectory {
    return new PosixContainedDirectory(openDirectoryAt(this.#fd, name, options.privateDirectories === true), join(this.#path, name));
  }

  openExistingChild(name: string): PosixContainedDirectory | undefined {
    const fd = openExistingDirectoryAt(this.#fd, name, false);
    return fd === undefined ? undefined : new PosixContainedDirectory(fd, join(this.#path, name));
  }

  readFile(name: string, maxBytes: number): Buffer | undefined {
    return this.readOwnedFile(name, maxBytes)?.content;
  }

  readOwnedFile(name: string, maxBytes: number): ContainedOwnedFile | undefined {
    let fd: number;
    try {
      fd = openAt(this.#fd, name, EXISTING_ENTRY_FLAGS);
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return undefined;
      throw escapeFailure(err);
    }
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile()) throw new ContainedPathError("the contained read target is not a regular file");
      if (stats.size > maxBytes) throw new ContainedFileTooLargeError(maxBytes);
      return { content: readFileSync(fd), linkCount: stats.nlink, executable: (stats.mode & 0o111) !== 0 };
    } finally {
      closeSync(fd);
    }
  }

  readFileSnapshot(name: string, maxBytes: number): ContainedFileSnapshot | undefined {
    let fd: number;
    try {
      fd = openAt(this.#fd, name, EXISTING_ENTRY_FLAGS);
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return undefined;
      throw escapeFailure(err);
    }
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile()) throw new ContainedPathError("the contained read target is not a regular file");
      if (stats.size > maxBytes) throw new ContainedFileTooLargeError(maxBytes);
      const content = readFileSync(fd);
      if (content.byteLength > maxBytes) throw new ContainedFileTooLargeError(maxBytes);
      return {
        content,
        identity: `${stats.dev}:${stats.ino}`,
        linkCount: stats.nlink,
        executable: (stats.mode & 0o111) !== 0,
        metadata: { kind: "posix", mode: stats.mode & 0o777 },
      };
    } finally {
      closeSync(fd);
    }
  }

  writeFile(name: string, content: string): Error | undefined {
    componentBuffer(name);
    const expected = this.readFileSnapshot(name, Number.MAX_SAFE_INTEGER);
    const result = this.publishFileBytesThrough(`.flywheel-write.${process.pid}.${randomBytes(6).toString("hex")}`, name, Buffer.from(content), expected);
    return result.status === "published" ? undefined : result.error;
  }

  publishFileThrough(pending: string, name: string, content: string, mode: number = FILE_MODE): Error | undefined {
    componentBuffer(name);
    const libc = descriptorCalls();
    const fd = libc.openat(this.#fd, componentBuffer(pending), NEW_FILE_FLAGS, mode);
    if (fd < 0) throw escapeFailure(libcError("openat"));
    try {
      writeAndClose(fd, content, mode);
      if (libc.renameat(this.#fd, componentBuffer(pending), this.#fd, componentBuffer(name)) < 0) {
        throw escapeFailure(libcError("renameat"));
      }
    } catch (err) {
      libc.unlinkat(this.#fd, componentBuffer(pending), 0);
      throw err;
    }
    try {
      fsyncSync(this.#fd);
      return undefined;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  publishFileBytesThrough(pending: string, name: string, content: Uint8Array, expected: ContainedFileSnapshot | undefined, publicationMetadata: ContainedFileMetadata | undefined = expected?.metadata): FileMutationAttemptResult {
    let published = false;
    const pendingEntry = componentBuffer(pending);
    try {
      componentBuffer(name);
      if (publicationMetadata?.kind === "win32") throw new Error("POSIX publication requires POSIX metadata evidence");
      const mode = publicationMetadata?.mode ?? FILE_MODE;
      const libc = descriptorCalls();
      const fd = libc.openat(this.#fd, pendingEntry, NEW_FILE_FLAGS, mode);
      if (fd < 0) throw escapeFailure(libcError("openat"));
      let stagedIdentity: string;
      try {
        fchmodSync(fd, mode & 0o777);
        writeAll(fd, content);
        fsyncSync(fd);
        const staged = fstatSync(fd);
        stagedIdentity = `${staged.dev}:${staged.ino}`;
      } finally {
        closeSync(fd);
      }
      const current = this.readFileSnapshot(name, (expected?.content.byteLength ?? 0) + 1);
      if (!sameFileSnapshot(current, expected)) throw new ContainedPathError(`${name} no longer matches the object this publication admitted`);
      if (libc.renameat(this.#fd, pendingEntry, this.#fd, componentBuffer(name)) < 0) throw escapeFailure(libcError("renameat"));
      published = true;
      const installed = this.readFileSnapshot(name, content.byteLength);
      if (!installed || installed.identity !== stagedIdentity || !installed.content.equals(Buffer.from(content))
        || installed.linkCount !== 1 || installed.executable !== ((mode & 0o111) !== 0)
        || installed.metadata.kind !== "posix" || installed.metadata.mode !== (mode & 0o777)) {
        throw new ContainedPathError(`${name} did not verify after publication`);
      }
      fsyncSync(this.#fd);
      return { status: "published" };
    } catch (error) {
      descriptorCalls().unlinkat(this.#fd, pendingEntry, 0);
      return {
        status: published ? "indeterminate" : "not_applied",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  defaultFileMetadata(): ContainedFileMetadata {
    return { kind: "posix", mode: FILE_MODE };
  }

  publishLink(pending: string, name: string, target: string): void {
    componentBuffer(name);
    if (target === "" || target.startsWith("/") || target.includes("\0")) {
      throw new Error(`a contained symlink names a relative target, not ${JSON.stringify(target)}`);
    }
    const libc = descriptorCalls();
    if (libc.symlinkat(Buffer.from(`${target}\0`, "utf8"), this.#fd, componentBuffer(pending)) < 0) {
      throw escapeFailure(libcError("symlinkat"));
    }
    try {
      if (libc.renameat(this.#fd, componentBuffer(pending), this.#fd, componentBuffer(name)) < 0) {
        throw escapeFailure(libcError("renameat"));
      }
    } catch (err) {
      libc.unlinkat(this.#fd, componentBuffer(pending), 0);
      throw err;
    }
    fsyncSync(this.#fd);
  }

  openLinkedChild(name: string): PosixContainedDirectory | undefined {
    try {
      // Linked children expose the resolved link target through canonicalPath().
      const path = realpathSync(join(this.#path, name));
      return new PosixContainedDirectory(openAt(this.#fd, name, BASE_FLAGS), join(this.#path, name), path);
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return undefined;
      throw escapeFailure(err);
    }
  }

  createExclusive(name: string, content: string): boolean {
    const libc = descriptorCalls();
    const entry = componentBuffer(name);
    const fd = libc.openat(this.#fd, entry, NEW_FILE_FLAGS, FILE_MODE);
    if (fd < 0) {
      const failure = libcError("openat");
      if (isErrnoCode(failure, "EEXIST")) return false;
      throw escapeFailure(failure);
    }
    try {
      writeAndClose(fd, content, FILE_MODE);
    } catch (err) {
      libc.unlinkat(this.#fd, entry, 0);
      throw err;
    }
    return true;
  }

  async writeStreamExclusive(name: string, source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, options: ContainedStreamOptions): Promise<number> {
    const libc = descriptorCalls();
    const entry = componentBuffer(name);
    const mode = options.mode ?? FILE_MODE;
    const fd = libc.openat(this.#fd, entry, NEW_FILE_FLAGS, mode);
    if (fd < 0) throw escapeFailure(libcError("openat"));
    let written = 0;
    try {
      fchmodSync(fd, mode);
      for await (const chunk of source) {
        if (options.signal?.aborted) throw new Error("the contained stream write was cancelled");
        written += chunk.byteLength;
        if (written > options.maxBytes) throw new Error(`the contained stream exceeds its ${options.maxBytes}-byte limit`);
        writeAll(fd, chunk);
      }
      if (options.signal?.aborted) throw new Error("the contained stream write was cancelled");
      fsyncSync(fd);
    } catch (err) {
      closeSync(fd);
      libc.unlinkat(this.#fd, entry, 0);
      throw err;
    }
    closeSync(fd);
    return written;
  }

  linkFile(existing: string, name: string): boolean {
    const libc = descriptorCalls();
    if (libc.linkat(this.#fd, componentBuffer(existing), this.#fd, componentBuffer(name), 0) >= 0) return true;
    const failure = libcError("linkat");
    if (isErrnoCode(failure, "EEXIST")) return false;
    throw escapeFailure(failure);
  }

  removeFile(name: string): void {
    const libc = descriptorCalls();
    if (libc.unlinkat(this.#fd, componentBuffer(name), 0) < 0) {
      const failure = libcError("unlinkat");
      if (isErrnoCode(failure, "ENOENT")) return;
      throw escapeFailure(failure);
    }
    fsyncSync(this.#fd);
  }

  removeFileIfSnapshot(name: string, expected: ContainedFileSnapshot): FileMutationAttemptResult {
    let published = false;
    try {
      const libc = descriptorCalls();
      if (!sameFileSnapshot(this.readFileSnapshot(name, expected.content.byteLength + 1), expected)) {
        throw new ContainedPathError(`${name} no longer matches the object this deletion admitted`);
      }
      if (libc.unlinkat(this.#fd, componentBuffer(name), 0) < 0) throw escapeFailure(libcError("unlinkat"));
      published = true;
      fsyncSync(this.#fd);
      return { status: "published" };
    } catch (error) {
      return {
        status: published ? "indeterminate" : "not_applied",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  removeTree(name: string): void {
    removeTreeAt(this.#fd, name);
    fsyncSync(this.#fd);
  }

  removeEmptyChild(name: string): boolean {
    const libc = descriptorCalls();
    if (libc.unlinkat(this.#fd, componentBuffer(name), AT_REMOVEDIR) >= 0) {
      fsyncSync(this.#fd);
      return true;
    }
    const failure = libcError("unlinkat");
    if (isErrnoCode(failure, "ENOENT")) return true;
    if (isErrnoCode(failure, "ENOTEMPTY") || isErrnoCode(failure, "EEXIST")) return false;
    throw escapeFailure(failure);
  }

  hasEntry(name: string): boolean {
    let fd: number;
    try {
      fd = openAt(this.#fd, name, EXISTING_ENTRY_FLAGS);
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return false;
      throw escapeFailure(err);
    }
    closeSync(fd);
    return true;
  }

  entryNames(): readonly string[] {
    return [...readDirAt(this.#fd)].map((entry) => entry.name);
  }

  directoryEntryNames(): readonly string[] {
    return [...readDirAt(this.#fd)].flatMap((entry) => (isDirectoryEntryAt(this.#fd, entry) ? [entry.name] : []));
  }

  regularFileEntries(): readonly ContainedRegularFileEntry[] {
    return [...readDirAt(this.#fd)].flatMap((entry) => {
      const file = regularFileEntryAt(this.#fd, entry);
      return file === undefined ? [] : [file];
    });
  }

  regularFileModifiedAt(name: string): number {
    let fd: number;
    try {
      fd = openAt(this.#fd, name, EXISTING_ENTRY_FLAGS);
    } catch (err) {
      throw escapeFailure(err);
    }
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile()) throw new ContainedPathError(`the contained entry is not a regular file: ${name}`);
      return stats.mtimeMs;
    } finally {
      closeSync(fd);
    }
  }

  admitPrivateFile(name: string): boolean {
    let fd: number;
    try {
      fd = openAt(this.#fd, name, EXISTING_ENTRY_FLAGS);
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return false;
      throw escapeFailure(err);
    }
    try {
      if (!fstatSync(fd).isFile()) throw new ContainedPathError(`the contained private file is not a regular file: ${name}`);
      fchmodSync(fd, FILE_MODE);
    } finally {
      closeSync(fd);
    }
    return true;
  }

  syncFile(name: string): void {
    let fd: number;
    try {
      fd = openAt(this.#fd, name, EXISTING_ENTRY_FLAGS);
    } catch (err) {
      throw escapeFailure(err);
    }
    try {
      if (!fstatSync(fd).isFile()) throw new ContainedPathError("the contained sync target is not a regular file");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  syncDirectory(): void {
    fsyncSync(this.#fd);
  }

  renameInto(name: string, target: ContainedDirectoryContract, targetName: string): void {
    if (!(target instanceof PosixContainedDirectory)) {
      throw new Error("contained directories must use the same platform backend");
    }
    const libc = descriptorCalls();
    if (libc.renameat(this.#fd, componentBuffer(name), target.#fd, componentBuffer(targetName)) < 0) {
      throw escapeFailure(libcError("renameat"));
    }
    fsyncSync(this.#fd);
    fsyncSync(target.#fd);
  }

  canonicalPath(): string {
    this.#canonicalPath ??= realpathSync(this.#path);
    return this.#canonicalPath;
  }

  identity(): string {
    const stats = fstatSync(this.#fd);
    return `${stats.dev}:${stats.ino}`;
  }

  requireSamePathAs(dirPath: string): void {
    const held = fstatSync(this.#fd);
    let named: ReturnType<typeof statSync>;
    try {
      named = statSync(dirPath);
    } catch (cause) {
      throw new ContainedPathError(`the held directory is no longer reachable at ${dirPath}`, { cause });
    }
    if (held.dev !== named.dev || held.ino !== named.ino) {
      throw new ContainedPathError(`${dirPath} no longer names the directory this window admitted`);
    }
  }

  close(): void {
    closeSync(this.#fd);
  }
}


function writeAndClose(fd: number, content: string, mode: number): void {
  try {
    fchmodSync(fd, mode);
    writeFileSync(fd, content, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** One chunk, whole. A single `writeSync` may take less than it was given. */
function writeAll(fd: number, chunk: Uint8Array): void {
  let offset = 0;
  while (offset < chunk.byteLength) {
    offset += writeSync(fd, chunk, offset, chunk.byteLength - offset);
  }
}

/** Remove `name` below `parentFd`, recursing into a directory. */
function removeTreeAt(parentFd: number, name: string): void {
  const libc = descriptorCalls();
  const entry = componentBuffer(name);
  if (libc.unlinkat(parentFd, entry, 0) >= 0) return;
  const failure = libcError("unlinkat");
  if (isErrnoCode(failure, "ENOENT")) return;
  if (!isErrnoCode(failure, "EPERM") && !isErrnoCode(failure, "EISDIR")) throw escapeFailure(failure);

  const childFd = openAt(parentFd, name, DIRECTORY_FLAGS);
  try {
    // Names are collected before anything is unlinked: a directory stream read
    // while its entries disappear may skip entries.
    const children = [...readDirAt(childFd)];
    for (const child of children) removeTreeAt(childFd, child.name);
  } finally {
    closeSync(childFd);
  }
  if (libc.unlinkat(parentFd, entry, AT_REMOVEDIR) < 0) {
    const removal = libcError("unlinkat");
    if (!isErrnoCode(removal, "ENOENT")) throw escapeFailure(removal);
  }
}

/** Open the base a walk starts at. A symlink at its own final component is
 * followed unless the caller owns that component and refuses one. */
function openBase(baseDir: string, options: ContainedDirectoryOptions): number {
  return openSync(baseDir, options.noFollowBase === true ? BASE_NOFOLLOW_FLAGS : BASE_FLAGS);
}

function withBaseFd<T>(baseDir: string, options: ContainedDirectoryOptions, use: (baseFd: number) => T): T {
  const baseFd = openBase(baseDir, options);
  try {
    return use(baseFd);
  } finally {
    closeSync(baseFd);
  }
}

export const posixContainedDirectoryBackend: ContainedDirectoryBackend = {
  open: (baseDir, dirs, options) => PosixContainedDirectory.open(baseDir, dirs, options),
  openExisting: (baseDir, dirs, options) => PosixContainedDirectory.openExisting(baseDir, dirs, options),
};

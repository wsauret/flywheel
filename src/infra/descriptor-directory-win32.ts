/** Path-held Windows implementation of the contained-directory contract. Node does
 * not expose descriptor-relative no-follow calls on Windows, so every operation
 * lstat-checks its final entry and holds the resolved absolute directory path.
 * A same-user process can still junction-swap a checked parent before the later
 * path operation; that accepted TOCTOU limit is why this backend does not claim
 * descriptor-level containment. */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { renameThroughSharing, replaceFileOnWindows } from "./windows-file-replacement.js";
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
import { errnoCode } from "./error-message.js";
import { applyWindowsPrivateDirectoryAcl, type WindowsPrivateDirectoryAclPort } from "./windows-private-directory-acl.js";
import { openNativeWindowsDirectory, type NativeWindowsDirectory } from "./descriptor-directory-win32-native.js";
import {
  FILE_MODE,
  isLinkEntry,
  isMissing,
  isReparse,
  openBase,
  openChildPath,
  pathError,
  POINTER_MAX_BYTES,
  publishRegularFile,
  relativeTargetComponents,
  removeTreePath,
  requireRegularFile,
  unlinkIfPresent,
  validateWindowsComponent,
  writeAll,
  writeAndClose,
} from "./descriptor-directory-win32-path.js";

export interface Win32ContainedDirectoryOperations {
  /** Replaces a link's pointer by its pending one, with the bounded retry and
   *  no rename aside (`renameThroughSharing`). */
  readonly renamePointer: (pendingPath: string, targetPath: string) => void;
  /** Renames one entry. A rename onto a free name retries a sharing refusal
   *  for a bounded time; a rename over a regular file replaces it
   *  (`replaceFileOnWindows`). */
  readonly renameEntry: (sourcePath: string, targetPath: string) => void;
  /** Deletes one file, which Windows refuses while a process runs it or
   *  holds it without delete sharing. */
  readonly unlinkEntry: (entryPath: string) => void;
  readonly applyPrivateDirectoryAcl: WindowsPrivateDirectoryAclPort;
  readonly retainedAuthority: boolean;
  readonly openNativeDirectory: typeof openNativeWindowsDirectory;
}

const defaultOperations: Win32ContainedDirectoryOperations = {
  renamePointer: (pendingPath, targetPath) => { renameThroughSharing(pendingPath, targetPath); },
  unlinkEntry: (entryPath) => { fs.unlinkSync(entryPath); },
  renameEntry: (sourcePath, targetPath) => {
    if (entryExists(targetPath)) replaceFileOnWindows(sourcePath, targetPath);
    else renameThroughSharing(sourcePath, targetPath);
  },
  applyPrivateDirectoryAcl: applyWindowsPrivateDirectoryAcl,
  retainedAuthority: process.platform === "win32",
  openNativeDirectory: openNativeWindowsDirectory,
};


function entryExists(entryPath: string): boolean {
  try {
    fs.lstatSync(entryPath);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** One Windows directory held by its resolved absolute path for one operation window. */
class Win32ContainedDirectory implements ContainedDirectoryContract {
  readonly #path: string;
  readonly #operations: Win32ContainedDirectoryOperations;
  readonly #dev: number | undefined;
  readonly #ino: number | undefined;
  readonly #privateTree: boolean;
  readonly #native: NativeWindowsDirectory | undefined;
  #closed = false;

  private constructor(directoryPath: string, operations: Win32ContainedDirectoryOperations, privateTree: boolean, native?: NativeWindowsDirectory) {
    this.#path = directoryPath;
    this.#operations = operations;
    this.#privateTree = privateTree;
    this.#native = native;
    if (native === undefined) {
      const stats = fs.statSync(directoryPath);
      if (!stats.isDirectory()) throw pathError(`the contained path is not a directory: ${directoryPath}`);
      this.#dev = stats.dev;
      this.#ino = stats.ino;
    }
  }

  static open(baseDir: string, dirs: readonly string[], options: ContainedDirectoryOptions = {}, operations: Win32ContainedDirectoryOperations = defaultOperations): Win32ContainedDirectory {
    let current = openBase(baseDir, options);
    let privateTree = options.privateDirectories === true && dirs.length === 0;
    for (const component of dirs) {
      const child = openChildPath(current, component, true, options.privateDirectories === true, options.privateDirectories === true && !privateTree, operations.applyPrivateDirectoryAcl);
      if (child === undefined) throw new Error("a created contained directory cannot be absent");
      current = child;
      if (options.privateDirectories === true) privateTree = true;
    }
    const native = operations.retainedAuthority ? operations.openNativeDirectory(baseDir, dirs, options.noFollowBase) : undefined;
    return new Win32ContainedDirectory(current, operations, privateTree, native);
  }

  static openExisting(baseDir: string, dirs: readonly string[], options: ContainedDirectoryOptions = {}, operations: Win32ContainedDirectoryOperations = defaultOperations): Win32ContainedDirectory | undefined {
    let current: string;
    try {
      current = openBase(baseDir, options);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const privateTree = options.privateDirectories === true;
    for (const component of dirs) {
      const child = openChildPath(current, component, false, false, false, operations.applyPrivateDirectoryAcl);
      if (child === undefined) return undefined;
      current = child;
    }
    const native = operations.retainedAuthority ? operations.openNativeDirectory(baseDir, dirs, options.noFollowBase) : undefined;
    return new Win32ContainedDirectory(current, operations, privateTree, native);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("the contained directory is closed");
  }

  #entry(name: string): string {
    this.#assertOpen();
    validateWindowsComponent(name);
    return path.join(this.#path, name);
  }

  #fromPath(directoryPath: string, privateTree = this.#privateTree, native?: NativeWindowsDirectory): Win32ContainedDirectory {
    return new Win32ContainedDirectory(directoryPath, this.#operations, privateTree, native);
  }

  openChild(name: string, options: ContainedDirectoryOptions = {}): Win32ContainedDirectory {
    this.#assertOpen();
    const privateDirectory = options.privateDirectories === true;
    if (this.#native !== undefined) {
      const native = this.#native.openChild(name, true);
      if (native === undefined) throw new Error("a created native contained directory cannot be absent");
      return this.#fromPath(path.join(this.#path, name), this.#privateTree || privateDirectory, native);
    }
    const child = openChildPath(this.#path, name, true, privateDirectory, privateDirectory && !this.#privateTree, this.#operations.applyPrivateDirectoryAcl);
    if (child === undefined) throw new Error("a created contained directory cannot be absent");
    return this.#fromPath(child, this.#privateTree || privateDirectory);
  }

  openExistingChild(name: string): Win32ContainedDirectory | undefined {
    this.#assertOpen();
    if (this.#native !== undefined) {
      const native = this.#native.openChild(name, false);
      return native === undefined ? undefined : this.#fromPath(path.join(this.#path, name), this.#privateTree, native);
    }
    const child = openChildPath(this.#path, name, false, false, false, this.#operations.applyPrivateDirectoryAcl);
    return child === undefined ? undefined : this.#fromPath(child, this.#privateTree);
  }

  readFile(name: string, maxBytes: number): Buffer | undefined {
    return this.readOwnedFile(name, maxBytes)?.content;
  }

  readOwnedFile(name: string, maxBytes: number): ContainedOwnedFile | undefined {
    if (this.#native !== undefined) {
      const snapshot = this.#native.readFileSnapshot(name, maxBytes);
      return snapshot === undefined ? undefined : {
        content: snapshot.content,
        linkCount: snapshot.linkCount,
        executable: false,
      };
    }
    const entryPath = this.#entry(name);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(entryPath);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    requireRegularFile(stats, "read target");
    if (stats.size > maxBytes) throw new ContainedFileTooLargeError(maxBytes);
    return { content: fs.readFileSync(entryPath), linkCount: stats.nlink, executable: false };
  }

  readFileSnapshot(name: string, maxBytes: number): ContainedFileSnapshot | undefined {
    if (this.#native !== undefined) {
      const snapshot = this.#native.readFileSnapshot(name, maxBytes);
      return snapshot === undefined ? undefined : {
        content: snapshot.content,
        identity: snapshot.identity,
        linkCount: snapshot.linkCount,
        executable: false,
        metadata: { kind: "win32", dacl: snapshot.dacl },
      };
    }
    const entryPath = this.#entry(name);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(entryPath);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    requireRegularFile(stats, "read target");
    if (stats.size > maxBytes) throw new ContainedFileTooLargeError(maxBytes);
    const content = fs.readFileSync(entryPath);
    if (content.byteLength > maxBytes) throw new ContainedFileTooLargeError(maxBytes);
    return { content, identity: `${stats.dev}:${stats.ino}`, linkCount: stats.nlink, executable: false, metadata: { kind: "win32", dacl: Buffer.alloc(0) } };
  }

  writeFile(name: string, content: string): Error | undefined {
    const expected = this.readFileSnapshot(name, Number.MAX_SAFE_INTEGER);
    const result = this.publishFileBytesThrough(`.flywheel-write.${process.pid}.${randomBytes(6).toString("hex")}`, name, Buffer.from(content), expected);
    return result.status === "published" ? undefined : result.error;
  }

  publishFileThrough(pending: string, name: string, content: string, mode: number = FILE_MODE): Error | undefined {
    const pendingPath = this.#entry(pending);
    const targetPath = this.#entry(name);
    const fd = fs.openSync(pendingPath, "wx", mode);
    try {
      writeAndClose(fd, content, mode);
      try {
        publishRegularFile(pendingPath, targetPath);
      } catch (error) {
        // One error type for one contract. The POSIX backend reports a failed
        // publication as a contained-path error, and a caller catching that must
        // not also have to know that Windows reports the same refusal as EPERM
        // where POSIX reports EISDIR.
        throw error instanceof ContainedPathError ? error : pathError(`the contained publication did not land: ${name}`, error);
      }
    } catch (error) {
      unlinkIfPresent(pendingPath);
      throw error;
    }
    return undefined;
  }

  publishFileBytesThrough(pending: string, name: string, content: Uint8Array, expected: ContainedFileSnapshot | undefined, publicationMetadata: ContainedFileMetadata | undefined = expected?.metadata): FileMutationAttemptResult {
    try {
      if (expected !== undefined && expected.metadata.kind !== "win32") throw new Error("Windows comparison requires Windows metadata evidence");
      if (publicationMetadata !== undefined && publicationMetadata.kind !== "win32") throw new Error("Windows publication requires Windows metadata evidence");
      if (this.#native !== undefined) {
        const result = this.#native.publishFileBytes(pending, name, Buffer.from(content), nativeSnapshot(expected), publicationMetadata?.dacl);
        return result.status === "published" ? result : { status: result.status, error: nativeMutationError(result.error) };
      }
      if (!sameFileSnapshot(this.readFileSnapshot(name, (expected?.content.byteLength ?? 0) + 1), expected)) {
        throw pathError(`${name} no longer matches the object this publication admitted`);
      }
      const pendingPath = this.#entry(pending);
      const fd = fs.openSync(pendingPath, "wx", FILE_MODE);
      try {
        try {
          writeAll(fd, content);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      } catch (error) {
        unlinkIfPresent(pendingPath);
        throw error;
      }
      try {
        publishRegularFile(pendingPath, this.#entry(name));
      } catch (error) {
        unlinkIfPresent(pendingPath);
        return { status: "indeterminate", error: error instanceof Error ? error : new Error(String(error)) };
      }
      return { status: "published" };
    } catch (error) {
      return { status: "not_applied", error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  defaultFileMetadata(): undefined {
    return undefined;
  }

  /** A link on Windows is a pointer file: its text is the relative target,
   *  in Windows separators, which is what the Windows launcher reads. An
   *  unprivileged process can make no symlink, and a junction swap is two
   *  steps and names the junction path as the target's own, so neither
   *  stands in for one. The pointer is written under the pending name and
   *  renamed over the link's name with the bounded retry and no rename
   *  aside; what stands at the name must be a pointer or nothing. */
  publishLink(pending: string, name: string, target: string): void {
    const components = relativeTargetComponents(target);
    const pendingPath = this.#entry(pending);
    const targetPath = this.#entry(name);
    try {
      const stats = fs.lstatSync(targetPath);
      if (isLinkEntry(stats) || !stats.isFile()) throw pathError(`the contained link ${name} is not a pointer, so it is not replaced`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const fd = fs.openSync(pendingPath, "wx", FILE_MODE);
    try {
      writeAndClose(fd, components.join("\\"), FILE_MODE);
      this.#operations.renamePointer(pendingPath, targetPath);
    } catch (error) {
      unlinkIfPresent(pendingPath);
      throw error;
    }
  }

  /** The directory the pointer at `name` names, held one component at a time
   *  so no reparse point below this directory redirects it, or nothing when
   *  there is no pointer or it names nothing. Either separator and trailing
   *  white space are read, as the launcher reads them. */
  openLinkedChild(name: string): Win32ContainedDirectory | undefined {
    const raw = this.readFile(name, POINTER_MAX_BYTES);
    if (raw === undefined) return undefined;
    const text = raw.toString("utf8").trimEnd();
    const components = relativeTargetComponents(text.replaceAll("\\", "/"));
    const held: Win32ContainedDirectory[] = [];
    try {
      for (const component of components) {
        const child = (held.at(-1) ?? this).openExistingChild(component);
        if (child === undefined) return undefined;
        held.push(child);
      }
      return held.pop();
    } finally {
      for (const directory of held) directory.close();
    }
  }

  createExclusive(name: string, content: string): boolean {
    const entryPath = this.#entry(name);
    let fd: number;
    try {
      fd = fs.openSync(entryPath, "wx", FILE_MODE);
    } catch (error) {
      if (errnoCode(error) === "EEXIST") return false;
      throw error;
    }
    try {
      writeAndClose(fd, content, FILE_MODE);
    } catch (error) {
      unlinkIfPresent(entryPath);
      throw error;
    }
    return true;
  }

  async writeStreamExclusive(name: string, source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, options: ContainedStreamOptions): Promise<number> {
    const entryPath = this.#entry(name);
    const fd = fs.openSync(entryPath, "wx", options.mode ?? FILE_MODE);
    let written = 0;
    try {
      if (options.mode !== undefined) fs.fchmodSync(fd, options.mode);
      for await (const chunk of source) {
        if (options.signal?.aborted) throw new Error("the contained stream write was cancelled");
        written += chunk.byteLength;
        if (written > options.maxBytes) throw new Error(`the contained stream exceeds its ${options.maxBytes}-byte limit`);
        writeAll(fd, chunk);
      }
      if (options.signal?.aborted) throw new Error("the contained stream write was cancelled");
      fs.fsyncSync(fd);
    } catch (error) {
      fs.closeSync(fd);
      unlinkIfPresent(entryPath);
      throw error;
    }
    fs.closeSync(fd);
    return written;
  }

  linkFile(existing: string, name: string): boolean {
    const existingPath = this.#entry(existing);
    const targetPath = this.#entry(name);
    const source = fs.lstatSync(existingPath);
    requireRegularFile(source, "link source");
    try {
      fs.linkSync(existingPath, targetPath);
      return true;
    } catch (error) {
      if (errnoCode(error) === "EEXIST") return false;
      throw error;
    }
  }

  removeFile(name: string): void {
    const entryPath = this.#entry(name);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(entryPath);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (stats.isDirectory() && !isLinkEntry(stats)) throw pathError("the contained remove target is a directory");
    this.#operations.unlinkEntry(entryPath);
  }

  removeFileIfSnapshot(name: string, expected: ContainedFileSnapshot): FileMutationAttemptResult {
    try {
      if (expected.metadata.kind !== "win32") throw new Error("Windows deletion requires Windows metadata evidence");
      if (this.#native !== undefined) {
        // SAFETY: expected is a required parameter and its win32 metadata was validated above.
        const result = this.#native.deleteFile(name, nativeSnapshot(expected)!);
        return result.status === "published" ? result : { status: result.status, error: nativeMutationError(result.error) };
      }
      if (!sameFileSnapshot(this.readFileSnapshot(name, expected.content.byteLength + 1), expected)) {
        throw pathError(`${name} no longer matches the object this deletion admitted`);
      }
      try {
        fs.unlinkSync(this.#entry(name));
      } catch (error) {
        return { status: "not_applied", error: error instanceof Error ? error : new Error(String(error)) };
      }
      return { status: "published" };
    } catch (error) {
      return { status: "not_applied", error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  removeTree(name: string): void {
    removeTreePath(this.#entry(name));
  }

  removeEmptyChild(name: string): boolean {
    const entryPath = this.#entry(name);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(entryPath);
    } catch (error) {
      if (isMissing(error)) return true;
      throw error;
    }
    if (isLinkEntry(stats) || !stats.isDirectory()) throw pathError("the contained empty-child target is not a directory");
    try {
      fs.rmdirSync(entryPath);
      return true;
    } catch (error) {
      if (isMissing(error)) return true;
      if (errnoCode(error) === "ENOTEMPTY" || errnoCode(error) === "EEXIST") return false;
      throw error;
    }
  }

  hasEntry(name: string): boolean {
    const entryPath = this.#entry(name);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(entryPath);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    if (isLinkEntry(stats)) throw pathError("the contained entry is a symlink or junction");
    return true;
  }

  entryNames(): readonly string[] {
    this.#assertOpen();
    if (this.#native !== undefined) return this.#native.entries().map(({ name }) => name);
    return fs.readdirSync(this.#path);
  }

  directoryEntryNames(): readonly string[] {
    this.#assertOpen();
    if (this.#native !== undefined) return this.#native.entries().filter(({ kind }) => kind === "directory").map(({ name }) => name);
    const directories: string[] = [];
    for (const name of fs.readdirSync(this.#path)) {
      const stats = fs.lstatSync(path.join(this.#path, name));
      if (!isReparse(stats) && stats.isDirectory()) directories.push(name);
    }
    return directories;
  }

  regularFileEntries(): readonly ContainedRegularFileEntry[] {
    this.#assertOpen();
    if (this.#native !== undefined) return this.#native.entries().filter(({ kind }) => kind === "file").map(({ name, createdAt, updatedAt }) => ({ name, createdAt, updatedAt }));
    const files: ContainedRegularFileEntry[] = [];
    for (const name of fs.readdirSync(this.#path)) {
      const entryPath = path.join(this.#path, name);
      const stats = fs.lstatSync(entryPath);
      if (!isReparse(stats) && stats.isFile()) {
        files.push({ name, createdAt: stats.birthtimeMs, updatedAt: stats.mtimeMs });
      }
    }
    return files;
  }

  regularFileModifiedAt(name: string): number {
    const entryPath = this.#entry(name);
    const stats = fs.lstatSync(entryPath);
    requireRegularFile(stats, `entry ${name}`);
    return stats.mtimeMs;
  }

  admitPrivateFile(name: string): boolean {
    const entryPath = this.#entry(name);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(entryPath);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    requireRegularFile(stats, "private file");
    try {
      fs.chmodSync(entryPath, FILE_MODE);
    } catch (error) {
      // Windows can report EPERM while SQLite removes a closing sidecar.
      if (isMissing(error) || (errnoCode(error) === "EPERM" && !entryExists(entryPath))) return false;
      throw error;
    }
    return true;
  }

  syncFile(name: string): void {
    const entryPath = this.#entry(name);
    const stats = fs.lstatSync(entryPath);
    requireRegularFile(stats, "sync target");
    const fd = fs.openSync(entryPath, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  syncDirectory(): void {
    // Windows exposes no supported parent-directory flush equivalent; publication uses its platform durability contract.
  }

  renameInto(name: string, target: ContainedDirectoryContract, targetName: string): void {
    if (!(target instanceof Win32ContainedDirectory)) throw new TypeError("contained directories must use the same platform backend");
    const sourcePath = this.#entry(name);
    const targetPath = target.#entry(targetName);
    if (this.#native && target.#native) {
      this.#native.renameInto(name, target.#native, targetName);
    } else {
      if (this.#native || target.#native) throw new Error("contained directories must use the same authority backend");
      this.#operations.renameEntry(sourcePath, targetPath);
    }
  }

  canonicalPath(): string {
    this.#assertOpen();
    return this.#path;
  }

  identity(): string {
    this.#assertOpen();
    return this.#native?.identity() ?? `${this.#dev}:${this.#ino}`;
  }

  requireSamePathAs(dirPath: string): void {
    this.#assertOpen();
    // Identity comes from whichever backend holds the handle: the native
    // authority compares handle identities, the path backend compares stat.
    if (this.#native) {
      let named: NativeWindowsDirectory;
      try {
        named = this.#operations.openNativeDirectory(dirPath, [], false);
      } catch (cause) {
        throw pathError(`the held directory is no longer reachable at ${dirPath}`, cause);
      }
      try {
        if (named.identity() !== this.#native.identity()) throw pathError(`${dirPath} no longer names the directory this window admitted`);
      } finally {
        named.close();
      }
      return;
    }
    let named: fs.Stats;
    try {
      named = fs.statSync(dirPath);
    } catch (cause) {
      throw pathError(`the held directory is no longer reachable at ${dirPath}`, cause);
    }
    if (this.#dev !== named.dev || this.#ino !== named.ino) throw pathError(`${dirPath} no longer names the directory this window admitted`);
  }

  close(): void {
    this.#native?.close();
    this.#closed = true;
  }
}

function nativeSnapshot(snapshot: ContainedFileSnapshot | undefined) {
  if (!snapshot) return undefined;
  if (snapshot.metadata.kind !== "win32") throw new Error("Windows operation requires Windows metadata evidence");
  return { content: snapshot.content, identity: snapshot.identity, linkCount: snapshot.linkCount, dacl: snapshot.metadata.dacl };
}

function nativeMutationError(message: string): Error {
  const isContainmentFailure = message.includes("no longer matches its admitted snapshot")
    || message.includes("a reparse point is not a contained entry")
    || message.includes("NTSTATUS 0xc00000ba")
    || message.includes("NTSTATUS 0xc0000103");
  return isContainmentFailure ? pathError(message) : new Error(message);
}


export function createWin32ContainedDirectoryBackend(
  overrides: Partial<Win32ContainedDirectoryOperations> = {},
): ContainedDirectoryBackend {
  const operations: Win32ContainedDirectoryOperations = { ...defaultOperations, ...overrides, retainedAuthority: overrides.retainedAuthority ?? (Object.keys(overrides).length === 0 && process.platform === "win32") };
  return {
    open: (baseDir, dirs, options) => Win32ContainedDirectory.open(baseDir, dirs, options, operations),
    openExisting: (baseDir, dirs, options) => Win32ContainedDirectory.openExisting(baseDir, dirs, options, operations),
  };
}

export const win32ContainedDirectoryBackend: ContainedDirectoryBackend = createWin32ContainedDirectoryBackend();

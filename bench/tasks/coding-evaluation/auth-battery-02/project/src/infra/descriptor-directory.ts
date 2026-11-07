/** The public, platform-neutral boundary for one directory held open for one operation window. */

import { posixContainedDirectoryBackend } from "./descriptor-directory-posix.js";
import { win32ContainedDirectoryBackend } from "./descriptor-directory-win32.js";
import {
  ContainedPathError,
  type ContainedDirectoryBackend,
  type ContainedDirectoryContract,
  type ContainedDirectoryOptions,
  type ContainedFileMetadata,
  type ContainedFileSnapshot,
  type ContainedRegularFileEntry,
  type FileMutationAttemptResult,
  type ContainedOwnedFile,
  type ContainedStreamOptions,
} from "./descriptor-directory-contract.js";

export { ContainedFileTooLargeError, ContainedPathError } from "./descriptor-directory-contract.js";
export type {
  ContainedDirectoryBackend,
  ContainedDirectoryContract,
  ContainedDirectoryOptions,
  ContainedFileMetadata,
  ContainedFileSnapshot,
  ContainedRegularFileEntry,
  FileMutationAttemptResult,
  ContainedOwnedFile,
  ContainedStreamOptions,
} from "./descriptor-directory-contract.js";

let backendOverride: ContainedDirectoryBackend | undefined;

/** Select a backend for focused tests. Production calls always dispatch from the process platform. */
export function setContainedDirectoryBackendForTests(backend: ContainedDirectoryBackend | undefined): void {
  backendOverride = backend;
}

function selectedBackend(): ContainedDirectoryBackend {
  if (backendOverride !== undefined) return backendOverride;
  if (process.platform === "win32") return win32ContainedDirectoryBackend;
  if (process.platform === "linux" || process.platform === "darwin") return posixContainedDirectoryBackend;
  throw new ContainedPathError(`contained directories are unavailable on ${process.platform}`);
}

/** A directory held open for the length of one operation window. */
export class ContainedDirectory {
  readonly #backend: ContainedDirectoryContract;

  private constructor(backend: ContainedDirectoryContract) {
    this.#backend = backend;
  }

  /** Hold the directory at `dirs` below `baseDir`, creating missing components. */
  static open(baseDir: string, dirs: readonly string[], options: ContainedDirectoryOptions = {}): ContainedDirectory {
    return new ContainedDirectory(selectedBackend().open(baseDir, dirs, options));
  }

  /** Hold the directory at `dirs` below `baseDir` when it is already there. */
  static openExisting(baseDir: string, dirs: readonly string[], options: ContainedDirectoryOptions = {}): ContainedDirectory | undefined {
    const backend = selectedBackend().openExisting(baseDir, dirs, options);
    return backend === undefined ? undefined : new ContainedDirectory(backend);
  }

  openChild(name: string, options: ContainedDirectoryOptions = {}): ContainedDirectory {
    return new ContainedDirectory(this.#backend.openChild(name, options));
  }

  openExistingChild(name: string): ContainedDirectory | undefined {
    const backend = this.#backend.openExistingChild(name);
    return backend === undefined ? undefined : new ContainedDirectory(backend);
  }

  readFile(name: string, maxBytes: number): Buffer | undefined {
    return this.#backend.readFile(name, maxBytes);
  }

  readOwnedFile(name: string, maxBytes: number): ContainedOwnedFile | undefined {
    return this.#backend.readOwnedFile(name, maxBytes);
  }

  readFileSnapshot(name: string, maxBytes: number): ContainedFileSnapshot | undefined {
    return this.#backend.readFileSnapshot(name, maxBytes);
  }

  writeFile(name: string, content: string): Error | undefined {
    return this.#backend.writeFile(name, content);
  }

  publishFileThrough(pending: string, name: string, content: string, mode?: number): Error | undefined {
    return this.#backend.publishFileThrough(pending, name, content, mode);
  }

  publishFileBytesThrough(pending: string, name: string, content: Uint8Array, expected: ContainedFileSnapshot | undefined, publicationMetadata?: ContainedFileMetadata): FileMutationAttemptResult {
    return this.#backend.publishFileBytesThrough(pending, name, content, expected, publicationMetadata);
  }

  defaultFileMetadata(): ContainedFileMetadata | undefined {
    return this.#backend.defaultFileMetadata();
  }

  publishLink(pending: string, name: string, target: string): void {
    this.#backend.publishLink(pending, name, target);
  }

  openLinkedChild(name: string): ContainedDirectory | undefined {
    const backend = this.#backend.openLinkedChild(name);
    return backend === undefined ? undefined : new ContainedDirectory(backend);
  }

  createExclusive(name: string, content: string): boolean {
    return this.#backend.createExclusive(name, content);
  }

  writeStreamExclusive(
    name: string,
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    options: ContainedStreamOptions,
  ): Promise<number> {
    return this.#backend.writeStreamExclusive(name, source, options);
  }

  linkFile(existing: string, name: string): boolean {
    return this.#backend.linkFile(existing, name);
  }

  removeFile(name: string): void {
    this.#backend.removeFile(name);
  }

  removeFileIfSnapshot(name: string, expected: ContainedFileSnapshot): FileMutationAttemptResult {
    return this.#backend.removeFileIfSnapshot(name, expected);
  }

  removeTree(name: string): void {
    this.#backend.removeTree(name);
  }

  removeEmptyChild(name: string): boolean {
    return this.#backend.removeEmptyChild(name);
  }

  hasEntry(name: string): boolean {
    return this.#backend.hasEntry(name);
  }

  entryNames(): readonly string[] {
    return this.#backend.entryNames();
  }

  directoryEntryNames(): readonly string[] {
    return this.#backend.directoryEntryNames();
  }

  regularFileEntries(): readonly ContainedRegularFileEntry[] {
    return this.#backend.regularFileEntries();
  }

  regularFileModifiedAt(name: string): number {
    return this.#backend.regularFileModifiedAt(name);
  }

  admitPrivateFile(name: string): boolean {
    return this.#backend.admitPrivateFile(name);
  }

  syncFile(name: string): void {
    this.#backend.syncFile(name);
  }

  syncDirectory(): void {
    this.#backend.syncDirectory();
  }

  renameInto(name: string, target: ContainedDirectory, targetName: string): void {
    this.#backend.renameInto(name, target.#backend, targetName);
  }

  canonicalPath(): string {
    return this.#backend.canonicalPath();
  }

  requireSamePathAs(dirPath: string): void {
    this.#backend.requireSamePathAs(dirPath);
  }

  identity(): string {
    return this.#backend.identity();
  }

  close(): void {
    this.#backend.close();
  }
}

/** Hold one directory below a trusted base for the duration of an asynchronous callback. */
export async function withContainedDirectory<T>(
  baseDir: string,
  dirs: readonly string[],
  options: ContainedDirectoryOptions,
  use: (directory: ContainedDirectory) => Promise<T>,
): Promise<T> {
  const directory = ContainedDirectory.open(baseDir, dirs, options);
  try {
    return await use(directory);
  } finally {
    directory.close();
  }
}
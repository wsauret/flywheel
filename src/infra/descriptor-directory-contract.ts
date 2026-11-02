/** The platform-neutral contract for one directory held open for a bounded
 * operation window. Platform backends own descriptors and native calls; callers
 * depend only on these validated entry operations. */

export interface ContainedDirectoryOptions {
  /** Tighten every directory this walk creates or opens to owner-only. */
  readonly privateDirectories?: boolean;
  /** Create a missing directory with the process's default permissions, 0777
   *  less the umask, as the user's own tools create one in a project. Without
   *  it a created POSIX directory is owner-only. A Windows directory inherits
   *  its parent's access either way. */
  readonly defaultPermissions?: boolean;
  /** Refuse a symlink at the base's own final component. */
  readonly noFollowBase?: boolean;
}

export interface ContainedStreamOptions {
  /** The most this entry may hold. A source that delivers more is refused. */
  readonly maxBytes: number;
  readonly mode?: number;
  /** The caller's cancellation, checked between chunks. */
  readonly signal?: AbortSignal;
}

export interface ContainedOwnedFile {
  readonly content: Buffer;
  readonly linkCount: number;
  readonly executable: boolean;
}

export type ContainedFileMetadata =
  | { readonly kind: "posix"; readonly mode: number }
  | { readonly kind: "win32"; readonly dacl: Buffer };

export interface ContainedFileSnapshot extends ContainedOwnedFile {
  /** Stable identity of the opened object, not of its path spelling. */
  readonly identity: string;
  readonly metadata: ContainedFileMetadata;
}

/**
 * Metadata read from the same no-follow file authority used to classify one directory entry. `createdAt` and
 * `updatedAt` are Unix milliseconds equal to the `birthtimeMs` and `mtimeMs` that `fs.lstatSync` reports.
 */
export interface ContainedRegularFileEntry {
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type FileMutationAttemptResult =
  | { readonly status: "published" }
  | { readonly status: "not_applied"; readonly error: Error }
  | { readonly status: "indeterminate"; readonly error: Error };

export interface ContainedDirectoryContract {
  openChild(name: string, options?: ContainedDirectoryOptions): ContainedDirectoryContract;
  openExistingChild(name: string): ContainedDirectoryContract | undefined;
  readFile(name: string, maxBytes: number): Buffer | undefined;
  readOwnedFile(name: string, maxBytes: number): ContainedOwnedFile | undefined;
  readFileSnapshot(name: string, maxBytes: number): ContainedFileSnapshot | undefined;
  writeFile(name: string, content: string): Error | undefined;
  /** Atomically replaces the named entry without reading its previous bytes. Throws before publication; returns any post-publication durability error. */
  publishFileThrough(pending: string, name: string, content: string, mode?: number): Error | undefined;
  publishFileBytesThrough(pending: string, name: string, content: Uint8Array, expected: ContainedFileSnapshot | undefined, publicationMetadata?: ContainedFileMetadata): FileMutationAttemptResult;
  /** Returns exact access metadata for a newly published file when deterministic on this backend. */
  defaultFileMetadata(): ContainedFileMetadata | undefined;
  /** Publishes `name` as a link to the relative directory `target`, through
   *  the pending name and one rename, so a reader sees the old target or the
   *  new one. A symlink on POSIX; on Windows a pointer file whose text is the
   *  target, which the Windows launcher reads. */
  publishLink(pending: string, name: string, target: string): void;
  /** The directory the link at `name` resolves to, whose `canonicalPath()` is
   *  that physical directory, or nothing when there is no link or it names
   *  nothing. */
  openLinkedChild(name: string): ContainedDirectoryContract | undefined;
  createExclusive(name: string, content: string): boolean;
  writeStreamExclusive(
    name: string,
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    options: ContainedStreamOptions,
  ): Promise<number>;
  linkFile(existing: string, name: string): boolean;
  removeFile(name: string): void;
  removeFileIfSnapshot(name: string, expected: ContainedFileSnapshot): FileMutationAttemptResult;
  removeTree(name: string): void;
  removeEmptyChild(name: string): boolean;
  hasEntry(name: string): boolean;
  entryNames(): readonly string[];
  directoryEntryNames(): readonly string[];
  regularFileEntries(): readonly ContainedRegularFileEntry[];
  regularFileModifiedAt(name: string): number;
  canonicalPath(): string;
  admitPrivateFile(name: string): boolean;
  syncFile(name: string): void;
  syncDirectory(): void;
  renameInto(name: string, target: ContainedDirectoryContract, targetName: string): void;
  requireSamePathAs(dirPath: string): void;
  identity(): string;
  close(): void;
}

export interface ContainedDirectoryBackend {
  open(baseDir: string, dirs: readonly string[], options: ContainedDirectoryOptions): ContainedDirectoryContract;
  openExisting(baseDir: string, dirs: readonly string[], options: ContainedDirectoryOptions): ContainedDirectoryContract | undefined;
}

/** The canonical error for a path that is not the entry the caller owns. */
export class ContainedPathError extends Error {}

/** Access metadata equality within one platform; metadata from different platforms never matches. */
export function sameFileMetadata(actual: ContainedFileMetadata, expected: ContainedFileMetadata): boolean {
  if (actual.kind === "posix" && expected.kind === "posix") return actual.mode === expected.mode;
  if (actual.kind === "win32" && expected.kind === "win32") return actual.dacl.equals(expected.dacl);
  return false;
}

/** A regular contained file exceeded the caller's explicit admission bound. */
export class ContainedFileTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`the contained file exceeds its ${maxBytes}-byte read limit`);
    this.name = "ContainedFileTooLargeError";
  }
}

/** The compare-and-swap precondition: same object, same bytes, same link count and access. Two absences match. */
export function sameFileSnapshot(actual: ContainedFileSnapshot | undefined, expected: ContainedFileSnapshot | undefined): boolean {
  if (!actual || !expected) return actual === expected;
  return actual.identity === expected.identity && actual.content.equals(expected.content)
    && actual.linkCount === expected.linkCount && actual.executable === expected.executable
    && sameFileMetadata(actual.metadata, expected.metadata);
}

/** Validate one directory entry name without applying a platform encoding. */
export function validateComponent(name: string): void {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new Error(`a contained operation takes one path component, not ${JSON.stringify(name)}`);
  }
}

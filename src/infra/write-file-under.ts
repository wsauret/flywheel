/** One-shot reads, writes, and deletions below one trusted base directory.
 *
 *  Each function here names a target by a plain relative POSIX path, walks every
 *  component below the base against its parent's descriptor, and performs one
 *  operation on the entry it lands on. The walk and the operation both live in
 *  descriptor-directory.ts, which owns every descriptor; this module owns only
 *  the relative-path contract: a plain relative POSIX path, no component that is
 *  `.`, `..`, empty, or a separator, and nothing that leaves the base.
 *
 *  A caller performing several operations on one target directory holds it open
 *  instead of walking to it again for each one. */

import { ContainedDirectory, type ContainedDirectoryOptions, type ContainedFileSnapshot } from "./descriptor-directory.js";
import { validateComponent } from "./descriptor-directory-contract.js";

export interface ContainedFileLocation {
  readonly baseDir: string;
  readonly relativePath: string;
}

/** Split one relative path into its directory components and its file name,
 *  refusing anything that is not a plain relative POSIX path. */
function splitRelative(relativePath: string) {
  const components = relativePath.split("/");
  const file = components.pop();
  if (file === undefined || file === "" || relativePath.startsWith("/") || relativePath.includes("\\")) {
    throw new Error(`a contained write takes a plain relative POSIX path, not ${JSON.stringify(relativePath)}`);
  }
  for (const component of [...components, file]) validateComponent(component);
  return { dirs: components, file };
}

/** The directory components of one relative directory. `.` is the base itself. */
export function directoryComponents(relativeDir: string): readonly string[] {
  const components = relativeDir === "." ? [] : relativeDir.split("/");
  for (const component of components) validateComponent(component);
  return components;
}

/** Create one contained directory tree below a trusted base. */
export function ensureDirectoryUnder(baseDir: string, relativeDir: string, options: ContainedDirectoryOptions = {}): void {
  ContainedDirectory.open(baseDir, directoryComponents(relativeDir), options).close();
}

/** Admit an existing directory tree below a trusted base, creating nothing: a
 *  component that is a symlink or not a directory throws `ContainedPathError`,
 *  and absence is admitted because nothing is installed there yet. */
export function requireContainedDirectory(baseDir: string, relativeDir: string): void {
  ContainedDirectory.openExisting(baseDir, directoryComponents(relativeDir))?.close();
}

/** Read one contained regular file without following links. Absence returns undefined. */
export function readFileUnder(
  baseDir: string,
  relativePath: string,
  options: ContainedDirectoryOptions & { readonly maxBytes: number },
): Buffer | undefined {
  const { dirs, file } = splitRelative(relativePath);
  const directory = ContainedDirectory.openExisting(baseDir, dirs, options);
  if (!directory) return undefined;
  try {
    return directory.readFile(file, options.maxBytes);
  } finally {
    directory.close();
  }
}

/** Read exact bytes and the object identity and access metadata required for a later publication. */
export function readFileSnapshotUnder(
  baseDir: string,
  relativePath: string,
  options: ContainedDirectoryOptions & { readonly maxBytes: number },
): ContainedFileSnapshot | undefined {
  const { dirs, file } = splitRelative(relativePath);
  const directory = ContainedDirectory.openExisting(baseDir, dirs, options);
  if (!directory) return undefined;
  try {
    return directory.readFileSnapshot(file, options.maxBytes);
  } finally {
    directory.close();
  }
}

/** Write one file below a trusted base, publishing with a descriptor-relative rename. */
export function writeFileUnder(
  baseDir: string,
  relativePath: string,
  content: string,
  options: ContainedDirectoryOptions = {},
): void {
  const { dirs, file } = splitRelative(relativePath);
  const directory = ContainedDirectory.open(baseDir, dirs, options);
  try {
    directory.writeFile(file, content);
  } finally {
    directory.close();
  }
}

/** Remove one file at `relativePath` below `baseDir`. Absence is success: the
 *  caller's intent is that the entry is gone. Refuses a directory, so a caller
 *  cannot delete a tree through this boundary. */
export function removeFileUnder(baseDir: string, relativePath: string): void {
  const { dirs, file } = splitRelative(relativePath);
  const directory = ContainedDirectory.openExisting(baseDir, dirs);
  if (!directory) return;
  try {
    directory.removeFile(file);
  } finally {
    directory.close();
  }
}

/** Remove one entry at `relativePath` below `baseDir` and everything below it.
 *  Absence is success. Every level is opened relative to its parent's descriptor
 *  and never through a link, so a link planted inside the tree is unlinked where
 *  it stands and whatever it points at is left alone. */
export function removeTreeUnder(baseDir: string, relativePath: string, options: ContainedDirectoryOptions = {}): void {
  const { dirs, file } = splitRelative(relativePath);
  const directory = ContainedDirectory.openExisting(baseDir, dirs, options);
  if (!directory) return;
  try {
    directory.removeTree(file);
  } finally {
    directory.close();
  }
}

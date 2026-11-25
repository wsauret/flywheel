/** Opens a directory held for one operation window on the backend of the
 *  process platform. What a held directory can do is `ContainedDirectory` in
 *  `descriptor-directory-contract.ts`. */

import { posixContainedDirectoryBackend } from "./descriptor-directory/descriptor-directory-posix.js";
import { win32ContainedDirectoryBackend } from "./descriptor-directory/descriptor-directory-win32.js";
import {
  ContainedPathError,
  type ContainedDirectory,
  type ContainedDirectoryBackend,
  type ContainedDirectoryOptions,
} from "./descriptor-directory/descriptor-directory-contract.js";

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

/** Hold the directory at `dirs` below `baseDir`, creating missing components. */
export function openContainedDirectory(baseDir: string, dirs: readonly string[], options: ContainedDirectoryOptions = {}): ContainedDirectory {
  return selectedBackend().open(baseDir, dirs, options);
}

/** Hold the directory at `dirs` below `baseDir` when it is already there. */
export function openExistingContainedDirectory(baseDir: string, dirs: readonly string[], options: ContainedDirectoryOptions = {}): ContainedDirectory | undefined {
  return selectedBackend().openExisting(baseDir, dirs, options);
}

/** Hold one directory below a trusted base for the duration of an asynchronous callback. */
export async function withContainedDirectory<T>(
  baseDir: string,
  dirs: readonly string[],
  options: ContainedDirectoryOptions,
  use: (directory: ContainedDirectory) => Promise<T>,
): Promise<T> {
  const directory = openContainedDirectory(baseDir, dirs, options);
  try {
    return await use(directory);
  } finally {
    directory.close();
  }
}

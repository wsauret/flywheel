/** Archive admission: where each entry of a release archive lands.
 *
 *  An installed client checks a proved archive only for confinement (ARCH-DISTRIBUTION-011):
 *  every entry lands inside the tree the attempt owns, or the archive is a
 *  broken release and nothing of it is written. Everything else an archive
 *  states, such as how many entries it holds, how large they are, which
 *  modes they carry, and how their names are spelled, is the release's to
 *  decide, so this module places what the release ships instead of judging
 *  it. The release side refuses to publish an archive that a served client
 *  would refuse (`scripts/release-acceptance.ts`).
 *
 *  A name is resolved the way an extractor resolves it, with `/` and `\` both
 *  separators, so a name means the same place on every platform. Empty and
 *  `.` components are dropped and `..` steps back. A name that is absolute,
 *  that steps above the root, or that holds a NUL names no place inside the
 *  tree. */

import { Schema } from "effect";

export class ArchiveEntryError extends Schema.TaggedError<ArchiveEntryError>()("ArchiveEntry", {
  message: Schema.String,
  reason: Schema.String,
}) {}

function refuse(reason: string): never {
  throw new ArchiveEntryError({ message: `The archive is not safe to extract: ${reason}`, reason });
}

/** The relative path one entry name places inside the tree, with `/` as its
 *  one separator, or `""` for the root itself. */
export function confinedEntryPath(name: string): string {
  if (name.includes("\0")) refuse("an entry name holds a NUL byte");
  if (/^[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) refuse(`the entry name ${JSON.stringify(name)} is absolute`);
  const components: string[] = [];
  for (const component of name.split(/[\\/]/)) {
    if (component === "" || component === ".") continue;
    if (component !== "..") {
      components.push(component);
      continue;
    }
    if (components.length === 0) refuse(`the entry name ${JSON.stringify(name)} steps outside the archive`);
    components.pop();
  }
  return components.join("/");
}

/** The tree one archive lists, as it is listed.
 *
 *  A later entry for a file replaces an earlier one, as every extractor does.
 *  A directory entry, and the parent of every entry, makes a directory, and
 *  stating one directory twice changes nothing. The one listing no tree can
 *  hold is a path that is both a file and a directory, which no tree a
 *  release built can produce, so it refuses the archive. */
export interface ArchiveTree {
  /** Record a directory at `path`, a confined path that may be the root. */
  directory(path: string): void;
  /** Record a file at `path`, a confined path that is not the root. */
  file(path: string): void;
  /** Every directory the tree holds, each after its parent. */
  directories(): readonly string[];
}

export function archiveTree(): ArchiveTree {
  const kinds = new Map<string, "file" | "directory">();
  const ordered: string[] = [];

  const makeDirectory = (path: string): void => {
    if (path === "") return;
    const kind = kinds.get(path);
    if (kind === "directory") return;
    if (kind === "file") refuse(`${JSON.stringify(path)} is listed as a file and as a directory`);
    makeDirectory(parentOf(path));
    kinds.set(path, "directory");
    ordered.push(path);
  };

  return {
    directory: makeDirectory,
    file(path) {
      if (path === "") refuse("a file entry names the archive's root");
      if (kinds.get(path) === "directory") refuse(`${JSON.stringify(path)} is listed as a directory and as a file`);
      makeDirectory(parentOf(path));
      kinds.set(path, "file");
    },
    directories: () => ordered,
  };
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

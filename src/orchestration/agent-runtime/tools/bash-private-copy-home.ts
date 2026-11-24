/**
 * The home of a private project copy: the directories of it that Flywheel
 * creates and a command can replace, and the removal of a copy. The copy and
 * the pool that owns it both read a home through this file.
 */

import { lstatSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Log } from "../../../infra/log.js";
import { PRIVATE_COPY_RECORD } from "./bash-private-copy-record.js";

const log = Log.create({ service: "bash-private-copy" });

/** The entries of a home `<parent>/mutations/<id>` that Flywheel creates: the
 *  directory of the copies and the home. A command can replace either, by a
 *  link, a junction, or a file. The parent is the session scratch directory
 *  or the system temporary directory, which can be a person's own link, so
 *  it is never checked or removed. */
export function homeChain(home: string): readonly [mutations: string, home: string] {
  return [dirname(home), home];
}

/** The first of `paths`, in order, that is not a real directory. Reads with
 *  `lstat` only, so a link or junction is never followed, and a path below a
 *  replaced one is never read. A path that cannot be read counts as replaced. */
export function firstReplaced(paths: readonly string[]): { readonly path: string; readonly kind: "link" | "other" | "missing" } | undefined {
  for (const path of paths) {
    let stats;
    try {
      stats = lstatSync(path, { throwIfNoEntry: false });
    } catch {
      return { path, kind: "other" };
    }
    if (stats?.isDirectory()) continue;
    return { path, kind: stats?.isSymbolicLink() ? "link" : stats ? "other" : "missing" };
  }
  return undefined;
}

/** Deletes the copy in `home` off the command's critical path. Links are
 *  removed, never followed. The record goes first: a home without one is a copy no landing
 *  can read, which the idle scratch sweep removes within an hour, so a copy
 *  whose files cannot be removed now, such as a full clone on Windows with a
 *  file still open, never waits for the sweep's large-entry rule. Before each
 *  removal the home's chain (`homeChain`) is checked: an entry of it that is
 *  no longer a real directory is removed itself, never joined through, and
 *  the removal ends there. The returned promise settles when the removal
 *  ended; it never rejects. Only the pool that owns the copy calls this
 *  (`PrivateCopyPool.discard`), so its close waits for the removal. */
export function discardPrivateCopy(home: string): Promise<void> {
  return (async () => {
    for (const path of [join(home, PRIVATE_COPY_RECORD), home]) {
      const replaced = firstReplaced(homeChain(home));
      if (replaced?.kind === "missing") return;
      if (replaced) {
        log.warn("private copy removal met a replaced directory; only the replacement is removed", { kind: replaced.kind });
        await rm(replaced.path, { force: true, maxRetries: 3 });
        return;
      }
      await rm(path, { recursive: path === home, force: true, maxRetries: 3 });
    }
  })()
    .catch((error: unknown) => {
      log.warn("private copy removal failed; the scratch sweep retries it", { home, error: error instanceof Error ? error.message : String(error) });
    });
}

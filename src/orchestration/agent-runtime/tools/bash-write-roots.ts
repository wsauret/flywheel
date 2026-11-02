import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { readGitMetadata } from "../../../infra/git-metadata.js";

/** Read the current Git registry, without starting Git. A linked worktree
 * shares its common directory with the main tree and sibling registrations.
 * Missing metadata is normal for a project outside Git; unreadable metadata
 * propagates to the policy's analyzer-unavailable boundary. */
export function registeredWorktreeRoots(projectRoot: string): readonly string[] {
  let directory = projectRoot;
  while (!existsSync(join(directory, ".git"))) {
    const parent = dirname(directory);
    if (parent === directory) return [];
    directory = parent;
  }
  const metadata = readGitMetadata(join(directory, ".git"));
  if (!metadata) return [];
  const { gitDir, commonDir: common } = metadata;
  const roots = gitDir === common ? [directory] : [];
  if (gitDir !== common && basename(common) === ".git") {
    const config = join(common, "config");
    const text = existsSync(config) ? readFileSync(config, "utf8") : "";
    // A separate metadata directory is not a worktree. A core.worktree
    // override cannot establish dirname(common) as an authority either.
    let core = false;
    let bare = false;
    let worktree = false;
    for (const line of text.split(/\r?\n/)) {
      const section = /^\s*\[([^\]]+)\]/.exec(line);
      if (section) core = section[1]?.toLowerCase() === "core";
      else if (core) {
        bare ||= /^\s*bare\s*=\s*(?:true|yes|on|1)\s*(?:[#;].*)?$/i.test(line);
        worktree ||= /^\s*worktree\s*=/i.test(line);
      }
    }
    if (!bare && !worktree) roots.push(dirname(common));
  }
  const registry = join(common, "worktrees");
  if (!existsSync(registry)) return roots;
  for (const entry of readdirSync(registry)) {
    const gitdir = join(registry, entry, "gitdir");
    if (existsSync(gitdir)) roots.push(dirname(resolve(registry, entry, readFileSync(gitdir, "utf8").trim())));
  }
  return roots;
}

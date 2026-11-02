import { normalize } from "node:path";

/** Tag the release commit, publish it on origin main, and bring every local
 *  checkout of main to it.
 *
 *  A release runs in a linked worktree on its own branch, because the main
 *  checkout usually holds other agents' uncommitted work. Its push therefore
 *  names main as the destination, and it would leave the main checkout behind
 *  origin unless this step moves it. A clone shares no refs with the main
 *  checkout, so this step cannot reach one; the release never runs in a clone.
 *
 *  `git` runs one Git command in the release worktree and throws or exits on
 *  failure. A checkout whose uncommitted work overlaps the release refuses the
 *  fast-forward and stays untouched; autostash is disabled so a person's Git
 *  configuration cannot stash that work. Returns the checkouts that refused,
 *  each already reported on stderr, so publication continues and the caller
 *  fails once it ends. */
export function publishReleaseToMain(tag: string, git: (args: readonly string[]) => string): string[] {
  git(["tag", tag]);
  git(["push", "origin", "HEAD:refs/heads/main"]);
  git(["push", "origin", tag]);
  return git(["worktree", "list", "--porcelain"])
    .split(/\n\n+/)
    .filter((entry) => entry.split("\n").includes("branch refs/heads/main"))
    // Git for Windows prints forward slashes; callers compare native paths.
    .map((entry) => normalize(entry.slice("worktree ".length, entry.indexOf("\n"))))
    .filter((checkout) => {
      const merge = Bun.spawnSync(["git", "-C", checkout, "merge", "--ff-only", "--no-autostash", tag], { stdout: "pipe", stderr: "pipe", windowsHide: true });
      if (merge.exitCode === 0) return false;
      console.error(`release: ${checkout} did not fast-forward to ${tag}:\n${merge.stderr.toString().trim()}`);
      return true;
    });
}

/** The release publishes from a linked worktree on its own branch and must
 *  leave no local checkout of main behind origin. These cases run real Git
 *  against a temporary bare origin, so they live in the integration tier. */

import { describe, expect, test } from "bun:test";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publishReleaseToMain } from "../../../scripts/release-main.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=release", "-c", "user.email=release@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A bare origin, a main checkout with `concurrent.txt` and `package.json`,
 *  and a release worktree whose branch commits a version bump. */
function releaseFixture() {
  const root = realpathSync(temporaryDirectory("release-main-"));
  const origin = join(root, "origin.git");
  const main = join(root, "main");
  const release = join(root, "release");
  git(root, ["init", "-q", "--bare", "-b", "main", origin]);
  git(root, ["clone", "-q", origin, main]);
  writeFileSync(join(main, "concurrent.txt"), "base\n");
  writeFileSync(join(main, "package.json"), '{ "version": "0.0.1" }\n');
  git(main, ["add", "."]);
  git(main, ["commit", "-qm", "init"]);
  git(main, ["push", "-q", "origin", "main"]);
  git(main, ["worktree", "add", "-q", "-b", "release", release, "origin/main"]);
  writeFileSync(join(release, "package.json"), '{ "version": "0.0.2" }\n');
  git(release, ["commit", "-qam", "release: v0.0.2"]);
  return { origin, main, release };
}

describe("publishReleaseToMain", () => {
  test("lands the release on origin main and fast-forwards a main checkout that holds unrelated work", () => {
    const { origin, main, release } = releaseFixture();
    writeFileSync(join(main, "concurrent.txt"), "another agent's edit\n");

    expect(publishReleaseToMain("v0.0.2", (args) => git(release, args))).toEqual([]);

    const releaseCommit = git(release, ["rev-parse", "HEAD"]);
    expect(git(origin, ["rev-parse", "main", "v0.0.2^{commit}"]).split("\n")).toEqual([releaseCommit, releaseCommit]);
    expect(git(origin, ["branch", "--format=%(refname:short)"])).toBe("main");
    expect(git(main, ["rev-parse", "HEAD"])).toBe(releaseCommit);
    expect(readFileSync(join(main, "concurrent.txt"), "utf8")).toBe("another agent's edit\n");
  });

  test("leaves a main checkout whose uncommitted work overlaps the release untouched, even with autostash configured", () => {
    const { main, release } = releaseFixture();
    const before = git(main, ["rev-parse", "HEAD"]);
    git(main, ["config", "merge.autostash", "true"]);
    writeFileSync(join(main, "package.json"), '{ "version": "local" }\n');

    expect(publishReleaseToMain("v0.0.2", (args) => git(release, args))).toEqual([main]);

    expect(git(main, ["rev-parse", "HEAD"])).toBe(before);
    expect(readFileSync(join(main, "package.json"), "utf8")).toBe('{ "version": "local" }\n');
    expect(git(main, ["stash", "list"])).toBe("");
  });
});

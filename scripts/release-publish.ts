/** Publication of one verified release asset set to the public repository.
 *
 *  Ported from the retired release workflow's publish job, semantics intact:
 *  refuse any staged set that is not exactly the expected assets, create the
 *  release as a draft, verify the draft holds exactly the staged assets, read
 *  the release the public repository serves as `latest` one last time and
 *  refuse to move it backwards, and only then publish and mark it latest. A
 *  draft that fails any check is deleted. The pure checks are exported for
 *  unit tests; only `publishRelease` and `rollbackToRelease` talk to GitHub.
 */

import { compareSemanticVersions, parseSemanticVersion } from "./release-version.js";
import { PUBLIC_REPO, latestReleaseTag } from "./release-repo.js";
import { RELEASE_ASSETS } from "./release-contract.js";

/** Why a staged or uploaded asset-name set is not the publishable set, or
 *  undefined when it is exactly the archive of every target, the manifest,
 *  the digest file, and the two installers. */
export function assetSetViolation(found: readonly string[]): string | undefined {
  const expected = [...RELEASE_ASSETS].sort().join("\n");
  const actual = [...found].sort().join("\n");
  if (expected === actual) return undefined;
  return `the asset set is not the archive of every target, the manifest, and the two installers:\n${actual}`;
}

/** Whether publishing `candidate` moves `latest` strictly forward. An equal
 *  or older version must never become `latest`. */
export function movesLatestForward(candidateTag: string, latestTag: string): boolean {
  const candidate = parseSemanticVersion(candidateTag.replace(/^v/, ""));
  const latest = parseSemanticVersion(latestTag.replace(/^v/, ""));
  if (candidate === undefined || latest === undefined) return false;
  return compareSemanticVersions(candidate, latest) > 0;
}

function gh(args: string[]) {
  const result = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  return { exitCode: result.exitCode, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim() } as const;
}

/** Best-effort draft cleanup; the caller folds the outcome into its report
 *  so a draft that survives is never silent. */
function deleteDraft(tag: string): string {
  const deleted = gh(["release", "delete", tag, "--repo", PUBLIC_REPO, "--yes"]);
  return deleted.exitCode === 0 ? "the draft was deleted" : `the draft could not be deleted (run: gh release delete ${tag} --repo ${PUBLIC_REPO} --yes):\n${deleted.stderr}`;
}

/** Create, verify, and publish the release, and return the failure reason if
 *  any step refused. The release step pushed the tag to the public
 *  repository before this runs, so `gh release create` attaches the release
 *  to the tagged release commit. The assets carry their own identity through
 *  SHASUMS256.txt and release.json. */
export async function publishRelease(tag: string, assetPaths: readonly string[], notesFile: string): Promise<string | undefined> {
  const create = gh(["release", "create", tag, "--repo", PUBLIC_REPO, "--draft", "--title", tag, "--notes-file", notesFile, ...assetPaths]);
  if (create.exitCode !== 0) {
    // The remote may have created the draft before an upload failed.
    return `the draft could not be created:\n${create.stderr}\n${deleteDraft(tag)}`;
  }

  const view = gh(["release", "view", tag, "--repo", PUBLIC_REPO, "--json", "assets", "--jq", ".assets[].name"]);
  if (view.exitCode !== 0) return `the draft could not be read back:\n${view.stderr}\n${deleteDraft(tag)}`;
  const uploaded = view.stdout === "" ? [] : view.stdout.split("\n");
  const violation = assetSetViolation(uploaded);
  if (violation !== undefined) return `the draft does not hold exactly the verified artifacts: ${violation}\n${deleteDraft(tag)}`;

  // The version was derived from `latest` before the gates and builds ran.
  // An operator can have moved it since, and an older or equal release must
  // never become `latest`, so the last word is read here.
  let latest: string | undefined;
  try {
    latest = await latestReleaseTag();
  } catch (error) {
    return `${error instanceof Error ? error.message : String(error)}\n${deleteDraft(tag)}`;
  }
  if (latest !== undefined && !movesLatestForward(tag, latest)) {
    return `${tag} is not newer than ${latest}, the release the public repository now serves as latest\n${deleteDraft(tag)}`;
  }

  const publish = gh(["release", "edit", tag, "--repo", PUBLIC_REPO, "--draft=false", "--latest"]);
  if (publish.exitCode !== 0) return `the draft could not be published:\n${publish.stderr}\n${deleteDraft(tag)}`;
  return undefined;
}

/** Make an earlier published release `latest` again, and return the failure
 *  reason if it refused. A draft is no published release, so it is refused
 *  rather than published as a side effect of a rollback. */
export function rollbackToRelease(tag: string): string | undefined {
  if (parseSemanticVersion(tag.replace(/^v/, "")) === undefined) return `${tag} is not a strict vMAJOR.MINOR.PATCH release tag`;
  const view = gh(["release", "view", tag, "--repo", PUBLIC_REPO, "--json", "isDraft", "--jq", ".isDraft"]);
  if (view.exitCode !== 0) return `${tag} names no release on ${PUBLIC_REPO}:\n${view.stderr}`;
  if (view.stdout !== "false") return `${tag} is a draft, and a draft is no published release`;
  const edit = gh(["release", "edit", tag, "--repo", PUBLIC_REPO, "--latest"]);
  if (edit.exitCode !== 0) return `latest could not be moved to ${tag}:\n${edit.stderr}`;
  return undefined;
}

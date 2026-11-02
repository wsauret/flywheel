/** Decide whether a pushed tag may publish a release.
 *
 *  A release names exactly one version. `package.json` is where that version
 *  is stated, so the tag must be `v` and that exact version, and the version
 *  this gate returns is the one the manifest and the release then carry
 *  (ARCH-DISTRIBUTION-003). No later step re-derives it from the tag.
 *
 *  A normal publish only ever moves forward, and the release the repository
 *  now serves as `latest` is the single authority for what "forward" means.
 *  That authority is the current non-draft latest release GitHub reports, not
 *  the set of Git tags: a tag that names no release publishes nothing, and an
 *  operator who marks an older release latest has moved the line the next
 *  publish must clear. Going backwards is a rollback, which is a deliberate
 *  act with its own path, never this one.
 *
 * Usage:
 *   bun run scripts/release-version-gate.ts --tag v1.4.2 --latest-release v1.4.1
 */

import { compareSemanticVersions, parseSemanticVersion } from "./release-version.js";

export interface ReleaseVersionGateInputs {
  /** The pushed tag, exactly as `GITHUB_REF_NAME` states it. */
  readonly tag: string;
  /** The version `package.json` states. */
  readonly packageVersion: string;
  /** The tag of the release the repository now serves as `latest`, exactly as
   *  GitHub reports it, or the empty string when the repository serves none.
   *  A draft and a prerelease are no latest release, so GitHub reports
   *  neither, and a repository that serves none takes its first release. */
  readonly latestReleaseTag: string;
}

export class ReleaseVersionGateError extends Error {
  constructor(reason: string) {
    super(`The tag cannot publish a release: ${reason}`);
    this.name = "ReleaseVersionGateError";
  }
}

/** The canonical `major.minor.patch` this tag publishes.
 *
 *  Throws `ReleaseVersionGateError` when the tag and `package.json` name
 *  different versions, when `package.json` states no strict release, when the
 *  latest release names no strict release and so orders against nothing, or
 *  when the candidate is not strictly newer than that latest release. */
export function validateReleaseVersion(inputs: ReleaseVersionGateInputs): string {
  const stated = parseSemanticVersion(inputs.packageVersion);
  if (stated === undefined) throw new ReleaseVersionGateError(`package.json states ${JSON.stringify(inputs.packageVersion)}, which is not a strict major.minor.patch release`);
  if (inputs.tag !== `v${stated.canonical}`) throw new ReleaseVersionGateError(`the tag ${inputs.tag} is not v${stated.canonical}, the version package.json states`);

  const latestTag = inputs.latestReleaseTag.trim();
  if (latestTag === "") return stated.canonical;

  const latest = parseSemanticVersion(latestTag);
  if (latest === undefined) throw new ReleaseVersionGateError(`the latest release ${latestTag} states no strict major.minor.patch release, so nothing orders against it`);
  if (compareSemanticVersions(stated, latest) <= 0) {
    throw new ReleaseVersionGateError(`${inputs.tag} is not newer than ${latestTag}, the release this repository now serves as latest; a publish only moves forward`);
  }
  return stated.canonical;
}

if (import.meta.main) {
  const argument = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
  };

  const tag = argument("--tag");
  if (tag === undefined || tag === "") throw new ReleaseVersionGateError("no --tag was stated");
  const latestReleaseTag = argument("--latest-release");
  if (latestReleaseTag === undefined) throw new ReleaseVersionGateError("no --latest-release was stated; the empty string states that this repository serves no latest release");

  const packageJson: unknown = await Bun.file(new URL("../package.json", import.meta.url)).json();
  if (typeof packageJson !== "object" || packageJson === null || !("version" in packageJson) || typeof packageJson.version !== "string") throw new ReleaseVersionGateError("package.json has no string version");
  const packageVersion = packageJson.version;
  console.log(validateReleaseVersion({ tag, packageVersion, latestReleaseTag }));
}

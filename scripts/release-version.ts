/** The strict release version Flywheel publishes and tags (ARCH-DISTRIBUTION-003).
 *
 *  The release side admits only `major.minor.patch`, so every tag and every
 *  `release.json` states a version that each installed client orders. That
 *  strictness is the release's own rule: an installed client reads versions
 *  liberally (`src/infra/update/version-order.ts`), so it never refuses a
 *  version shape a later release chooses. */

const RELEASE_VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** `major.minor.patch`, with no `v` prefix and no build metadata. This is
   *  the only form that enters a release tag. */
  readonly canonical: string;
}

/** A strict release version. A leading `v` and build metadata name no
 *  different release, so both are dropped from the canonical form; a
 *  prerelease and anything else parse to nothing. */
export function parseSemanticVersion(input: string): SemanticVersion | undefined {
  const match = RELEASE_VERSION.exec(input);
  if (!match) return undefined;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return { major, minor, patch, canonical: `${major}.${minor}.${patch}` };
}

/** Negative when `a` is the older release, zero when both name one release.
 *  Suitable as an `Array.prototype.sort` comparator. */
export function compareSemanticVersions(a: SemanticVersion, b: SemanticVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** Release version identity and order as an installed client reads it
 *  (ARCH-DISTRIBUTION-010).
 *
 *  An installed client is liberal: `parseReleaseVersion` reads whatever
 *  version a release states, because a client that refused a version shape
 *  of a later release could never update to it. It reads SemVer 2.0, with a
 *  prerelease and build metadata, into an order. A version it cannot read as
 *  SemVer it keeps as text with no order. Its one refusal is a version that
 *  cannot be one directory name, because the version names the build's
 *  directory under the versions root.
 *
 *  The strict `major.minor.patch` form that Flywheel publishes and tags is
 *  the release side's rule, in `scripts/release-version.ts`. */

/** SemVer 2.0, with an optional leading `v`. */
const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** SemVer precedence: three numbers, then the prerelease identifiers, where
 *  a version with none outranks one with any. */
interface Precedence {
  readonly core: readonly [number, number, number];
  readonly prerelease: readonly (number | string)[];
}

/** A version as an installed client reads it from a release. */
export interface ReleaseVersion {
  /** The version as the build's directory name and as people see it: the
   *  stated text, with a SemVer `v` prefix and build metadata dropped. */
  readonly canonical: string;
  /** The SemVer order, or nothing when the version is not SemVer. */
  readonly precedence?: Precedence;
}

/** The version a release states, or nothing when the text cannot be one
 *  directory name (`isDirectoryName`). */
export function parseReleaseVersion(input: string): ReleaseVersion | undefined {
  const match = SEMVER.exec(input);
  if (match) {
    const core = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
    const prerelease = match[4] === undefined ? [] : match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part));
    const canonical = `${core.join(".")}${match[4] === undefined ? "" : `-${match[4]}`}`;
    return { canonical, precedence: { core, prerelease } };
  }
  return isDirectoryName(input) ? { canonical: input } : undefined;
}

/** Whether `name` can be one directory name of the installer's tree on
 *  every platform: not empty, not opening with `.` (the installer's own
 *  private names do, and so do `.` and `..`), not ending with `.` or a space
 *  (Windows drops both), holding no path separator, NUL, control character,
 *  or character Windows refuses in a name, and not a Windows device name,
 *  which Windows opens as the device whatever extension follows it. */
export function isDirectoryName(name: string): boolean {
  // oxlint-disable-next-line no-control-regex -- boundary: a control character cannot be part of a directory name on every platform
  return name !== "" && !name.startsWith(".") && !/[. ]$/.test(name) && !/[/\\:*?"<>|\u0000-\u001f]/.test(name) && !WINDOWS_DEVICE.test(name);
}

/** CON, PRN, AUX, NUL, and COM or LPT with one digit or superscript digit,
 *  each with any extension. */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\..*)?$/i;

/** Negative when `a` is the older release, zero when both name one release,
 *  and nothing when the two cannot be ordered because one is not SemVer. */
export function compareReleaseVersions(a: ReleaseVersion, b: ReleaseVersion): number | undefined {
  if (a.canonical === b.canonical) return 0;
  if (a.precedence === undefined || b.precedence === undefined) return undefined;
  return comparePrecedence(a.precedence, b.precedence);
}

/** Whether `candidate` is a later release than `than`.
 *
 *  Two versions this client cannot order are different releases, and the
 *  release side publishes only forward, so the one the channel states is the
 *  later one. A version this client can order is later only by SemVer
 *  precedence, so an operator who moves `latest` back to an older release
 *  never moves a client back. */
export function isLaterRelease(candidate: ReleaseVersion, than: ReleaseVersion): boolean {
  const order = compareReleaseVersions(candidate, than);
  return order === undefined || order > 0;
}

function comparePrecedence(a: Precedence, b: Precedence): number {
  const [aMajor, aMinor, aPatch] = a.core;
  const [bMajor, bMinor, bPatch] = b.core;
  const core = aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
  if (core !== 0) return core;
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return b.prerelease.length - a.prerelease.length;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    if (typeof left === "number" && typeof right === "number") return left - right;
    if (typeof left === "number") return -1;
    if (typeof right === "number") return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

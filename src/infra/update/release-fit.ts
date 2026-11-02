import { compareReleaseVersions, parseReleaseVersion } from "./version-order.js"

/** One Flywheel as another program sees it: its release, and the runtime
 *  protocol that release speaks. A source run states no release. */
export interface ReleaseSide {
  readonly version: string | undefined
  readonly protocolVersion: number
}

/** What a terminal does about the release of a machine it reaches through
 *  the relay (PI-REMOTE-016). The machine's release decides: a terminal never
 *  changes the machine's runtime.
 *
 *  - `attach`: both run one release.
 *  - `install`: the machine runs a later release, which the terminal
 *    installs and then runs.
 *  - `wait`: the machine runs an earlier release. The terminal attaches once
 *    the machine reports the terminal's release.
 *  - `cannot-install`: the machine runs a later build that no release
 *    install reaches, because this terminal runs from source (`source`) or
 *    the machine runs a build its release does not name (`unreleased`). */
export type ReleaseFit =
  | { readonly kind: "attach" }
  | { readonly kind: "install"; readonly version: string }
  | { readonly kind: "wait" }
  | { readonly kind: "cannot-install"; readonly reason: "source" | "unreleased" }

/** Two releases are ordered by SemVer. A source terminal, a release text that
 *  is not SemVer, and one release text spoken with two protocols are ordered
 *  by protocol version, because that is the order the runtime enforces. */
export function releaseFit(terminal: ReleaseSide, machine: { readonly version: string; readonly protocolVersion: number }): ReleaseFit {
  const byProtocol = Math.sign(machine.protocolVersion - terminal.protocolVersion)
  if (terminal.version === undefined) {
    if (byProtocol === 0) return { kind: "attach" }
    return byProtocol > 0 ? { kind: "cannot-install", reason: "source" } : { kind: "wait" }
  }
  const theirs = parseReleaseVersion(machine.version)
  const ours = parseReleaseVersion(terminal.version)
  const byRelease = theirs === undefined || ours === undefined ? undefined : compareReleaseVersions(theirs, ours)
  if (byRelease === 0) {
    if (byProtocol === 0) return { kind: "attach" }
    return byProtocol > 0 ? { kind: "cannot-install", reason: "unreleased" } : { kind: "wait" }
  }
  const order = byRelease ?? byProtocol
  if (order === 0) return { kind: "attach" }
  return order > 0 ? { kind: "install", version: machine.version } : { kind: "wait" }
}

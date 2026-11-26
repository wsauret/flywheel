import { compareReleaseVersions, parseReleaseVersion } from "../../infra/update/version-order.js"
import type { AttachedRuntimeClient } from "../../protocol/runtime/app-service-types.js"

/** The seam through which the terminal opens a project on another machine
 *  (PI-REMOTE-016). The kernel runs the terminal for the project; the module
 *  that owns remote access owns the device, the machine and project picker,
 *  and the relay transport. A module contributes it as `terminalRemote`, and
 *  the kernel loads it only for a launch that offers or opens such a project,
 *  so a local launch reads none of it (ARCH-RUNTIME-012). */
export interface TerminalRemoteContribution {
  readonly load: () => Promise<TerminalRemote>
}

export interface TerminalRemote {
  /** How many machines this terminal is paired with, read from its device
   *  store without creating one. Throws with a message a person can act on
   *  when the store is in a shape this build does not read. */
  pairedMachines(userDataRoot: string): number
  /** Asks the person for a project on a paired machine, pairing another
   *  machine from a pasted link on the way when they give one, or creating
   *  a project on a machine from a repository they name, and settles
   *  how this terminal's release fits the machine's: it waits while the
   *  machine runs an earlier release. Rejects with the prompt's own rejection
   *  when the person interrupts it, and with a message a person can act on
   *  when no release this terminal can install reaches the machine's. */
  choose(request: TerminalRemoteRequest): Promise<TerminalRemoteChoice>
}

export interface TerminalRemoteRequest {
  readonly userDataRoot: string
  /** The release and protocol of this terminal's own build. */
  readonly terminal: ReleaseSide
  readonly prompt: (question: string) => Promise<string>
  readonly print: (line: string) => void
  /** The project a predecessor terminal handed this one, as `RemoteAttach.handoff`
   *  named it. It is opened without asking while the machine stays paired. */
  readonly handed?: string
}

export type TerminalRemoteChoice =
  | { readonly kind: "attach"; readonly attach: RemoteAttach }
  /** The person ended the prompt without a choice. */
  | { readonly kind: "cancelled" }
  /** The machine runs a later release. The terminal installs `version` and
   *  becomes it, handing it the project as `handoff`. */
  | { readonly kind: "install"; readonly version: string; readonly machine: string; readonly handoff: string }

/** One project on a paired machine, chosen and released to attach. */
export interface RemoteAttach {
  readonly machine: string
  readonly project: string
  /** The machine and the project's placement, which key this terminal's own
   *  state for the project under the account's data root. */
  readonly runtimeId: string
  readonly placementId: string
  /** What a successor terminal is handed to open this project again. */
  readonly handoff: string
  /** The release the machine runs for the project, as presence states it. */
  readonly release: { readonly version: string; readonly protocolVersion: number }
  /** The runtime client over the relay. Its `close` ends the relay client too. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- diagnostic sink: callers pass any caught value or context record for logging
  connect(onDiagnostic: (message: string, detail: unknown) => void): AttachedRuntimeClient
  /** Ends the relay client without a runtime client, as a startup that fails
   *  before it connects does. Its presence sockets would otherwise keep the
   *  process alive. */
  close(): void
}

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

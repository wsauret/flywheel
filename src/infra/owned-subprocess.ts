import type { CommandHandover } from "./command-handover.js"
import { errorMessage } from "./error-message.js"
import { Log } from "./log.js"
import type { OwnedChild, OwnedExitStatus } from "./owned-subprocess-backend.js"
import type { TerminationCause } from "./process-container.js"

const log = Log.create({ service: "owned-subprocess" })

/** Whether the guardian answered the release of this container.
 *  `unacknowledged` means the container is gone but its lease is not: the token
 *  stays on the guardian's kill list until the guardian sweeps it at host exit,
 *  so an owner still holding it has not become settled. */
export type OwnershipSettlement = "surrendered" | "unacknowledged"

export interface OwnedProcessExit extends OwnedExitStatus {
  /** Ownership is part of the settlement, not a detail of it. */
  readonly ownership: OwnershipSettlement
}

/** `handed_over`: the command's supervisor holds it alone, reachable at the
 *  channel the handover named, and this owner's lease on it is released.
 *  `exited`: the command ended first, and `exit` is its ordinary settlement.
 *  `unacknowledged`: the supervisor did not answer within the bound, so this
 *  owner still holds the command. */
export type HandoverAnswer =
  | { readonly kind: "handed_over" }
  | { readonly kind: "exited"; readonly exit: OwnedProcessExit }
  | { readonly kind: "unacknowledged" }

/** A subprocess whose lifetime is bounded by Flywheel's own, including a
 *  Flywheel crash. Ownership is established before the payload runs and
 *  surrendered only after the whole container is gone, or handed to a later
 *  owner. */
export interface OwnedProcess {
  /** The container's pid, which is the per-command supervisor's. It names the
   *  container for as long as the container exists, so it can never be a
   *  recycled pid that belongs to something else. */
  readonly pid: number
  readonly token: string
  readonly stdin: OwnedChild["stdin"]
  readonly stdout: OwnedChild["stdout"]
  readonly stderr: OwnedChild["stderr"]
  /** Settles once the container is empty and the guardian has answered the
   *  release of it, or failed to. Never before the container is empty. */
  readonly exited: Promise<OwnedProcessExit>
  /** Asks the container to end, and settles with the same exit every other
   *  observer sees. Repeated calls join the first termination.
   *
   *  With `end`, this side ends the container at once, for `end`'s reason:
   *  no grace, and no wait for the container's supervisor to run, although
   *  a stop hold still delays it. That is for a payload that holds nothing a
   *  stop would save, and it also cuts short a termination already asked
   *  for. */
  terminate(end?: TerminationCause): Promise<OwnedProcessExit>
  /** Hands the command to a later owner, for a process launched with
   *  `handover` or adopted after a handover. Once it answers `handed_over`
   *  the command's end belongs to the owner that adopts it, so neither
   *  `exited` nor `terminate()` settles here any more. */
  readonly handOver?: (request: CommandHandover) => Promise<HandoverAnswer>
}

export interface CreateOwnedProcessInput {
  readonly pid: number
  readonly token: string
  readonly child: OwnedChild
  readonly release: () => Promise<void>
  readonly stop: (end?: TerminationCause) => void
  readonly handOver?: (request: CommandHandover) => Promise<HandoverAnswer>
}

export function createOwnedProcess(input: CreateOwnedProcessInput): OwnedProcess {
  // One settlement promise per command, started eagerly and shared by every
  // observer.
  //
  // `child` is the container's supervisor, not the payload alone, and its
  // `exited` settles only once the container is proven empty, carrying the
  // payload's own status. So waiting on it is waiting for the payload, for
  // everything the payload started, and for the streams they held - a payload
  // that exits while a descendant keeps the group alive has not settled
  // anything yet, and neither has a supervisor that was killed while its
  // payload still ran.
  //
  // Ordering is the rest of the point: the guardian must forget this container
  // before any caller can act on the exit, so a caller that reuses the pid or
  // spawns a replacement can never race the guardian's kill list.
  const exited = (async (): Promise<OwnedProcessExit> => {
    const exit = await input.child.exited
    try {
      await input.release()
      return { ...exit, ownership: "surrendered" }
    } catch (err) {
      // The container is gone, so its exit status is real and reported. The
      // lease is not, and saying so is the point: the owner of this container
      // reads `ownership` and keeps holding it rather than reporting a
      // settlement the guardian never acknowledged.
      log.warn("failed to surrender process ownership", { token: input.token, error: errorMessage(err) })
      return { ...exit, ownership: "unacknowledged" }
    }
  })()

  let termination: Promise<OwnedProcessExit> | undefined
  let ended = false

  return {
    pid: input.pid,
    token: input.token,
    stdin: input.child.stdin,
    stdout: input.child.stdout,
    stderr: input.child.stderr,
    exited,
    terminate(end) {
      if (end !== undefined && !ended) {
        ended = true
        input.stop(end)
      } else if (!termination) {
        // TERM, grace and KILL belong to the container's own supervisor, so
        // this side asks once and then waits for the same settlement everyone
        // else waits for.
        input.stop()
      }
      termination ??= exited
      return termination
    },
    ...(input.handOver === undefined ? {} : { handOver: input.handOver }),
  }
}

/** The status of a container whose payload could not be started at all: the
 *  program is missing, is not executable, or needs a loader that this machine
 *  does not have. It is the shell's status for a command that cannot run, so a
 *  payload that exits with it states the same. */
export const LAUNCH_FAILED_EXIT_CODE = 127

/** Whether `exit` states that the payload never ran. A supervisor that was
 *  killed states nothing about its payload. */
export function launchFailed(exit: OwnedExitStatus): boolean {
  return exit.statusOf === "payload" && exit.signal === null && exit.code === LAUNCH_FAILED_EXIT_CODE
}

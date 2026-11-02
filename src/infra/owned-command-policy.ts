import { commandSupervisorEntry } from "./command-supervisor-entry.js"
import type { StopHold } from "./stop-hold.js"
import type { ProcessPriority } from "./process-priority.js"

const KILL_GRACE_FLAG = "--kill-grace-ms"
const GUARDIAN_PID_FLAG = "--guardian-pid"
const GUARDIAN_IDENTITY_FLAG = "--guardian-identity"
const CONTAINER_FLAG = "--container"
const LIFETIME_FLAG = "--lifetime"
const BACKGROUND_PRIORITY_FLAG = "--background-priority"
const HANDOVER_FLAG = "--handover"
const STDIN_IGNORE_FLAG = "--stdin-ignore"
const CHILDREN_BREAK_AWAY_FLAG = "--children-break-away"
const STOP_HOLD_FLAG = "--stop-hold"
const STOP_HOLD_MS_FLAG = "--stop-hold-ms"
const ON_PAYLOAD_EXIT_FLAG = "--on-payload-exit"

/** The container this supervisor leads, as its platform names one.
 *
 *  A POSIX process group is named by the process that leads it, so a supervisor
 *  there needs no name: it is that process, and the group is whatever it and
 *  its descendants make up. A Windows job object is named when it is created
 *  and outlives every member, so the supervisor is told the name it must open
 *  to address the container it was put in.
 *
 *  A union rather than an optional name: the platform that has a name always
 *  has one, and the compiler is what says so. */
type SupervisedContainer =
  | { readonly kind: "process-group" }
  | {
      readonly kind: "job"
      readonly token: string
      /** The job lets its members' children leave it once the supervisor's
       *  payload runs in it. */
      readonly childrenBreakAway?: true
    }

const JOB_CONTAINER_PREFIX = "job:"
const GROUP_CONTAINER = "process-group"

function containerArgument(container: SupervisedContainer): string {
  return container.kind === "job" ? `${JOB_CONTAINER_PREFIX}${container.token}` : GROUP_CONTAINER
}

function parseContainer(value: string, childrenBreakAway: boolean): SupervisedContainer {
  if (value === GROUP_CONTAINER && !childrenBreakAway) return { kind: "process-group" }
  const token = value.startsWith(JOB_CONTAINER_PREFIX) ? value.slice(JOB_CONTAINER_PREFIX.length) : ""
  if (token.length === 0) throw new Error(`owned command supervisor requires ${CONTAINER_FLAG} <process-group|job:token>, and ${CHILDREN_BREAK_AWAY_FLAG} only with a job`)
  return { kind: "job", token, ...(childrenBreakAway ? { childrenBreakAway: true as const } : {}) }
}

/** What one container's supervisor must know beyond the command itself. */
interface GuardedLifetime {
  readonly onPayloadExit?: "end-descendants"
  readonly lifetime: "guarded"
  /** The guardian whose liveness this container depends on. */
  readonly guardianPid: number
  /** The guardian's creation identity, bound to its pid. */
  readonly guardianIdentity: string
  readonly container: SupervisedContainer
  /** The launcher may hand this container over to a later owner. Only such a
   *  supervisor answers the handover word, and it holds its payload's stdin
   *  itself unless ignored, so the launcher's exit never ends that stream. */
  readonly handover?: true
  readonly stdin?: "ignore"
  /** Defers the first signal of a stop or an end (see `StopHold`). */
  readonly stopHold?: StopHold
}

interface PersistentLifetime {
  readonly lifetime: "persistent"
  readonly container: { readonly kind: "process-group" }
}

export interface ContainerPolicy {
  /** How long the container's escalation waits between TERM and KILL. */
  readonly killGraceMs: number
  /** The guardian whose liveness ordinary work depends on. */
  readonly guardianPid: number
  readonly priority?: ProcessPriority
}

/** The policy a supervisor is actually launched with. The identity is added by
 *  the launch, not by the caller: only the raw-launch authority can read it,
 *  and it must describe the guardian as it exists at the moment of the launch. */
export type CommandSupervisorPolicy =
  | (ContainerPolicy & GuardedLifetime)
  | (Omit<ContainerPolicy, "guardianPid"> & PersistentLifetime)

export type CommandSupervisorArgv = CommandSupervisorPolicy & { readonly command: readonly string[] }

/** Internal argv, so it is decoded strictly: the launcher is Flywheel and a
 *  malformed invocation is a producer bug, not input to repair. */
export function parseCommandSupervisorArgv(argv: readonly string[]): CommandSupervisorArgv {
  const separator = argv.indexOf("--")
  const command = separator < 0 ? [] : argv.slice(separator + 1)
  if (command.length === 0) throw new Error("owned command supervisor requires a command after `--`")
  const killGraceMs = numberFlag(argv, KILL_GRACE_FLAG, separator)
  const lifetime = stringFlag(argv, LIFETIME_FLAG, separator)
  const container = parseContainer(stringFlag(argv, CONTAINER_FLAG, separator), hasFlag(argv, CHILDREN_BREAK_AWAY_FLAG, separator))
  const priority = argv.includes(BACKGROUND_PRIORITY_FLAG) ? "background" as const : undefined
  const handover = hasFlag(argv, HANDOVER_FLAG, separator)
  const onPayloadExit = flagAt(argv, ON_PAYLOAD_EXIT_FLAG, separator)
  if (hasFlag(argv, ON_PAYLOAD_EXIT_FLAG, separator) && onPayloadExit !== "end-descendants") throw new Error("invalid owned command natural-exit policy")
  if (lifetime === "persistent") {
    if (container.kind !== "process-group") throw new Error("persistent command supervisor requires a process-group container")
    if (flagAt(argv, GUARDIAN_PID_FLAG, separator) !== undefined || flagAt(argv, GUARDIAN_IDENTITY_FLAG, separator) !== undefined) {
      throw new Error("persistent command supervisor cannot have a guardian")
    }
    if (handover) throw new Error("persistent command supervisor cannot be handed over")
    if (onPayloadExit !== undefined) throw new Error("persistent command supervisor cannot require descendant settlement")
    return { lifetime, killGraceMs, container, command, ...(priority === undefined ? {} : { priority }) }
  }
  if (lifetime !== "guarded") throw new Error(`owned command supervisor requires ${LIFETIME_FLAG} <guarded|persistent>`)
  return {
    lifetime,
    killGraceMs,
    guardianPid: numberFlag(argv, GUARDIAN_PID_FLAG, separator),
    guardianIdentity: stringFlag(argv, GUARDIAN_IDENTITY_FLAG, separator),
    container,
    command,
    ...(priority === undefined ? {} : { priority }),
    ...(handover ? { handover: true as const } : {}),
    ...(onPayloadExit === undefined ? {} : { onPayloadExit: "end-descendants" as const }),
    ...(hasFlag(argv, STDIN_IGNORE_FLAG, separator) ? { stdin: "ignore" as const } : {}),
    ...(flagAt(argv, STOP_HOLD_FLAG, separator) === undefined ? {} : { stopHold: { path: stringFlag(argv, STOP_HOLD_FLAG, separator), boundMs: numberFlag(argv, STOP_HOLD_MS_FLAG, separator) } }),
  }
}

function hasFlag(argv: readonly string[], flag: string, separator: number): boolean {
  const at = argv.indexOf(flag)
  return at >= 0 && at < separator
}

function flagAt(argv: readonly string[], flag: string, separator: number): string | undefined {
  const at = argv.indexOf(flag)
  return at >= 0 && at < separator ? argv[at + 1] : undefined
}

function numberFlag(argv: readonly string[], flag: string, separator: number): number {
  const value = Number(flagAt(argv, flag, separator) ?? Number.NaN)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`owned command supervisor requires ${flag} <number>`)
  return value
}

function stringFlag(argv: readonly string[], flag: string, separator: number): string {
  const value = flagAt(argv, flag, separator)
  if (value === undefined || value.length === 0) throw new Error(`owned command supervisor requires ${flag} <value>`)
  return value
}

/** Argv that supervises `command`: the entry this process launches the
 *  supervisor through, the policy, and the `--` separated payload. */
export function commandSupervisorArgv(command: readonly string[], policy: CommandSupervisorPolicy): readonly string[] {
  return [
    ...commandSupervisorEntry(),
    LIFETIME_FLAG, policy.lifetime,
    KILL_GRACE_FLAG, String(policy.killGraceMs),
    ...(policy.lifetime === "guarded"
      ? [GUARDIAN_PID_FLAG, String(policy.guardianPid), GUARDIAN_IDENTITY_FLAG, policy.guardianIdentity]
      : []),
    CONTAINER_FLAG, containerArgument(policy.container),
    ...(policy.container.kind === "job" && policy.container.childrenBreakAway === true ? [CHILDREN_BREAK_AWAY_FLAG] : []),
    ...(policy.priority === "background" ? [BACKGROUND_PRIORITY_FLAG] : []),
    ...(policy.lifetime === "guarded" && policy.handover === true ? [HANDOVER_FLAG] : []),
    ...(policy.lifetime === "guarded" && policy.stdin === "ignore" ? [STDIN_IGNORE_FLAG] : []),
    ...(policy.lifetime === "guarded" && policy.onPayloadExit !== undefined ? [ON_PAYLOAD_EXIT_FLAG, policy.onPayloadExit] : []),
    ...(policy.lifetime === "guarded" && policy.stopHold !== undefined ? [STOP_HOLD_FLAG, policy.stopHold.path, STOP_HOLD_MS_FLAG, String(policy.stopHold.boundMs)] : []),
    "--",
    ...command,
  ]
}

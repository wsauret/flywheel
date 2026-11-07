import { Log } from "./log.js"
import { bootIdentity, processStart, type BootIdentity, type ProcessStart } from "./process-container.js"

/** The identity a durable record gives the process that holds it, and the
 *  one answer about whether that process still holds it.
 *
 *  A pid alone cannot name a process across time: the kernel gives a freed
 *  pid to the next process, so a record that names only a pid can keep a
 *  resource held by a stranger, or can wait for ever on one. A holder record
 *  therefore names its process by pid, the kernel's start stamp, and the
 *  boot the stamp counts from.
 *
 *  The format is durable. Records outlive the build that wrote them, and
 *  earlier and later builds read them. Version 1 is `{v: 1, start, boot?}`:
 *  `start` is the decimal start stamp (at most 20 digits), and `boot` is the
 *  host boot as 32 lowercase hex characters, present on macOS and Linux and
 *  absent on Windows, whose creation FILETIME is absolute. A record without
 *  `v` names no identity: an earlier build wrote it, or a process that could
 *  not read its own identity. It is a valid shape for good, not a shape to
 *  convert. It has two encodings:
 *
 *  - JSON: the fields sit flat beside the record's own `pid` and `owner`.
 *    Earlier builds read a record by `pid` and `owner` and ignore the rest.
 *  - Text (the session owner record): `<pid>[ <v> <start>[ <boot>]]`. A bare
 *    decimal is the case without identity. With the largest Linux pid
 *    (4194304), a 20-digit start, and a boot, the text is 63 bytes, below the
 *    64 bytes that earlier builds read. Earlier builds take the leading pid
 *    with `parseInt`. */

/** Version 1 of a holder's identity, as a record stores it. */
export interface HolderIdentity {
  readonly v: 1
  readonly start: string
  readonly boot?: string
}

/** A holder as this build reads it from a record. `without-identity` is a
 *  record that an earlier build wrote, or that a process wrote while it could
 *  not read its own identity. `unreadable-identity` is a version this build
 *  does not know, or version 1 fields that do not decode. */
export type ProcessHolder =
  | { readonly kind: "without-identity"; readonly pid: number }
  | { readonly kind: "identified"; readonly pid: number; readonly identity: HolderIdentity }
  | { readonly kind: "unreadable-identity"; readonly pid: number; readonly version: string }

/** Why a holder is proven gone: its pid holds no process, holds a process
 *  with another start stamp, or the record names another boot. */
export type GoneProof = "absent" | "another-process" | "another-boot"

/** Whether a record's holder still holds it. Only `gone` licenses a reclaim,
 *  a sweep, or a recovery. `unknown` is a question the kernel or the record
 *  did not answer, and it never releases anything. */
export type HolderState =
  | { readonly kind: "alive" }
  | { readonly kind: "gone"; readonly proof: GoneProof }
  | { readonly kind: "unknown"; readonly reason: string }

/** The kernel facts a holder answer rests on, injected so that every answer
 *  is testable on any host. */
export interface HolderKernel {
  start(pid: number): ProcessStart
  boot(): BootIdentity
}

interface ProcessHolders {
  /** This process's own identity, or undefined while the kernel does not
   *  give it. Only a read that succeeds is kept, so each call after a failure
   *  asks again. A caller without the identity still writes its record, which
   *  names its pid alone: every reader waits for such a holder while its pid
   *  runs and never takes it over, so only the protection against a reused
   *  pid is lost. The first failure in a process is recorded once, with its
   *  reason. */
  own(): HolderIdentity | undefined
  state(holder: ProcessHolder): HolderState
}

const log = Log.create({ service: "process-holder" })

/** A canonical decimal of at most 20 digits: the width of a 64-bit stamp,
 *  and the width the 63-byte text bound rests on. A string compare needs the
 *  canonical form, because "07" and "7" would otherwise read as two stamps. */
const START = /^(0|[1-9]\d{0,19})$/
const BOOT = /^[0-9a-f]{32}$/
const PID = /^[1-9]\d*$/

const ALIVE: HolderState = { kind: "alive" }
const gone = (proof: GoneProof): HolderState => ({ kind: "gone", proof })

export function createProcessHolders(kernel: HolderKernel): ProcessHolders {
  let own: HolderIdentity | undefined
  let ownUnreadableRecorded = false
  let hostBoot: Exclude<BootIdentity, { readonly kind: "unproven" }> | undefined
  const warnedVersions = new Set<string>()

  /** The host boot never changes while this process runs, so only an
   *  answer that did not come is asked for again. */
  const readHostBoot = (): BootIdentity => {
    if (hostBoot !== undefined) return hostBoot
    const answer = kernel.boot()
    if (answer.kind !== "unproven") hostBoot = answer
    return answer
  }

  /** What the kernel says of the pid, before any start stamp is compared. */
  const startOf = (pid: number): Extract<ProcessStart, { readonly kind: "process" }> | HolderState => {
    const answer = kernel.start(pid)
    if (answer.kind === "absent") return gone("absent")
    if (answer.kind === "unproven") return { kind: "unknown", reason: `the kernel did not answer for pid ${pid}` }
    return answer
  }

  /** This process's identity as the kernel gives it now, or why it does not. */
  const readOwn = (): { readonly kind: "read"; readonly identity: HolderIdentity } | { readonly kind: "unreadable"; readonly reason: string } => {
    const start = kernel.start(process.pid)
    if (start.kind === "absent") return { kind: "unreadable", reason: "the kernel reports no process at this process's own pid" }
    if (start.kind === "unproven") return { kind: "unreadable", reason: "the kernel did not answer for this process's start stamp" }
    if (!START.test(start.start)) return { kind: "unreadable", reason: `the kernel's start stamp ${start.start} is not a decimal of at most 20 digits` }
    const boot = readHostBoot()
    if (boot.kind === "unproven") return { kind: "unreadable", reason: "this host's boot identity could not be read" }
    return { kind: "read", identity: { v: 1, start: start.start, ...(boot.kind === "boot" ? { boot: boot.id } : {}) } }
  }

  const identifiedState = (pid: number, identity: HolderIdentity): HolderState => {
    if (identity.boot !== undefined) {
      const host = readHostBoot()
      if (host.kind === "unproven") return { kind: "unknown", reason: "this host's boot identity could not be read" }
      // A host that names no boot cannot tell whether the recorded one is its own.
      if (host.kind === "none") return { kind: "unknown", reason: "the record names a boot and this host names none" }
      if (host.id !== identity.boot) return gone("another-boot")
    }
    const answer = startOf(pid)
    if (answer.kind !== "process") return answer
    return answer.start === identity.start ? ALIVE : gone("another-process")
  }

  return {
    own() {
      if (own !== undefined) return own
      const read = readOwn()
      if (read.kind === "read") {
        own = read.identity
        return own
      }
      if (!ownUnreadableRecorded) {
        ownUnreadableRecorded = true
        log.warn("this process could not read its own identity; its records name its pid alone until a read succeeds", { reason: read.reason })
      }
      return undefined
    },
    state(holder) {
      switch (holder.kind) {
        case "without-identity": {
          const answer = startOf(holder.pid)
          return answer.kind === "process" ? ALIVE : answer
        }
        case "identified":
          return identifiedState(holder.pid, holder.identity)
        case "unreadable-identity":
          if (!warnedVersions.has(holder.version)) {
            warnedVersions.add(holder.version)
            log.warn("holder record carries an identity this build cannot read", { version: holder.version, pid: holder.pid })
          }
          return { kind: "unknown", reason: `the record's identity (version ${holder.version}) is not one this build can read` }
      }
    },
  }
}

/** The holder identities of this process's host. */
export const processHolders = createProcessHolders({ start: (pid) => processStart(pid), boot: () => bootIdentity() })

function identityV1(start: unknown, boot: unknown): HolderIdentity | undefined {
  if (typeof start !== "string" || !START.test(start)) return undefined
  if (boot === undefined) return { v: 1, start }
  return typeof boot === "string" && BOOT.test(boot) ? { v: 1, start, boot } : undefined
}

/** The holder a JSON record names: its `pid`, which the caller has already
 *  read, and the identity fields beside it. */
export function decodeHolderFields(pid: number, fields: { readonly v?: unknown; readonly start?: unknown; readonly boot?: unknown }): ProcessHolder {
  if (fields.v === undefined) return { kind: "without-identity", pid }
  const identity = fields.v === 1 ? identityV1(fields.start, fields.boot) : undefined
  return identity === undefined ? { kind: "unreadable-identity", pid, version: String(fields.v) } : { kind: "identified", pid, identity }
}

/** The text encoding of a holder: `<pid> <v> <start>[ <boot>]`, or the bare
 *  pid when the holder has no identity to name. */
export function encodeHolderText(pid: number, identity: HolderIdentity | undefined): string {
  if (identity === undefined) return String(pid)
  return [pid, identity.v, identity.start, ...(identity.boot === undefined ? [] : [identity.boot])].join(" ")
}

/** The holder that text names, or nothing when its leading token is not a
 *  positive integer, which is garbled text rather than a record. */
export function decodeHolderText(text: string): ProcessHolder | undefined {
  const [pidToken = "", version, start, boot, ...rest] = text.trim().split(" ")
  const pid = Number(pidToken)
  if (!PID.test(pidToken) || !Number.isSafeInteger(pid)) return undefined
  if (version === undefined) return { kind: "without-identity", pid }
  const identity = version === "1" && rest.length === 0 ? identityV1(start, boot) : undefined
  return identity === undefined ? { kind: "unreadable-identity", pid, version } : { kind: "identified", pid, identity }
}

import { createHash } from "node:crypto"
import * as fs from "node:fs"
import { constants as osConstants } from "node:os"
import * as path from "node:path"

import { writeFileAtomic } from "./atomic-write.js"
import type { ServeLane } from "./cli-subprocess.js"
import { errorMessage } from "./error-message.js"
import { Log } from "./log.js"
import { accountServeDir } from "./paths.js"
import { isRecord, type UnknownRecord } from "./record.js"

/** The shapes a command handover carries from one build to the next.
 *
 *  A command supervisor outlives the build that launched it, and a later build
 *  takes it over (ARCH-RUNTIME-033). Two shapes cross that boundary here: the words of
 *  the supervisor's channels and the outcome record the supervisor writes
 *  beside the command's log. Each has a version from its first release. A
 *  reader that meets a version it does not know reports that, and it never
 *  rewrites or removes the file and never answers the word, so a newer build
 *  can still read what an older one could not. */

const log = Log.create({ service: "command-handover" })

/** The version of the channel words this release speaks. */
export const COMMAND_CHANNEL_VERSION = 1

const OUTCOME_RECORD_VERSION = 1

/** What the handover word tells a supervisor: where to serve the channel a
 *  later owner connects to, where to record the outcome, the account whose
 *  build it holds live, and the command's hard deadline as epoch
 *  milliseconds, if it has one. */
export interface CommandHandover {
  readonly channel: string
  readonly recordPath: string
  readonly userDataRoot: string
  readonly deadlineAtMs?: number
}

/** What the adopt word tells a supervisor: the guardian of the owner that
 *  takes the command, with the creation identity the owner read for it. */
export interface CommandAdoption {
  readonly guardianPid: number
  readonly guardianIdentity: string
}

/** A word that a launcher or a controller sends a supervisor, one per line.
 *  `go` and `stop` travel on the launcher's channel, `adopt` on the channel a
 *  handover names, and `stop` and `handover` on both. */
export type SupervisorWord =
  | { readonly kind: "go" }
  | { readonly kind: "stop" }
  | { readonly kind: "handover"; readonly handover: CommandHandover }
  | { readonly kind: "adopt"; readonly adoption: CommandAdoption }

/** A supervisor's answer on the channel a handover names. */
export type SupervisorAnswer =
  | { readonly kind: "adopted" }
  | { readonly kind: "refused"; readonly versions: readonly number[] }

/** A line this release cannot read: a word of another version, a payload that
 *  is not the word's shape, or no word at all. `word` is the line's first
 *  token, so a supervisor can refuse an adopt of a version it does not
 *  speak. */
interface UnknownWord {
  readonly kind: "unknown"
  readonly word: string
}

export function encodeSupervisorWord(word: SupervisorWord): string {
  if (word.kind === "handover") {
    const { channel, recordPath, userDataRoot, deadlineAtMs } = word.handover
    return `handover ${JSON.stringify({ v: COMMAND_CHANNEL_VERSION, channel, recordPath, userDataRoot, ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }) })}`
  }
  if (word.kind === "adopt") {
    const { guardianPid, guardianIdentity } = word.adoption
    return `adopt ${JSON.stringify({ v: COMMAND_CHANNEL_VERSION, guardianPid, guardianIdentity })}`
  }
  return word.kind
}

export function decodeSupervisorWord(line: string): SupervisorWord | UnknownWord {
  const { word, payload } = splitLine(line)
  if (word === "go" || word === "stop") return payload === undefined ? { kind: word } : { kind: "unknown", word }
  if (word === "handover") {
    const fields = versionedFields(payload, ["channel", "recordPath", "userDataRoot"], ["deadlineAtMs"])
    if (
      fields !== undefined && isNamed(fields.channel) && isNamed(fields.recordPath) && isNamed(fields.userDataRoot)
      && (fields.deadlineAtMs === undefined || isCount(fields.deadlineAtMs))
    ) {
      return {
        kind: "handover",
        handover: {
          channel: fields.channel,
          recordPath: fields.recordPath,
          userDataRoot: fields.userDataRoot,
          ...(fields.deadlineAtMs === undefined ? {} : { deadlineAtMs: fields.deadlineAtMs }),
        },
      }
    }
  }
  if (word === "adopt") {
    const fields = versionedFields(payload, ["guardianPid", "guardianIdentity"], [])
    if (fields !== undefined && isCount(fields.guardianPid) && fields.guardianPid > 0 && isNamed(fields.guardianIdentity)) {
      return { kind: "adopt", adoption: { guardianPid: fields.guardianPid, guardianIdentity: fields.guardianIdentity } }
    }
  }
  return { kind: "unknown", word }
}

export function encodeSupervisorAnswer(answer: SupervisorAnswer): string {
  return answer.kind === "refused" ? `refused ${JSON.stringify({ versions: answer.versions })}` : answer.kind
}

export function decodeSupervisorAnswer(line: string): SupervisorAnswer | UnknownWord {
  const { word, payload } = splitLine(line)
  if (word === "adopted" && payload === undefined) return { kind: "adopted" }
  if (word === "refused") {
    const fields = jsonObject(payload)
    const versions = fields?.versions
    if (fields !== undefined && hasOnlyKeys(fields, ["versions"], []) && Array.isArray(versions) && versions.every((version) => isCount(version) && version > 0)) {
      return { kind: "refused", versions: versions.filter(isCount) }
    }
  }
  return { kind: "unknown", word }
}

/** One line split at its first space: the word, and the JSON payload after
 *  it, if any. */
function splitLine(line: string): { readonly word: string; readonly payload: string | undefined } {
  const space = line.indexOf(" ")
  return space < 0 ? { word: line, payload: undefined } : { word: line.slice(0, space), payload: line.slice(space + 1) }
}

function jsonObject(payload: string | undefined): UnknownRecord | undefined {
  if (payload === undefined) return undefined
  try {
    const value: unknown = JSON.parse(payload)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** The fields of a payload of this release's version with exactly the
 *  required keys and some of the optional ones. A payload of another version
 *  yields nothing, whatever keys it has, so it is never read in part. */
function versionedFields(payload: string | undefined, required: readonly string[], optional: readonly string[]): UnknownRecord | undefined {
  const fields = jsonObject(payload)
  if (fields === undefined || fields.v !== COMMAND_CHANNEL_VERSION) return undefined
  return hasOnlyKeys(fields, ["v", ...required], optional) ? fields : undefined
}

function hasOnlyKeys(fields: UnknownRecord, required: readonly string[], optional: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(fields, key))
    && Object.keys(fields).every((key) => required.includes(key) || optional.includes(key))
}

function isNamed(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/** How the command ended while a supervisor held it after a handover. */
interface CommandOutcome {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  /** True when the supervisor ended the command at its recorded deadline. */
  readonly deadlineExpired: boolean
  readonly endedAtMs: number
}

/** The file a handed-over supervisor keeps beside the command's log.
 *
 *  Without `outcome` it is the supervisor's acknowledgement of the handover
 *  word, written once the supervisor holds the command alone. With `outcome`
 *  the command has ended. A record without an outcome whose supervisor is gone
 *  means the supervisor was killed while it held the command; no record at
 *  all means the command was never handed over. `supervisorIdentity` is the
 *  identity of the supervisor's container as its platform reads one, where it
 *  could be read, so a later owner tells the supervisor apart from a process
 *  that took its pid. */
export interface CommandOutcomeRecord {
  readonly version: 1
  readonly handedOverAtMs: number
  readonly supervisorIdentity?: string
  readonly outcome?: CommandOutcome
}

export type OutcomeRecordRead =
  | { readonly kind: "absent" }
  | { readonly kind: "record"; readonly record: CommandOutcomeRecord }
  | { readonly kind: "unreadable"; readonly reason: string }

/** Replaces the record in one step, readable only by its owner, so a reader
 *  never sees half of one. */
export function writeOutcomeRecord(recordPath: string, record: CommandOutcomeRecord): void {
  writeFileAtomic(recordPath, JSON.stringify(record), { mode: 0o600 })
}

/** Reads the record at `recordPath`. A record this release cannot read is
 *  reported and left exactly as it is. */
export function readOutcomeRecord(recordPath: string): OutcomeRecordRead {
  let text: string
  try {
    text = fs.readFileSync(recordPath, "utf8")
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return { kind: "absent" }
    return unreadable(recordPath, `the record could not be read: ${errorMessage(err)}`)
  }
  const fields = jsonObject(text)
  if (fields === undefined) return unreadable(recordPath, "the record is not a JSON object")
  if (fields.version !== OUTCOME_RECORD_VERSION) return unreadable(recordPath, `the record has version ${String(fields.version)}`)
  const outcome = fields.outcome === undefined ? undefined : decodeOutcome(fields.outcome)
  const { supervisorIdentity } = fields
  if (
    !hasOnlyKeys(fields, ["version", "handedOverAtMs"], ["supervisorIdentity", "outcome"]) || !isCount(fields.handedOverAtMs) || outcome === null
    || (supervisorIdentity !== undefined && !isNamed(supervisorIdentity))
  ) {
    return unreadable(recordPath, "the record is not the shape of its version")
  }
  return {
    kind: "record",
    record: {
      version: OUTCOME_RECORD_VERSION,
      handedOverAtMs: fields.handedOverAtMs,
      ...(supervisorIdentity === undefined ? {} : { supervisorIdentity }),
      ...(outcome === undefined ? {} : { outcome }),
    },
  }
}

function decodeOutcome(value: unknown): CommandOutcome | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["code", "signal", "deadlineExpired", "endedAtMs"], [])) return null
  const { code, signal, deadlineExpired, endedAtMs } = value
  if (code !== null && !(typeof code === "number" && Number.isSafeInteger(code))) return null
  if (signal !== null && !isSignal(signal)) return null
  if (typeof deadlineExpired !== "boolean" || !isCount(endedAtMs)) return null
  return { code, signal, deadlineExpired, endedAtMs }
}

function isSignal(value: unknown): value is NodeJS.Signals {
  return typeof value === "string" && Object.hasOwn(osConstants.signals, value)
}

function unreadable(recordPath: string, reason: string): OutcomeRecordRead {
  log.warn("command outcome record cannot be read by this release; it is left in place", { recordPath, reason })
  return { kind: "unreadable", reason }
}

/** The address of the channel a handed-over supervisor serves.
 *
 *  POSIX puts a socket in the account service's own directory, which only the
 *  account can enter. A socket path is bounded (104 bytes on macOS), so the
 *  name is a digest of the ownership token no longer than the name of the
 *  account socket beside it: a home whose account socket fits holds every
 *  handover channel too. Windows names a pipe by the token itself, as it
 *  names the launcher's channel. The launch that hands a command over
 *  computes the address once and sends it in the handover word, so no later
 *  reader derives it again. */
export function handoverChannelAddress(
  input: { readonly userDataRoot: string; readonly lane: ServeLane; readonly token: string },
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return WINDOWS_HANDOVER_PIPE + input.token
  const digest = createHash("sha256").update(input.token).digest("hex").slice(0, HANDOVER_SOCKET_DIGEST_CHARS)
  return path.join(accountServeDir(input.userDataRoot, input.lane), `h${digest}`)
}

const WINDOWS_HANDOVER_PIPE = String.raw`\\.\pipe\Flywheel.handover.`

/** One letter and nine hex digits: the length of `serve.sock`, and 36 bits,
 *  so two commands of one account that are handed over at once never share
 *  a name in practice. */
const HANDOVER_SOCKET_DIGEST_CHARS = 9

/** Removes what a handed-over supervisor that is gone left beside it: its
 *  outcome record, once the command's end is published, and a POSIX socket
 *  that only a supervisor that exited of its own accord removes itself. */
export async function removeHandoverRemains(remains: { readonly recordPath: string; readonly channel?: string }): Promise<void> {
  await fs.promises.rm(remains.recordPath, { force: true })
  if (remains.channel !== undefined && !remains.channel.startsWith(WINDOWS_HANDOVER_PIPE)) await fs.promises.rm(remains.channel, { force: true })
}

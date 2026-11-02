import { randomBytes, timingSafeEqual } from "node:crypto"

// The module path, not the package index: the guardian loads only what this
// import reaches, and the index would load all of Effect into every guardian.
import * as Redacted from "effect/Redacted"
import { isAbsolute } from "node:path"

import type { StopHold } from "./stop-hold.js"

/** Wire contract between the Flywheel host and its external process guardian.
 *
 *  Both peers are Flywheel-owned, so this is internal IPC, not an external
 *  boundary: every frame is validated in full before any state changes, and a
 *  peer that breaks a bound is dropped rather than repaired. The bounds exist
 *  because the guardian holds the authority to kill process trees; an
 *  unbounded registry or an unbounded frame would turn a host bug into an
 *  unbounded kill list.
 *
 *  Three things make a mutation legitimate, and every mutating frame carries
 *  all three: the capability the host established on this control channel, the
 *  generation that owns the lease, and a correlation id, so an answer belongs
 *  to exactly one request. */

const GUARDIAN_PROTOCOL_VERSION = 1

/** A frame is one line of UTF-8 JSON. Every legal frame is well under this;
 *  the bound turns a peer that never terminates a line into a fatal error
 *  instead of unbounded buffering.
 *
 *  Raw bytes, not code units: the reader is what stands between a peer and this
 *  process's memory, so the bound must be the quantity the peer actually sends.
 *  A JavaScript string length would let a multibyte frame occupy up to four
 *  times this many bytes. */
export const GUARDIAN_MAX_FRAME_BYTES = 4_096

export const GUARDIAN_MAX_OWNED_CONTAINERS = 256
export const GUARDIAN_MAX_GENERATIONS = 64
export const GUARDIAN_MAX_RETIRED_TOKENS = 1_024
/** The longest stop hold a lease may carry, which bounds how long one hold
 *  can keep the guardian from ending a host's containers after a crash. */
const GUARDIAN_MAX_STOP_HOLD_MS = 60_000

const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
interface UnknownFields {
  readonly [key: string]: unknown
}

type RequestKeys = { readonly [Kind in GuardianRequest["kind"]]: readonly string[] }
type ReplyKeys = { readonly [Kind in GuardianReply["kind"]]: readonly string[] }

export type GuardianRejection =
  | "not-a-container"
  | "container-unproven"
  | "at-capacity"
  | "token-retired"
  | "unknown-token"
  | "unknown-generation"
  | "generation-retired"
  | "unauthorized"

/** One lease holder's whole vocabulary. It carries no capability and names no
 *  generation: the holder of the control channel stamps both, so a peer that
 *  forwards a command can never widen it into another generation's. */
export type GuardianCommand =
  | { readonly kind: "adopt"; readonly token: string; readonly pid: number; readonly stopHold: StopHold | null }
  | { readonly kind: "release"; readonly token: string }

/** What the guardian answered one lease command, as its holder reads it. */
export type GuardianLeaseOutcome =
  | { readonly kind: "adopted"; readonly token: string }
  | { readonly kind: "released"; readonly token: string }
  | { readonly kind: "rejected"; readonly reason: GuardianRejection }

/** A request as its caller states it. The control channel stamps the version,
 *  the correlation id and the capability, so no caller can forge any of them. */
export type GuardianRequestBody =
  | { readonly kind: "open"; readonly generation: string }
  | { readonly kind: "close"; readonly generation: string }
  | { readonly kind: "adopt"; readonly generation: string; readonly token: string; readonly pid: number; readonly stopHold: StopHold | null }
  | { readonly kind: "release"; readonly generation: string; readonly token: string }

export type GuardianRequest =
  | { readonly v: 1; readonly kind: "hello"; readonly id: number; readonly capability: GuardianToken }
  | { readonly v: 1; readonly kind: "open"; readonly id: number; readonly capability: GuardianToken; readonly generation: string }
  | { readonly v: 1; readonly kind: "close"; readonly id: number; readonly capability: GuardianToken; readonly generation: string }
  /** `stopHold` is the launch's stop hold (see `StopHold`), which the
   *  guardian honors before it signals the container. */
  | { readonly v: 1; readonly kind: "adopt"; readonly id: number; readonly capability: GuardianToken; readonly generation: string; readonly token: string; readonly pid: number; readonly stopHold: StopHold | null }
  | { readonly v: 1; readonly kind: "release"; readonly id: number; readonly capability: GuardianToken; readonly generation: string; readonly token: string }

export type GuardianReply =
  | { readonly v: 1; readonly kind: "ready"; readonly id: number; readonly pid: number }
  | { readonly v: 1; readonly kind: "opened"; readonly id: number; readonly generation: string }
  /** `remaining` is the proof a generation close asks for: containers of that
   *  generation still populated after the guardian emptied them. Zero is
   *  settlement; anything else is what the owner must keep holding. */
  | { readonly v: 1; readonly kind: "closed"; readonly id: number; readonly generation: string; readonly remaining: number }
  | { readonly v: 1; readonly kind: "adopted"; readonly id: number; readonly token: string }
  | { readonly v: 1; readonly kind: "released"; readonly id: number; readonly token: string }
  | { readonly v: 1; readonly kind: "rejected"; readonly id: number; readonly reason: GuardianRejection }

const encoder = new TextEncoder()
/** Only ever given capability bytes, which this protocol builds from ASCII. */
const capabilityDecoder = new TextDecoder()

/** A control capability as a process holds it: the bytes of the token, not a
 *  string of it.
 *
 *  Bytes because they can be erased. A JavaScript string is immutable, so the
 *  copy that would live for the whole life of a channel could never be taken
 *  back; an array can be overwritten the moment the channel ends. The wire form
 *  is still one JSON string, so a plaintext string does exist for the moment a
 *  frame is encoded or decoded, and that copy is the one thing this side cannot
 *  erase. It is unreachable from anything but the encoder and the decoder, and
 *  it is never held.
 *
 *  `Redacted` is what keeps the bytes out of a payload, a Worker, a log line,
 *  an error, or a snapshot. */
export type GuardianToken = Redacted.Redacted<Uint8Array>

/** Characters a capability is built from. All alphanumeric, so a capability is
 *  a token the frame decoder accepts, and exactly 32 of them, so five random
 *  bits choose one without bias. */
const CAPABILITY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const CAPABILITY_LENGTH = 40

/** A fresh control capability, rotated per guardian. It travels only on the
 *  private control pipe. The token is assembled directly into its bytes, so no
 *  string of it is ever built on the side that generates it. */
export function newGuardianToken(): GuardianToken {
  const random = randomBytes(CAPABILITY_LENGTH)
  const token = new Uint8Array(CAPABILITY_LENGTH)
  for (let index = 0; index < CAPABILITY_LENGTH; index += 1) {
    token[index] = CAPABILITY_ALPHABET.charCodeAt((random[index] ?? 0) % CAPABILITY_ALPHABET.length)
  }
  random.fill(0)
  return Redacted.make(token)
}

/** Erases one capability. The bytes are overwritten first, because wiping the
 *  wrapper only drops the reference to them, and then the wrapper is emptied so
 *  a later read throws instead of returning what is left. Destroying twice is
 *  the same request. */
export function destroyGuardianToken(capability: GuardianToken): void {
  capabilityBytes(capability)?.fill(0)
  Redacted.wipeUnsafe(capability)
}

/** The bytes of a capability, or nothing once it was destroyed. */
function capabilityBytes(capability: GuardianToken): Uint8Array | undefined {
  try {
    return Redacted.value(capability)
  } catch {
    return undefined
  }
}

/** Constant-time capability comparison. Both sides are already bytes, so this
 *  allocates nothing to compare and leaves nothing to clear. A destroyed
 *  capability matches nothing. */
export function guardianTokenMatches(expected: GuardianToken, offered: GuardianToken): boolean {
  const left = capabilityBytes(expected)
  const right = capabilityBytes(offered)
  if (!left || !right || left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function stampGuardianRequest(body: GuardianRequestBody, id: number, capability: GuardianToken): GuardianRequest {
  return { v: 1, id, capability, ...body }
}

/** Serialize one frame, terminator included. Throws when the writer produced a
 *  frame the reader is required to refuse, which is a producer bug. */
export function encodeGuardianFrame(frame: GuardianRequest | GuardianReply): string {
  // The capability becomes a string exactly here, on its way into the private
  // control pipe, and nowhere else on this side.
  const body = JSON.stringify("capability" in frame ? { ...frame, capability: capabilityDecoder.decode(Redacted.value(frame.capability)) } : frame)
  if (encoder.encode(body).length > GUARDIAN_MAX_FRAME_BYTES) throw new Error("guardian frame exceeds the protocol bound")
  return `${body}\n`
}

/** The exact key set of each frame. A frame carrying anything else was not
 *  produced by this protocol, so it is refused rather than read for the fields
 *  it happens to have. */
const REQUEST_KEYS: RequestKeys = {
  hello: ["v", "kind", "id", "capability"],
  open: ["v", "kind", "id", "capability", "generation"],
  close: ["v", "kind", "id", "capability", "generation"],
  adopt: ["v", "kind", "id", "capability", "generation", "token", "pid", "stopHold"],
  release: ["v", "kind", "id", "capability", "generation", "token"],
}

const REPLY_KEYS: ReplyKeys = {
  ready: ["v", "kind", "id", "pid"],
  opened: ["v", "kind", "id", "generation"],
  closed: ["v", "kind", "id", "generation", "remaining"],
  adopted: ["v", "kind", "id", "token"],
  released: ["v", "kind", "id", "token"],
  rejected: ["v", "kind", "id", "reason"],
}

/** True when a frame carries exactly the keys its kind defines. The bridge
 *  validates its own frames with the same rule. */
export function hasExactKeys(frame: UnknownFields, keys: readonly string[]): boolean {
  const present = Object.keys(frame)
  return present.length === keys.length && keys.every((key) => Object.hasOwn(frame, key))
}

function isRequestKind(kind: unknown): kind is GuardianRequest["kind"] {
  return typeof kind === "string" && Object.hasOwn(REQUEST_KEYS, kind)
}

function isReplyKind(kind: unknown): kind is GuardianReply["kind"] {
  return typeof kind === "string" && Object.hasOwn(REPLY_KEYS, kind)
}

export function decodeGuardianRequest(line: string): GuardianRequest | undefined {
  const frame = frameFields(line)
  if (!frame) return undefined
  const kind = frame.kind
  if (!isRequestKind(kind)) return undefined
  if (!hasExactKeys(frame, REQUEST_KEYS[kind])) return undefined
  const id = correlationId(frame.id)
  const capability = frameToken(frame.capability)
  if (id === undefined || capability === undefined) return undefined
  // The string JSON parsing produced is turned into bytes and dropped: what
  // this side holds from here on is erasable.
  if (kind === "hello") return { v: 1, kind, id, capability: Redacted.make(encoder.encode(capability)) }
  const generation = frameToken(frame.generation)
  if (generation === undefined) return undefined
  const stamped = { v: 1, id, capability: Redacted.make(encoder.encode(capability)), generation } as const
  if (kind === "open" || kind === "close") return { ...stamped, kind }
  const token = frameToken(frame.token)
  if (token === undefined) return undefined
  if (kind === "release") return { ...stamped, kind, token }
  const pid = containerPid(frame.pid)
  const stopHold = decodeStopHold(frame.stopHold)
  return pid === undefined || stopHold === undefined ? undefined : { ...stamped, kind, token, pid, stopHold }
}

export function decodeGuardianReply(line: string): GuardianReply | undefined {
  const frame = frameFields(line)
  if (!frame) return undefined
  const kind = frame.kind
  if (!isReplyKind(kind)) return undefined
  if (!hasExactKeys(frame, REPLY_KEYS[kind])) return undefined
  const id = correlationId(frame.id)
  if (id === undefined) return undefined
  if (kind === "ready") {
    const pid = containerPid(frame.pid)
    return pid === undefined ? undefined : { v: 1, kind, id, pid }
  }
  if (kind === "rejected") {
    const reason = frameRejection(frame.reason)
    return reason === undefined ? undefined : { v: 1, kind, id, reason }
  }
  if (kind === "opened" || kind === "closed") {
    const generation = frameToken(frame.generation)
    if (generation === undefined) return undefined
    if (kind === "opened") return { v: 1, kind, id, generation }
    const remaining = frameCount(frame.remaining)
    return remaining === undefined ? undefined : { v: 1, kind, id, generation, remaining }
  }
  const token = frameToken(frame.token)
  return token === undefined ? undefined : { v: 1, kind, id, token }
}

/** The bridge carries lease traffic between threads as structured clones
 *  rather than lines, and validates it with exactly these two decoders, so a
 *  Worker reaches the guardian through the same vocabulary the pipe accepts
 *  and through no more of it. */
export function decodeGuardianCommand(value: unknown): GuardianCommand | undefined {
  const fields = objectFields(value)
  if (!fields) return undefined
  const token = frameToken(fields.token)
  if (token === undefined) return undefined
  if (fields.kind === "release") return hasExactKeys(fields, ["kind", "token"]) ? { kind: "release", token } : undefined
  if (fields.kind !== "adopt" || !hasExactKeys(fields, ["kind", "token", "pid", "stopHold"])) return undefined
  const pid = containerPid(fields.pid)
  const stopHold = decodeStopHold(fields.stopHold)
  return pid === undefined || stopHold === undefined ? undefined : { kind: "adopt", token, pid, stopHold }
}

export function decodeGuardianLeaseOutcome(value: unknown): GuardianLeaseOutcome | undefined {
  const fields = objectFields(value)
  if (!fields) return undefined
  if (fields.kind === "rejected") {
    const reason = frameRejection(fields.reason)
    if (reason === undefined || !hasExactKeys(fields, ["kind", "reason"])) return undefined
    return { kind: "rejected", reason }
  }
  if (fields.kind !== "adopted" && fields.kind !== "released") return undefined
  const token = frameToken(fields.token)
  if (token === undefined || !hasExactKeys(fields, ["kind", "token"])) return undefined
  return { kind: fields.kind, token }
}

/** The outcome the guardian's own answer carries, or a throw: a reply of
 *  another kind to a lease command is a peer that stopped speaking this
 *  protocol, never something a lease holder may act on. */
export function guardianLeaseOutcome(reply: GuardianReply): GuardianLeaseOutcome {
  if (reply.kind === "adopted" || reply.kind === "released") return { kind: reply.kind, token: reply.token }
  if (reply.kind === "rejected") return { kind: "rejected", reason: reply.reason }
  throw new Error(`guardian answered a lease command with ${reply.kind}`)
}

export interface GuardianFrameReader {
  /** Complete frames from the bytes seen so far. Throws once an unterminated
   *  frame passes the byte bound, or once the peer sends bytes that are not
   *  UTF-8: a peer that cannot frame is not trusted to continue. */
  push(chunk: Uint8Array): readonly string[]
}

const LINE_FEED = 0x0a

/** Fatal on purpose. Invalid UTF-8 is not repaired into replacement characters,
 *  because the repaired text would decode as a frame the peer never sent. */
const strictDecoder = new TextDecoder("utf-8", { fatal: true })

function decodeFrameBytes(bytes: Uint8Array): string {
  try {
    return strictDecoder.decode(bytes)
  } catch {
    throw new Error("guardian frame is not valid UTF-8")
  }
}

export function createGuardianFrameReader(): GuardianFrameReader {
  // Bytes, never a decoded string: the bound, the terminator search and the
  // validity check all describe what the peer actually sent.
  let pending = new Uint8Array(0)
  return {
    push(chunk) {
      if (chunk.length > 0) {
        const joined = new Uint8Array(pending.length + chunk.length)
        joined.set(pending)
        joined.set(chunk, pending.length)
        pending = joined
      }
      const frames: string[] = []
      for (;;) {
        const terminator = pending.indexOf(LINE_FEED)
        if (terminator < 0) break
        if (terminator > GUARDIAN_MAX_FRAME_BYTES) throw new Error("guardian frame exceeds the protocol bound")
        frames.push(decodeFrameBytes(pending.subarray(0, terminator)))
        pending = pending.slice(terminator + 1)
      }
      if (pending.length > GUARDIAN_MAX_FRAME_BYTES) throw new Error("guardian frame exceeds the protocol bound")
      return frames
    },
  }
}

/** The string-keyed view of a JSON or structured-clone object, or nothing
 *  for any other value. */
export function objectFields(value: unknown): UnknownFields | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  // SAFETY: The runtime object check proves that the JSON or structured-clone value has a string-keyed object view.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: JSON and structured-clone objects require a string-keyed view after runtime validation
  return value as UnknownFields
}

function frameFields(line: string): UnknownFields | undefined {
  if (encoder.encode(line).length > GUARDIAN_MAX_FRAME_BYTES) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  const frame = objectFields(parsed)
  if (!frame) return undefined
  return frame.v === GUARDIAN_PROTOCOL_VERSION ? frame : undefined
}

function frameToken(value: unknown): string | undefined {
  return typeof value === "string" && TOKEN_PATTERN.test(value) ? value : undefined
}

/** A stop hold, `null` for none, or undefined for a value this protocol does
 *  not define: a hold names an absolute file and stays within the guardian's
 *  bound. */
export function decodeStopHold(value: unknown): StopHold | null | undefined {
  if (value === null) return null
  const fields = objectFields(value)
  if (!fields || !hasExactKeys(fields, ["path", "boundMs"])) return undefined
  const { path, boundMs } = fields
  if (typeof path !== "string" || !isAbsolute(path)) return undefined
  if (typeof boundMs !== "number" || !Number.isSafeInteger(boundMs) || boundMs < 0 || boundMs > GUARDIAN_MAX_STOP_HOLD_MS) return undefined
  return { path, boundMs }
}

function frameRejection(value: unknown): GuardianRejection | undefined {
  switch (value) {
    case "not-a-container": return "not-a-container"
    case "container-unproven": return "container-unproven"
    case "at-capacity": return "at-capacity"
    case "token-retired": return "token-retired"
    case "unknown-token": return "unknown-token"
    case "unknown-generation": return "unknown-generation"
    case "generation-retired": return "generation-retired"
    case "unauthorized": return "unauthorized"
    default: return undefined
  }
}

function correlationId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function frameCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** pid 0 addresses a whole process group and pid 1 is init, so neither can
 *  ever name a container Flywheel owns. */
function containerPid(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 1 ? value : undefined
}
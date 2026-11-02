import type { ServeLane } from "../infra/cli-subprocess.js"

interface ServeStartupProgress {
  readonly step: number
  readonly total: number
}

interface UnknownObject {
  readonly [key: string]: unknown
}

/** The cause of a start that the lane reset alone does not remedy, named so
 *  that a client shows the remedy that works. An older client skips a kind
 *  that it does not know and still reads the failure record.
 *  - `claim-settling`: an empty reclaim claim that an earlier release left on
 *    the start lock. It is removed once it is proven ten minutes old, and the
 *    next start then serves.
 *  - `address-access`: the lane's address refused this user's connection
 *    with a permission error. Its permissions must be fixed, or the file
 *    removed.
 *  - `port-in-use`: another program holds the lane's fixed hub port. The
 *    lane reset frees the port only when that program is an earlier
 *    Flywheel.
 *  - `state-from-newer-release`: a later release wrote the project's state,
 *    at a state epoch this release cannot read. Only an update opens it. */
export type ServeStartRefusal =
  | { readonly kind: "claim-settling"; readonly path: string }
  | { readonly kind: "address-access"; readonly path: string; readonly code: string }
  | { readonly kind: "port-in-use"; readonly port: number }
  | { readonly kind: "state-from-newer-release"; readonly stateEpoch: number; readonly readableEpoch: number }

/** A start that the serve command reported as failed, with the refusal it
 *  named, when it named one. */
export class ServeStartupFailure extends Error {
  constructor(message: string, readonly refusal?: ServeStartRefusal) {
    super(message)
    this.name = "ServeStartupFailure"
  }
}

/** The refusal that a failure or one of its causes named, when any did. A
 *  start failure crosses several owners, and each can wrap it. */
export function startRefusalOf(error: unknown): ServeStartRefusal | undefined {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof ServeStartupFailure && cause.refusal !== undefined) return cause.refusal
  }
  return undefined
}

/** Secret-free stdout status from the account server. The rendezvous path and
 * attach credential are derived or read from their private account files;
 * the lane says which of the two private directories they are in, because an
 * installed build and a source checkout serve side by side (ARCH-RUNTIME-008). */
export type ServeStatusRecord =
  | { readonly flywheel: "serve.startup.phase"; readonly label: string; readonly progress?: ServeStartupProgress }
  | { readonly flywheel: "serve.startup.refused"; readonly refusal: ServeStartRefusal }
  | { readonly flywheel: "serve.startup.failed"; readonly error: string }
  | { readonly flywheel: "serve.listening" | "serve.already-listening"; readonly version: string; readonly protocolVersion: number; readonly pid: number; readonly lane: ServeLane }

/** Encode one complete newline-delimited account-server status record. */
export function encodeServeStatusRecord(record: ServeStatusRecord): string {
  return `${JSON.stringify(record)}\n`
}

/** The records of a start that failed: the refusal, when the start names
 *  one, and then the failure it explains. The failure record keeps the shape
 *  that every earlier build decodes, and an earlier build skips a record
 *  kind it does not know, so an older client that started this build's
 *  service still reads why it failed. */
export function encodeServeStartFailure(error: string, refusal?: ServeStartRefusal): string {
  const refused = refusal === undefined ? "" : encodeServeStatusRecord({ flywheel: "serve.startup.refused", refusal })
  return `${refused}${encodeServeStatusRecord({ flywheel: "serve.startup.failed", error })}`
}

/** A start's status as a reader of its records sees it: a failure carries
 *  the refusal that the record before it named. */
export type ServeStartStatus =
  | Exclude<ServeStatusRecord, { readonly flywheel: "serve.startup.refused" | "serve.startup.failed" }>
  | { readonly flywheel: "serve.startup.failed"; readonly error: string; readonly refusal?: ServeStartRefusal }

/** Reads one start's status lines in order, and answers each record a
 *  client acts on. A refusal record answers nothing itself: the failure
 *  record that follows it carries its refusal. */
export function createServeStatusReader(): (line: string) => ServeStartStatus | undefined {
  let refusal: ServeStartRefusal | undefined
  return (line) => {
    const record = decodeServeStatusLine(line)
    if (record?.flywheel === "serve.startup.refused") {
      refusal = record.refusal
      return undefined
    }
    if (record?.flywheel !== "serve.startup.failed" || refusal === undefined) return record
    return { ...record, refusal }
  }
}

/** Decode a recognized account-server status line. Unknown or malformed
 * external output is ignored. */
export function decodeServeStatusLine(line: string): ServeStatusRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isObject(value) || typeof value.flywheel !== "string") return undefined
  switch (value.flywheel) {
    case "serve.startup.phase": {
      if (!hasOnly(value, ["flywheel", "label"], ["progress"]) || typeof value.label !== "string") return undefined
      if (value.progress === undefined) return { flywheel: value.flywheel, label: value.label }
      if (!isProgress(value.progress)) return undefined
      return { flywheel: value.flywheel, label: value.label, progress: value.progress }
    }
    case "serve.startup.refused": {
      const refusal = hasOnly(value, ["flywheel", "refusal"]) ? decodeServeStartRefusal(value.refusal) : undefined
      return refusal === undefined ? undefined : { flywheel: value.flywheel, refusal }
    }
    case "serve.startup.failed":
      return hasOnly(value, ["flywheel", "error"]) && typeof value.error === "string"
        ? { flywheel: value.flywheel, error: value.error }
        : undefined
    case "serve.listening":
    case "serve.already-listening":
      return hasOnly(value, ["flywheel", "version", "protocolVersion", "pid", "lane"])
        && typeof value.version === "string"
        && isSafeInteger(value.protocolVersion)
        && isSafeInteger(value.pid)
        && isLane(value.lane)
        ? { flywheel: value.flywheel, version: value.version, protocolVersion: value.protocolVersion, pid: value.pid, lane: value.lane }
        : undefined
    default:
      return undefined
  }
}

/** The release and protocol a listening record names, read without judging
 * the rest of its shape. These two fields are in the record every public
 * release has printed, while the rest of the record grew (`lane` arrived after
 * v0.0.10), so a client decides whether it can use the service from them
 * before the strict decode, and a refused older record is not mistaken for a
 * service that never listened. */
export function decodeServeListeningVersions(line: string): { readonly version: string; readonly protocolVersion: number | undefined } | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isObject(value) || (value.flywheel !== "serve.listening" && value.flywheel !== "serve.already-listening")) return undefined
  if (typeof value.version !== "string") return undefined
  return { version: value.version, protocolVersion: isSafeInteger(value.protocolVersion) ? value.protocolVersion : undefined }
}

type ServeDiagnosticLevel = "debug" | "info" | "warn" | "error"

const DIAGNOSTIC_LEVELS: ReadonlySet<string> = new Set<ServeDiagnosticLevel>(["debug", "info", "warn", "error"])

/** One structured record the serve command writes on stderr, as a person
 *  reads it: its level and its message. A log call writes
 *  `{"type":"log.<level>","payload":{"message":...}}`; any other diagnostic
 *  record names no level and reads as `debug`. A record with no message keeps
 *  its whole line as the text. A line that is not such a record, such as a
 *  launch's plain error text, is undefined. */
export function readServeDiagnostic(line: string): { readonly level: ServeDiagnosticLevel; readonly text: string } | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isObject(value) || typeof value.type !== "string") return undefined
  const named = value.type.startsWith("log.") ? value.type.slice("log.".length) : "debug"
  const message = isObject(value.payload) ? value.payload.message : undefined
  return { level: isDiagnosticLevel(named) ? named : "debug", text: typeof message === "string" ? message : line }
}

/** Decode a refusal that a status record or a stored start failure carries.
 *  A kind this build does not know, or a malformed one, decodes as none. */
export function decodeServeStartRefusal(value: unknown): ServeStartRefusal | undefined {
  if (!isObject(value)) return undefined
  if (value.kind === "claim-settling" && hasOnly(value, ["kind", "path"]) && typeof value.path === "string") return { kind: value.kind, path: value.path }
  if (value.kind === "address-access" && hasOnly(value, ["kind", "path", "code"]) && typeof value.path === "string" && typeof value.code === "string") return { kind: value.kind, path: value.path, code: value.code }
  if (value.kind === "port-in-use" && hasOnly(value, ["kind", "port"]) && isSafeInteger(value.port)) return { kind: value.kind, port: value.port }
  if (value.kind === "state-from-newer-release" && hasOnly(value, ["kind", "stateEpoch", "readableEpoch"]) && isSafeInteger(value.stateEpoch) && isSafeInteger(value.readableEpoch)) {
    return { kind: value.kind, stateEpoch: value.stateEpoch, readableEpoch: value.readableEpoch }
  }
  return undefined
}

function isDiagnosticLevel(value: string): value is ServeDiagnosticLevel {
  return DIAGNOSTIC_LEVELS.has(value)
}

function isObject(value: unknown): value is UnknownObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isLane(value: unknown): value is ServeLane {
  return value === "installed" || value === "dev"
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
}

function hasOnly(value: UnknownObject, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value)
  return required.every((key) => key in value) && keys.every((key) => required.includes(key) || optional.includes(key))
}

function isProgress(value: unknown): value is ServeStartupProgress {
  return isObject(value)
    && hasOnly(value, ["step", "total"])
    && isSafeInteger(value.step)
    && isSafeInteger(value.total)
    && value.step >= 0
    && value.total > 0
    && value.step <= value.total
}

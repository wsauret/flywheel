/** The account server's status decoder as release v0.0.9 shipped it, copied
 *  from `src/protocol/serve-handshake.ts` at that tag with only its unused
 *  encoder removed. A current build's records must stay readable by it: an
 *  older terminal starts the newer build's service during an update. */

interface ServeStartupProgress {
  readonly step: number
  readonly total: number
}

interface UnknownObject {
  readonly [key: string]: unknown
}

/** Secret-free stdout status from the account server. The rendezvous path and
 * attach credential are derived or read from their private account files. */
type ServeStatusRecord =
  | { readonly flywheel: "serve.startup.phase"; readonly label: string; readonly progress?: ServeStartupProgress }
  | { readonly flywheel: "serve.startup.failed"; readonly error: string }
  | { readonly flywheel: "serve.listening" | "serve.already-listening"; readonly version: string; readonly protocolVersion: number; readonly pid: number }

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
    case "serve.startup.failed":
      return hasOnly(value, ["flywheel", "error"]) && typeof value.error === "string"
        ? { flywheel: value.flywheel, error: value.error }
        : undefined
    case "serve.listening":
    case "serve.already-listening":
      return hasOnly(value, ["flywheel", "version", "protocolVersion", "pid"])
        && typeof value.version === "string"
        && isSafeInteger(value.protocolVersion)
        && isSafeInteger(value.pid)
        ? { flywheel: value.flywheel, version: value.version, protocolVersion: value.protocolVersion, pid: value.pid }
        : undefined
    default:
      return undefined
  }
}

function isObject(value: unknown): value is UnknownObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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

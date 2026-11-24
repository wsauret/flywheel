import { closeSync, fstatSync, ftruncateSync, openSync, readSync, statSync, writeSync } from "node:fs"

import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"

/** The size past which a start trims the service's error log, and the tail
 *  it keeps: the file stays at most about 1 MiB and never loses the output
 *  of the latest starts. */
const SERVICE_ERROR_LOG_BOUND_BYTES = 1024 * 1024
const SERVICE_ERROR_LOG_KEPT_BYTES = 256 * 1024

/** Keeps the file that launchd appends the service's standard error to
 *  (StandardErrorPath) bounded, because launchd itself never trims it. `fd`
 *  is the descriptor of the start's standard error. It acts only when `fd`
 *  writes to the file at `path` itself, so the error output of a person's
 *  own redirect or of another manager stays as it is. Past the bound it keeps the last 256 KiB in place: it never renames or
 *  replaces the file that launchd holds open. launchd opens the file for
 *  appending, so the next write through `fd` follows the kept tail. A trim
 *  that fails is recorded and never fails the start. */
export function keepServiceErrorLogBounded(path: string, fd: number): void {
  let bytes: number
  try {
    const held = fstatSync(fd)
    if (!held.isFile() || held.size <= SERVICE_ERROR_LOG_BOUND_BYTES) return
    const named = statSync(path)
    if (named.dev !== held.dev || named.ino !== held.ino) return
    bytes = held.size
  } catch {
    // boundary: no descriptor `fd` or no file at `path` means this start writes its error output elsewhere
    return
  }
  try {
    // launchd opens the file write-only, so the tail is read through its path.
    const tail = Buffer.alloc(SERVICE_ERROR_LOG_KEPT_BYTES)
    const reader = openSync(path, "r")
    let kept: number
    try {
      kept = readSync(reader, tail, 0, tail.length, bytes - tail.length)
    } finally {
      closeSync(reader)
    }
    ftruncateSync(fd, 0)
    writeSync(fd, tail, 0, kept)
    Log.Default.info("the account service's error log passed its bound; this start kept its last bytes", { bytes, kept })
  } catch (error) {
    Log.Default.warn("the account service's error log could not be trimmed", { error: errorMessage(error) })
  }
}

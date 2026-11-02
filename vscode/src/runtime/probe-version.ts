import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

/** Asking a program its version is fast or it is broken. This bound is what
 *  keeps a broken one from hanging activation: an executable that starts and
 *  then neither answers nor exits is a real shape (a wrapper script, a binary
 *  on a stalled network mount), and `execFile`'s timeout kills it rather than
 *  letting the probe outlive the answer. */
const PROBE_TIMEOUT_MS = 10_000

/** Asks a candidate executable its version.
 *
 *  Undefined means it is not a usable Flywheel: missing, not executable,
 *  unanswering within the bound, or answering something that is not a version.
 *  This is the one place the version-line shape is known: the runtime prints
 *  "flywheel 0.0.4" or a bare "0.0.4", and the first thing shaped like a
 *  version is taken. */
export async function probeVersion(executable: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<string | undefined> {
  try {
    const { stdout } = await run(executable, ["--version"], { timeout: timeoutMs, windowsHide: true })
    return /(\d+\.\d+\.\d+[^\s]*)/.exec(stdout.trim())?.[1]
  } catch {
    return undefined
  }
}

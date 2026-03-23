/**
 * Tree-kill with signal escalation.
 *
 * Sends SIGTERM first, then escalates to SIGKILL if the process is still
 * alive after a grace period. Uses polling to check process liveness.
 *
 * Usage:
 *   import { treeKillWithEscalation } from "../worker/tree-kill"
 *   await treeKillWithEscalation(childPid, { graceMs: 2000 })
 *
 * NOTE: This module creates the utility only. It does NOT replace the
 * existing `gracefulKill()` in `process-lifecycle.ts`.
 */

import { Log } from "../utils/log"

const log = Log.create({ service: "tree-kill" })

export interface TreeKillOptions {
  /** Grace period in ms before escalating from SIGTERM to SIGKILL. Default: 2000. */
  graceMs?: number
  /** Polling interval in ms for alive checks. Default: 50. */
  pollMs?: number
}

/**
 * Check if a process is alive.
 *
 * Uses `process.kill(pid, 0)` which sends no signal but checks existence.
 * - ESRCH: process does not exist (dead)
 * - EPERM: process exists but we lack permission (alive)
 * - No error: process exists and we have permission (alive)
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ESRCH") return false
      if (code === "EPERM") return true
    }
    // Unknown error — assume dead
    return false
  }
}

/**
 * Kill a process tree with SIGTERM → SIGKILL escalation.
 *
 * 1. Sends SIGTERM to the process group (-pid on Unix)
 * 2. Polls until the process is dead or grace period elapses
 * 3. If still alive after grace period, sends SIGKILL
 * 4. Polls again until dead (with the same grace period as max wait)
 */
export async function treeKillWithEscalation(
  pid: number,
  opts: TreeKillOptions = {},
): Promise<void> {
  const graceMs = opts.graceMs ?? 2000
  const pollMs = opts.pollMs ?? 50

  // Send SIGTERM
  log.info("sending SIGTERM", { pid })
  sendSignal(pid, "SIGTERM")

  // Poll until dead or grace period expires
  const dead = await pollUntilDead(pid, graceMs, pollMs)
  if (dead) {
    log.info("process exited after SIGTERM", { pid })
    return
  }

  // Escalate to SIGKILL
  log.warn("process still alive after grace period, sending SIGKILL", {
    pid,
    graceMs,
  })
  sendSignal(pid, "SIGKILL")

  // Poll again — SIGKILL should be near-instant but give it time
  const killedAfterSigkill = await pollUntilDead(pid, graceMs, pollMs)
  if (killedAfterSigkill) {
    log.info("process exited after SIGKILL", { pid })
  } else {
    log.error("process still alive after SIGKILL", { pid })
  }
}

/**
 * Send a signal to a process group (Unix) or process directly.
 */
function sendSignal(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    if (process.platform !== "win32") {
      // Negative PID targets the process group on Unix
      process.kill(-pid, signal)
    } else {
      process.kill(pid, signal)
    }
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ESRCH" || code === "EPERM") {
        // ESRCH on group kill: child may not have its own process group
        // EPERM on group kill: no permission for group kill
        // In both cases, fall back to direct pid kill
        try {
          process.kill(pid, signal)
        } catch (directErr: unknown) {
          // ESRCH here means the process is truly gone — that's fine
          if (
            directErr &&
            typeof directErr === "object" &&
            "code" in directErr &&
            (directErr as NodeJS.ErrnoException).code === "ESRCH"
          ) {
            return
          }
          // ignore other errors on fallback
        }
        return
      }
    }
    log.warn("failed to send signal", { pid, signal, error: String(err) })
  }
}

/**
 * Poll until a process is dead or timeout elapses.
 * @returns `true` if the process died, `false` if timeout expired.
 */
async function pollUntilDead(
  pid: number,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await sleep(pollMs)
  }
  // Final check after deadline
  return !isProcessAlive(pid)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

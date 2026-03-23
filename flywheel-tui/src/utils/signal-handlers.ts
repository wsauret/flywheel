/**
 * Signal handler utilities for graceful shutdown.
 *
 * Provides idempotent signal registration and a `shutdownOnce()` function
 * that ensures cleanup runs exactly once, with a watchdog timer for
 * force-exit if cleanup hangs.
 *
 * Usage:
 *   import { setupSignalHandlers } from "../utils/signal-handlers"
 *
 *   setupSignalHandlers(async () => {
 *     await killAllActiveProcesses()
 *     await saveSessions()
 *   })
 *
 * NOTE: This module creates the utilities only. Wiring into the actual
 * CLI entry point is deferred to avoid breaking the TUI.
 */

import { Log } from "./log"

const log = Log.create({ service: "signal" })

/** Force-exit watchdog timeout (10 seconds). */
const WATCHDOG_MS = 10_000

let installed = false
let shutdownStarted = false
let cleanupFn: (() => Promise<void>) | null = null

/**
 * Register signal handlers for SIGINT and SIGTERM.
 * Idempotent — calling multiple times updates the cleanup function
 * but does not register duplicate listeners.
 */
export function setupSignalHandlers(cleanup: () => Promise<void>): void {
  cleanupFn = cleanup

  if (installed) return
  installed = true

  const handler = () => {
    shutdownOnce()
  }

  process.on("SIGINT", handler)
  process.on("SIGTERM", handler)

  log.info("signal handlers registered")
}

/**
 * Run cleanup exactly once. Subsequent calls are no-ops.
 * A watchdog timer force-exits after 10 seconds if cleanup hangs.
 */
export async function shutdownOnce(): Promise<void> {
  if (shutdownStarted) {
    log.warn("shutdown already in progress, ignoring duplicate call")
    return
  }
  shutdownStarted = true
  log.info("shutdown initiated")

  // Watchdog: force-exit if cleanup takes too long
  const watchdog = setTimeout(() => {
    log.error("cleanup timed out, force-exiting", { timeoutMs: WATCHDOG_MS })
    process.exit(1)
  }, WATCHDOG_MS)

  // Unref so the timer doesn't keep the event loop alive if cleanup finishes quickly
  if (typeof watchdog === "object" && "unref" in watchdog) {
    watchdog.unref()
  }

  try {
    if (cleanupFn) {
      await cleanupFn()
    }
    log.info("cleanup completed successfully")
  } catch (err) {
    log.error("cleanup failed", {
      error: err instanceof Error ? err : String(err),
    })
  } finally {
    clearTimeout(watchdog)
  }
}

/**
 * Reset internal state. For testing only.
 * @internal
 */
export function _resetForTesting(): void {
  installed = false
  shutdownStarted = false
  cleanupFn = null
}

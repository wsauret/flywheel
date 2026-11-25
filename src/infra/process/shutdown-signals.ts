export type ShutdownSignal = "SIGHUP" | "SIGTERM" | "SIGINT"

const POSIX_SHUTDOWN_SIGNALS = ["SIGHUP", "SIGTERM", "SIGINT"] as const satisfies readonly ShutdownSignal[]
const WINDOWS_SHUTDOWN_SIGNALS = ["SIGHUP", "SIGINT"] as const satisfies readonly ShutdownSignal[]

/**
 * Returns the shutdown signals delivered by each supported platform.
 *
 * Windows includes SIGHUP for best-effort terminal-close handling. Hard kills
 * do not deliver SIGHUP, so cleanup cannot run when the process is forcibly
 * terminated.
 */
export function shutdownSignals(platform: NodeJS.Platform): readonly ShutdownSignal[] {
  switch (platform) {
    case "darwin":
    case "linux":
      return POSIX_SHUTDOWN_SIGNALS
    case "win32":
      return WINDOWS_SHUTDOWN_SIGNALS
    default:
      return []
  }
}

/** What an entry point returns once shutdown closed its admission: the call
 *  never started, so it owns no session and left nothing to interrupt. */
export const ADMISSION_CLOSED_ERROR = "Flywheel is shutting down"

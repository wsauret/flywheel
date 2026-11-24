/** The words every client and the runtime use for a restart of the account
 *  service from a web client (PI-INTERACTION-048). The runtime's refusal and
 *  the client's disabled row say the same sentence, so it lives here once. */

/** Why a restart is refused while nothing would start the service again. */
export const RESTART_NO_STARTER_REASON = "Nothing would start Flywheel again. Turn on Start at login to restart from here."

/** Why a restart is refused on Windows while Task Scheduler runs the
 *  service: it does not start the task again when the service exits, and
 *  Start at login is already on, so the sentence names the action that
 *  works instead. */
export const RESTART_TASK_SCHEDULER_REASON = "Windows does not start Flywheel again after it stops. Use /restart in a terminal on this computer."

/** Why a restart is refused when the service would start its own successor
 *  but the program it would run is not there. */
export function restartLaunchMissingReason(path: string): string {
  return `Flywheel could not start again, because ${path} is missing.`
}

/** Why a restart is refused when the service could not check the work that
 *  would delay it, so it did not accept the request. */
export const RESTART_UNCHECKED_REASON = "Flywheel could not check its running work, so it did not restart. Try again."

/** What a client says when the old service left but no successor answered. */
export function restartNoSuccessorReason(seconds: number): string {
  return `Flywheel stopped, but no new service answered within ${seconds} seconds.`
}

/** What a client says when it could not read whether a restart would work. */
export function restartReadinessUnknownReason(cause: string): string {
  return `Could not check whether Flywheel can restart: ${cause}`
}

/** The one confirmation a restart asks for. */
export const RESTART_CONFIRMATION = {
  title: "Restart Flywheel?",
  detail: "Running tools stop with their turn and continue after the restart. Shell commands keep running.",
  confirmLabel: "Restart",
} as const

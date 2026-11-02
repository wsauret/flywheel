/** What the entry knows about `flywheel serve` before the command's own module
 *  loads: which arguments start the account service, and the exit codes the
 *  service managers act on. A start of the installed service counts itself at
 *  the entry, before command composition, so this module stays light. */

import { SCHEDULED_TASK_ARGUMENT } from "../orchestration/app-service/account-service-registration.js"

/** The exit-code contract of the service managers that restart a job
 *  (ARCH-RUNTIME-041, ARCH-RUNTIME-042): launchd's KeepAlive and systemd's Restart=on-failure with
 *  RestartForceExitStatus. 0 parks the job, because another owner serves,
 *  nothing should run, or the lane's starts have failed long enough, before
 *  their listen or within their first minute after it, that a restart would
 *  only fail again. A parked lane stays parked until a start serves its first
 *  minute or ends by its own exit path during it: a client's start request
 *  runs one start, and that start exits 0 again at once when it fails for a
 *  cause that can park. Any other code restarts it: a retirement for a newer
 *  build or a stale registration, a start that rolled `current` back from a
 *  build whose service cannot start, a stale start that cannot tell whether
 *  a registration reload is in flight, a start that another holder of the
 *  start lock or an address probe that proves nothing refuses, a stop by a
 *  signal, such as the one `flywheel kill` sends, and a crash whose failure
 *  has not persisted. Task Scheduler is not proven to restart a task on its
 *  exit code, so on Windows the next client start request or logon starts
 *  the successor. */
export const SERVE_EXIT = { parked: 0, restart: 75 } as const

/** Whether the arguments after `serve` start the account service, as a
 *  service manager or a client runs it, rather than manage its registration
 *  or ask for help. */
export function startsService(args: readonly string[]): boolean {
  return args.length === 0 || (args.length === 1 && args[0] === SCHEDULED_TASK_ARGUMENT)
}

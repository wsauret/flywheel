import { Log } from "../../infra/log.js"

const log = Log.create({ service: "service-manager-command" })

/** A service manager command as the account service installation runs it
 *  (ARCH-RUNTIME-040): the runner it drives the manager through, and how it reads
 *  what the manager answered. */

/** What the installation drives the service manager through: the exit status
 *  and captured text are all it reads. A null exit status, or a command its
 *  runner ended at its timeout, means the command did not answer. `timeoutMs`
 *  ends a command that must answer sooner than the runner's own bound. An
 *  owned command runner satisfies it, and so does a trusted command run of
 *  `serviceCommandLaunch`, which is what a client attach has before any
 *  launcher scope exists; that run keeps its own bound, because a client
 *  attach only starts the service. */
export type ServiceCommandRunner = (command: readonly string[], options?: { readonly timeoutMs?: number }) => Promise<ServiceCommandOutput>

export interface ServiceCommandOutput {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut?: boolean
}

export class AccountServiceInstallationError extends Error {
  readonly _tag = "AccountServiceInstallationError" as const
  /** The manager did not answer, so what it did is unknown: a start it was
   *  asked for may still happen. */
  readonly unanswered: boolean
  constructor(message: string, options?: { readonly unanswered?: boolean }) {
    super(message)
    this.unanswered = options?.unanswered ?? false
  }
}

/** Whether the manager answered the command. One that did not answer proves
 *  nothing about what the manager did. */
export function answered(result: ServiceCommandOutput): boolean {
  return result.exitCode !== null && result.timedOut !== true
}

export function failure(step: string, result: ServiceCommandOutput): AccountServiceInstallationError {
  if (!answered(result)) return new AccountServiceInstallationError(`${step} did not answer`, { unanswered: true })
  const detail = (result.stderr || result.stdout).trim()
  return new AccountServiceInstallationError(`${step} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`)
}

/** Answers a start request the manager did not answer as requested, and
 *  rethrows any other failure. A manager that does not answer has the
 *  request and may still act on it: right after an install, launchd held
 *  `kickstart` past its bound and started the job seconds later. Only the
 *  service's own socket proves the outcome, so the caller waits for it. */
export function unansweredStartRequested(error: unknown): true {
  if (!(error instanceof AccountServiceInstallationError) || !error.unanswered) throw error
  log.info("the service manager did not answer a start of the account service; the start counts as requested", { error: error.message })
  return true
}

export function assertOk(step: string, result: ServiceCommandOutput): void {
  if (result.exitCode !== 0) throw failure(step, result)
}

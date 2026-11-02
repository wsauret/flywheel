import { constants } from "node:os"
import { errorMessage } from "../../infra/error-message.js"
import type { Log } from "../../infra/log.js"
import type { ReattachableProcessEndpoint } from "../../infra/reattachable-process-endpoint.js"
import { shutdownSignals, type ShutdownSignal } from "../../infra/shutdown-signals.js"

/** The part of the process API the listener uses. */
interface SignalledProcess {
  readonly pid: number
  on(signal: ShutdownSignal, listener: () => void): void
  off(signal: ShutdownSignal, listener: () => void): void
  kill(pid: number, signal: ShutdownSignal): void
  exit(code: number): void
}

/** The executor's ordered stop, which the listener runs once the executor serves. */
interface ServedStop {
  /** Starts the executor's ordered stop, or joins the stop that runs, and
   *  settles when that stop settles. */
  readonly stop: (trigger: `signal ${ShutdownSignal}`, clientsHold: boolean) => Promise<void>
  /** The channel the stop writes to the account through. */
  readonly lifecycle: Pick<ReattachableProcessEndpoint<unknown, unknown>, "attached" | "onDetach">
  /** Whether the executor's stop has done its work and answered the
   *  account, so that only its closures and the exit remain. */
  readonly finished: () => boolean
}

/** What the executor's stop signal listener needs from the executor. */
interface ExecutorStopSignals {
  /** Hands the listener the executor's ordered stop once the executor serves. */
  serve(stop: ServedStop): void
}

/** Listens for the signals that ask this project executor to stop, from
 *  whoever sends them: a person, `flywheel kill`, a logout, the host's
 *  shutdown, or its command supervisor. The first signal writes one receipt,
 *  and the process ends by that signal, so its exit status is the one the
 *  signal would give without this listener: the signal itself on POSIX, and
 *  on Windows the exit code a shell reports for it.
 *
 *  While the executor serves and its lifecycle channel is attached, the
 *  listener first runs the executor's ordered stop, which records the
 *  runtime's cut of each running turn and saves its work. The turn's label
 *  comes from that record, so a kill after it keeps the turn interrupted by
 *  the runtime (ARCH-SESSIONS-035). It ends the process when
 *  that stop settles, or when the lifecycle channel detaches first. The stop
 *  writes through the account, so with no attached channel it could only wait
 *  for the sender's kill; before the executor serves, or with the channel
 *  detached, the listener ends the process at once. A later signal joins the
 *  running stop.
 *
 *  A signal that arrives after the executor's stop finished cuts no work:
 *  the command supervisor ends the container of every stop the account
 *  asked for, often before the executor exits on its own. Its receipt is
 *  INFO; a receipt that cuts work is WARN. */
export function listenForExecutorStopSignals(options: {
  readonly platform: NodeJS.Platform
  readonly log: Pick<ReturnType<typeof Log.create>, "warn" | "info" | "debug">
  readonly process?: SignalledProcess
}): ExecutorStopSignals {
  const { log } = options
  const host = options.process ?? process
  const listeners = new Map<ShutdownSignal, () => void>()
  let served: ServedStop | undefined
  // The first signal: the one the process ends by.
  let received: ShutdownSignal | undefined

  // On POSIX a signal that no listener holds ends the process by its default
  // action, so the status is the signal's. Windows gives a signal a process
  // sends itself no such action, so there the process exits with the code a
  // shell reports for that signal.
  const end = (signal: ShutdownSignal): void => {
    const listener = listeners.get(signal)
    if (listener) host.off(signal, listener)
    if (options.platform === "win32") host.exit(windowsSignalExitCode(signal))
    else host.kill(host.pid, signal)
  }

  const receive = (signal: ShutdownSignal): void => {
    if (received !== undefined) {
      log.debug("executor stop signal joins the running stop", { signal, endsBy: received })
      return
    }
    received = signal
    if (served?.finished()) {
      log.info("executor stop signal received", { signal, orderedStop: false, why: "the executor's stop has finished" })
      end(signal)
      return
    }
    if (!served?.lifecycle.attached) {
      log.warn("executor stop signal received", { signal, orderedStop: false, why: served ? "the lifecycle channel is detached" : "the executor does not serve yet" })
      end(signal)
      return
    }
    log.warn("executor stop signal received", { signal, orderedStop: true })
    let ended = false
    const endAfter = (after: "stop settled" | "stop failed" | "lifecycle channel detached", error?: unknown): void => {
      if (ended) return
      ended = true
      stopWatchingDetach()
      if (after === "stop failed") log.warn("executor ends by its stop signal", { signal, after, error: errorMessage(error) })
      else log.info("executor ends by its stop signal", { signal, after })
      end(signal)
    }
    const stopWatchingDetach = served.lifecycle.onDetach(() => { endAfter("lifecycle channel detached") })
    // Nothing here knows whether a client holds the project, and its
    // clients attach to the next generation, so the stop keeps every empty
    // chat. The stop's first reaction handles both outcomes, so a stop that
    // fails leaves no unhandled rejection to end the process first.
    served.stop(`signal ${signal}`, true).then(() => { endAfter("stop settled") }, (error: unknown) => { endAfter("stop failed", error) })
  }

  for (const signal of shutdownSignals(options.platform)) {
    const listener = (): void => { receive(signal) }
    listeners.set(signal, listener)
    host.on(signal, listener)
  }
  return {
    serve(stop) { served = stop },
  }
}

/** The exit code a shell reports for a signal: 128 and the signal's number. */
function windowsSignalExitCode(signal: ShutdownSignal): number {
  return 128 + constants.signals[signal]
}

/** The stop signal that an executor's own exit status says it ended by, as
 *  this listener ends it: the signal itself on POSIX, and on Windows the
 *  exit code for the signal. Undefined for every other end, SIGKILL too. */
export function executorStopSignalOf(exit: { readonly code: number | null; readonly signal: string | null }, platform: NodeJS.Platform): ShutdownSignal | undefined {
  return shutdownSignals(platform).find((signal) => platform === "win32"
    ? exit.signal === null && exit.code === windowsSignalExitCode(signal)
    : exit.signal === signal)
}

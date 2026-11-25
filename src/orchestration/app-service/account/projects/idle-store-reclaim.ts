import { errorMessage } from "../../../../infra/diagnostics/error-message.js"
import { Log } from "../../../../infra/diagnostics/log.js"
import type { ReplacementBlocker } from "../../executor/replacement-blockers.js"

const log = Log.create({ service: "idle-store-reclaim" })

/** The least time between the starts of two idle reclaim runs of one
 *  project. Turns end many times an hour, and the space one turn frees is
 *  small, so one run an hour keeps the store close to its live size without
 *  a run after every turn. */
export const IDLE_RECLAIM_INTERVAL_MS = 60 * 60_000

/** How long after a check that found work the owner checks again by itself.
 *  The executor reports changes of its work only while a replacement is
 *  held, so this is how a project that becomes idle later gets its run. One
 *  read of the executor's blockers each time. */
export const IDLE_RECLAIM_RECHECK_MS = 5 * 60_000

/** One admitted idle reclaim run, as the maintenance queue hands it back. */
interface IdleReclaimRun {
  readonly settled: Promise<void>
  withdraw(): Promise<void>
}

interface IdleStoreReclaimOptions {
  /** What runs in the project now; empty means idle. */
  readonly blockers: () => Promise<readonly ReplacementBlocker[]>
  /** Starts the store's automatic conversion when it is due; answers whether
   *  it started. A started conversion closes the project, so it takes the
   *  place of the idle run and the owner starts nothing more. */
  readonly convert: () => boolean
  /** Queues one idle reclaim run. */
  readonly start: () => IdleReclaimRun
  readonly now?: () => number
  /** Arms the owner's one later check; answers its cancel. */
  readonly setTimer?: (fire: () => void, delayMs: number) => () => void
}

export interface IdleStoreReclaim {
  /** Reads whether the project is idle now: starts a run when it is and the
   *  last run started at least the interval ago, and withdraws the running
   *  one when work started. Checks run one at a time, and a check asked for
   *  while one runs runs once after it. Once asked, the owner keeps checking
   *  by itself: again after the recheck time while work runs, and when the
   *  interval since the last start ends, so the order in which the project
   *  becomes ready and idle does not decide whether a run starts. An idle
   *  check first offers the store's automatic conversion. */
  check(): void
  /** Admits no run from now on and joins the one that runs. */
  dispose(): Promise<void>
}

/** Owns when one project's idle reclaim runs (ARCH-RUNTIME-083). It reads the
 *  project's own report of its running work, the blockers its executors
 *  publish, and keeps no state of its own about that work. */
export function createIdleStoreReclaim(options: IdleStoreReclaimOptions): IdleStoreReclaim {
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((fire: () => void, delayMs: number) => {
    const timer = setTimeout(fire, delayMs)
    timer.unref?.()
    return () => { clearTimeout(timer) }
  })
  let lastStart: number | undefined
  let running: IdleReclaimRun | undefined
  let checking: Promise<void> | undefined
  let again = false
  let disposed = false
  let converting = false
  let cancelLater: (() => void) | undefined

  const later = (delayMs: number): void => {
    cancelLater?.()
    cancelLater = disposed ? undefined : setTimer(() => {
      cancelLater = undefined
      check()
    }, delayMs)
  }
  const untilInterval = (): number => lastStart === undefined ? 0 : Math.max(0, lastStart + IDLE_RECLAIM_INTERVAL_MS - now())

  async function decide(): Promise<void> {
    const blockers = await options.blockers()
    if (disposed) return
    if (blockers.length > 0) {
      void running?.withdraw()
      if (running === undefined) later(Math.max(IDLE_RECLAIM_RECHECK_MS, untilInterval()))
      return
    }
    // A run's end arms the next check.
    if (running !== undefined) return
    // Called in the same task as the blockers' answer, so nothing in this
    // loop starts work between the idle answer and the close.
    if (options.convert()) {
      converting = true
      return
    }
    if (untilInterval() > 0) {
      later(untilInterval())
      return
    }
    lastStart = now()
    const run = options.start()
    running = run
    void run.settled.then(() => {
      if (running !== run) return
      running = undefined
      later(untilInterval())
    })
  }

  function check(): void {
    if (disposed || converting) return
    if (checking) {
      again = true
      return
    }
    checking = decide().catch((error: unknown) => {
      log.warn("idle store reclaim check failed", { error: errorMessage(error) })
    }).finally(() => {
      checking = undefined
      if (again) {
        again = false
        check()
      }
    })
  }

  return {
    check,
    async dispose() {
      disposed = true
      cancelLater?.()
      cancelLater = undefined
      await checking
      await running?.withdraw()
    },
  }
}

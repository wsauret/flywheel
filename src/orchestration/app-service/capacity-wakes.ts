import type { ServeLane } from "../../infra/cli-subprocess.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { sleepUntil, systemWallClock, type WallClock } from "../../infra/wall-clock-sleep.js"
import { recordCapacityWait } from "../session/capacity-wait.js"
import type { CapacityWakeStore } from "./account-project-registry.js"
import { restartBackoffMs } from "./project-executor-generations.js"

const log = Log.create({ service: "capacity-wakes" })

/** What one wake of a project left: whether a due wait is still owed by a
 *  continuation that could not start, and the earliest time of a wait the
 *  continuation left for later, or null. */
export interface CapacityWakeResult {
  readonly owed: boolean
  readonly next: number | null
}

export interface CapacityWakesOptions {
  readonly lane: ServeLane
  readonly store: CapacityWakeStore
  /** Opens the project, or answers the one that is open, asks it for
   *  execution as the runtime does, so a project whose executor ended starts
   *  one, and asks that executor to continue every due capacity wait no run
   *  of it holds. A wake that rejects or leaves a due wait owed is tried
   *  again. */
  readonly wake: (projectRoot: string) => Promise<CapacityWakeResult>
  readonly clock?: WallClock
  /** The wait before the next attempt after `failures` failed wakes in a
   *  row. Defaults to the executor restart backoff. */
  readonly retryDelayMs?: (failures: number) => number
}

export interface CapacityWakes {
  /** Arms a wake for every row an earlier service left, at once for each
   *  one that is due, judged by the wall clock. */
  start(): void
  /** Records the project's wake as its executor reported it, or retires it
   *  for null, and arms it. Resolves once the account store holds it, which
   *  the executor awaits before it writes the row of a wait; rejects when
   *  the store refused it, and then nothing is armed. */
  report(projectRoot: string, at: number | null): Promise<void>
  /** Arms the project's recorded wake again, at once when it is due: the
   *  executor that held its waits live has ended. */
  rearm(projectRoot: string): void
  /** Ends every armed wake; the rows stay for the next service. */
  dispose(): void
}

/** The account's half of the capacity waits (PI-MODEL-039, ARCH-SESSIONS-039):
 *  one wake per project, at the earliest time its executor reported, in the
 *  account store, so it outlives a restart, a crash, and a reboot of the
 *  service. At that time the account opens the project when no executor
 *  serves it, which continues the due waits there. A wake that fails, or
 *  that leaves a due wait owed, tries again on the restart backoff, with no
 *  limit, until the project reports a new time: continuing wins. A wake that
 *  continued every due wait arms the next at the time of the earliest wait
 *  it left for later. The stored time stays the earliest owed one, also
 *  while a continued run holds it, so a restart of the service or an end of
 *  the executor continues that run again at once. The first failure of a
 *  wake is a warning, and its repeats are one count reported when the wake
 *  ends. */
export function createCapacityWakes(options: CapacityWakesOptions): CapacityWakes {
  const { lane, store } = options
  const clock = options.clock ?? systemWallClock
  const retryDelayMs = options.retryDelayMs ?? restartBackoffMs
  const disposal = new AbortController()
  const armed = new Map<string, AbortController>()
  const recorded = new Map<string, number>()
  // Row writes are one at a time, in the order the reports arrived.
  let writes = Promise.resolve()

  const arm = (projectRoot: string, at: number): void => {
    armed.get(projectRoot)?.abort()
    const controller = new AbortController()
    armed.set(projectRoot, controller)
    const signal = AbortSignal.any([controller.signal, disposal.signal])
    let failures = 0
    void (async () => {
      for (; ; failures += 1) {
        await sleepUntil(failures === 0 ? at : clock.now() + retryDelayMs(failures), signal, clock)
        if (signal.aborted) return
        const first = failures === 0
        if (first) recordCapacityWait("fired", { projectRoot, continuesAt: at })
        const woken = await options.wake(projectRoot).catch((error: unknown) => {
          if (first) log.warn("a capacity wake could not continue the project's waits; it tries again", { projectRoot, error: errorMessage(error) })
          return undefined
        })
        if (woken === undefined || woken.owed) continue
        if (woken.next !== null && !signal.aborted) arm(projectRoot, woken.next)
        return
      }
    })().finally(() => {
      if (failures > 1) log.info("a capacity wake ended after attempts that failed", { projectRoot, failedAttempts: failures })
      if (armed.get(projectRoot) === controller) armed.delete(projectRoot)
    })
  }

  return {
    start() {
      for (const { projectRoot, at } of store.capacityWakes(lane)) {
        recorded.set(projectRoot, at)
        recordCapacityWait("rearmed", { projectRoot, continuesAt: at })
        arm(projectRoot, at)
      }
    },
    report(projectRoot, at) {
      const write = writes.then(async () => {
        if ((recorded.get(projectRoot) ?? null) === at) return
        await store.recordCapacityWake(lane, projectRoot, at)
        if (at === null) {
          recorded.delete(projectRoot)
          armed.get(projectRoot)?.abort()
        } else {
          recorded.set(projectRoot, at)
          arm(projectRoot, at)
        }
      })
      writes = write.catch((error: unknown) => {
        log.warn("a capacity wake could not be recorded", { projectRoot, error: errorMessage(error) })
      })
      return write
    },
    rearm(projectRoot) {
      const at = recorded.get(projectRoot)
      if (at === undefined) return
      recordCapacityWait("rearmed", { projectRoot, continuesAt: at })
      arm(projectRoot, at)
    },
    dispose() {
      disposal.abort()
    },
  }
}

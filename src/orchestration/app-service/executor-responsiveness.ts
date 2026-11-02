import type { Log } from "../../infra/log.js"

/** Heartbeat periods in a row with no heartbeat that prove an executor
 *  wedged. At the one-second production period, a loaded machine's stalls,
 *  which run to several seconds, never read as a wedge. */
const WEDGED_AFTER_PERIODS = 30
/** Missed periods in a row, after the first heartbeat, that are worth a
 *  record: the executor's event loop was busy or stalled. */
const STALL_LOG_PERIODS = 3

/** Lets every I/O callback that is already due run first, so a heartbeat
 *  that arrived while this process was busy is counted before a check. */
const afterPendingIo = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

/** The evidence that an executor is wedged. */
export interface ExecutorWedgeProof {
  /** Checks in a row that found no heartbeat since the check before. */
  readonly missedPeriods: number
  /** Wall-clock time since the last heartbeat, or since the count began
   *  when none came after it. For records only: no decision reads it. */
  readonly silentMs: number
}

/** The account's fact of whether one executor generation's event loop
 *  answers, counted from the heartbeats on its lifecycle channel.
 *
 *  A check runs once each heartbeat period, on one timer that arms itself
 *  again after each check. The check first lets the I/O that is due run, so
 *  it reads every heartbeat already waiting, and then counts one missed
 *  period when no heartbeat arrived since the check before. A check counts
 *  once however late it fires, so neither a host sleep nor a stall of this
 *  process adds silence, whatever the platform's timer clock does while the
 *  host sleeps. */
export interface ExecutorResponsiveness {
  /** Records one heartbeat, which sets the missed count back to zero. */
  beat(): void
  /** Begins the checks at the executor's launch, so an executor that never
   *  sends its first heartbeat is counted like one that went silent. */
  start(): void
  /** Tells `listener` at each check once `WEDGED_AFTER_PERIODS` periods in a
   *  row went without a heartbeat. Returns the function that stops it. */
  onWedged(listener: (proof: ExecutorWedgeProof) => void): () => void
  /** The heartbeats received so far, for records. */
  readonly heartbeats: number
  /** The silence now, for records: the missed periods the checks counted and
   *  the time since the last heartbeat. It proves nothing: only the wedge
   *  bound does. */
  silence(): { readonly missedPeriods: number; readonly silentMs: number }
  /** Stops the checks while the lifecycle channel is detached: a heartbeat
   *  cannot arrive then, and the reattach deadline owns that case. */
  pause(): void
  /** Counts again from zero, once the lifecycle channel is back. */
  resume(): void
  /** Ends the watch when its generation ends. */
  dispose(): void
}

export function watchExecutorResponsiveness(options: {
  readonly log: Pick<ReturnType<typeof Log.create>, "warn" | "info">
  /** The executor's heartbeat period, which is also the period of each check. */
  readonly periodMs: number
  /** The clock of the generation the watch serves, so that one generation
   *  reads one clock. */
  readonly now: () => number
  readonly setTimer: (fire: () => void, delayMs: number) => () => void
  /** Resolves once the I/O that is already due has run. */
  readonly yieldToIo?: () => Promise<void>
}): ExecutorResponsiveness {
  const { now, setTimer } = options
  const yieldToIo = options.yieldToIo ?? afterPendingIo
  const listeners = new Set<(proof: ExecutorWedgeProof) => void>()
  let heartbeats = 0
  let heartbeatsAtCheck = 0
  let missedPeriods = 0
  let silentSince = now()
  let stalled = false
  let started = false
  let paused = false
  let disposed = false
  // The check that is armed now. A check that fired before a pause, a
  // resume, or the end finds another one, or none, here and counts nothing.
  let armed: { readonly cancel: () => void } | undefined

  const check = (): void => {
    if (heartbeats === heartbeatsAtCheck) missedPeriods += 1
    heartbeatsAtCheck = heartbeats
    const silentMs = now() - silentSince
    if (heartbeats > 0 && !stalled && missedPeriods >= STALL_LOG_PERIODS) {
      stalled = true
      options.log.warn("executor heartbeat stalled", { missedPeriods, silentMs })
    }
    // Armed before the listeners hear the proof: one that ends the
    // generation disposes the watch, and with it this next check.
    arm()
    if (missedPeriods >= WEDGED_AFTER_PERIODS) for (const listener of listeners) listener({ missedPeriods, silentMs })
  }

  const arm = (): void => {
    const next = {
      cancel: setTimer(() => {
        void yieldToIo().then(() => { if (armed === next) check() })
      }, options.periodMs),
    }
    armed = next
  }

  const disarm = (): void => {
    armed?.cancel()
    armed = undefined
  }

  /** Begins a count from zero: at the launch, and again at each reattach. */
  const begin = (): void => {
    missedPeriods = 0
    heartbeatsAtCheck = heartbeats
    silentSince = now()
    stalled = false
    arm()
  }

  return {
    beat() {
      if (disposed) return
      const at = now()
      if (stalled) options.log.info("executor heartbeat resumed", { stallMs: at - silentSince })
      stalled = false
      heartbeats += 1
      missedPeriods = 0
      silentSince = at
    },
    start() {
      if (started || disposed) return
      started = true
      if (!paused) begin()
    },
    onWedged(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    get heartbeats() { return heartbeats },
    silence: () => ({ missedPeriods, silentMs: now() - silentSince }),
    pause() {
      if (disposed || paused) return
      paused = true
      disarm()
    },
    resume() {
      if (disposed || !paused) return
      paused = false
      if (started) begin()
    },
    dispose() {
      disposed = true
      disarm()
      listeners.clear()
    },
  }
}

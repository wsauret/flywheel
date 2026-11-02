import { abortableSleep } from "./abort.js"

/** The longest one timer of `sleepUntil` runs before it reads the wall clock
 *  again. A timer counts monotonic time, which stops while the machine
 *  sleeps, so a wait for a stated wall-clock time ends at most this long
 *  after the machine wakes past that time. */
export const WALL_CLOCK_CHECK_MS = 60_000

export interface WallClock {
  readonly now: () => number
  /** Resolves after `ms`, or at once when `signal` aborts. Never rejects. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

/** Resolves once the wall clock reaches `atMs`, also when the machine slept
 *  through that time, or at once when `signal` aborts. Never rejects. */
export async function sleepUntil(atMs: number, signal: AbortSignal, clock: WallClock): Promise<void> {
  for (let left = atMs - clock.now(); left > 0 && !signal.aborted; left = atMs - clock.now()) {
    await clock.sleep(Math.min(left, WALL_CLOCK_CHECK_MS), signal)
  }
}

/** The system wall clock, whose sleeps run on the process timers and end
 *  early, without rejecting, when their signal aborts. */
export const systemWallClock: WallClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => abortableSleep(ms, signal).catch(() => undefined),
}

/**
 * Wheel input: how one terminal wheel report becomes transcript rows, and how
 * the rows of the reports reach the screen over frames.
 *
 * Terminals report the wheel in one of two ways. Ghostty and most other
 * terminals report each scrolled line and carry a touchpad's momentum as more
 * reports, so a report moves one row and a frame applies every row that waits.
 *
 * Windows Terminal reports notches. In mouse mode it adds a touchpad's deltas
 * until they reach WHEEL_DELTA (120), sends one report, and discards the rest
 * of the sum; a delta in the other direction or a pointer move sets the sum
 * back to zero (microsoft/terminal, src/terminal/input/mouseInput.cpp,
 * TerminalInput::HandleMouse). A report carries no distance, so a fast swipe
 * and a slow one look the same except for the time between reports. A notch
 * report therefore moves the three lines of a Windows notch, a fast run of
 * reports accelerates on a decay curve tuned for Windows Terminal, and each
 * frame applies half of the rows that wait, so that one
 * report glides over a few frames instead of jumping.
 *
 * Every report moves the view by at least one row, and no row of a report is
 * ever dropped; only the content bounds stop the view.
 */

/** Wheel acceleration for terminals that report notches. Every
 *  value is a tuning constant; a recording of real reports changes only these. */
interface NotchCurve {
  /** Same-direction reports closer together than this arrived in one read;
   *  each one after the first moves one row. */
  readonly burstGapMs: number
  /** A pause longer than this ends the streak; the next report starts again
   *  at the base rows. */
  readonly streakGapMs: number
  /** The streak's speed halves for each interval of this length between two
   *  reports. */
  readonly halfLifeMs: number
  /** Rows that a quick report adds to the streak before the decay. */
  readonly boostRows: number
  /** Reports at least this far apart are slow scrolling. */
  readonly slowGapMs: number
  /** The most rows that one slow report moves. */
  readonly slowCapRows: number
  /** The most rows that one quick report moves. */
  readonly fastCapRows: number
}

/** How the host terminal reports the wheel. */
export interface WheelProfile {
  /** Rows that a report moves at the start of a streak, and always when there
   *  is no curve. */
  readonly baseRows: number
  /** The acceleration for notch reports; none for line reports. */
  readonly curve?: NotchCurve
  /** The share of the waiting rows that one frame applies, in (0, 1]. One
   *  applies them all on the next frame. */
  readonly frameShare: number
}

/** Ghostty, iTerm2, kitty, and most terminals: one report per scrolled line. */
export const LINE_WHEEL: WheelProfile = { baseRows: 1, frameShare: 1 }

/** Windows Terminal and the Windows console: one report per notch. The curve
 *  values are tuned for Windows Terminal; three rows are the
 *  lines of a Windows notch, which is also the rows Windows Terminal scrolls
 *  its own buffer for one WHEEL_DELTA. */
export const NOTCH_WHEEL: WheelProfile = {
  baseRows: 3,
  frameShare: 0.5,
  curve: {
    burstGapMs: 5,
    streakGapMs: 500,
    halfLifeMs: 150,
    boostRows: 7,
    slowGapMs: 80,
    slowCapRows: 3,
    fastCapRows: 36,
  },
}

/** The profile of the host terminal. A Windows console reports notches, and so
 *  does Windows Terminal around another system's shell (WSL), which it marks
 *  with WT_SESSION. */
export function wheelProfileFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): WheelProfile {
  return platform === "win32" || env.WT_SESSION !== undefined ? NOTCH_WHEEL : LINE_WHEEL
}

export type WheelDirection = 1 | -1

/** The rows each report moves, for one stream of reports. The result is the
 *  absolute row count, at least one.
 *
 *  A streak has a speed in rows per report. Each report of the streak adds
 *  `boostRows` to the part of the speed above one row, and that part then
 *  fades by half for each `halfLifeMs` since the previous report. The rows
 *  that a whole count cannot move carry to the next report of the streak. */
export function createWheelRows(profile: WheelProfile): (direction: WheelDirection, now: number) => number {
  const { curve, baseRows } = profile
  if (curve === undefined) return () => baseRows
  let previous: { readonly direction: WheelDirection; readonly at: number } | undefined
  let speed = baseRows
  let carried = 0
  return (direction, now) => {
    const gap = previous === undefined ? Number.POSITIVE_INFINITY : now - previous.at
    const continues = previous?.direction === direction
    previous = { direction, at: now }
    if (continues && gap < curve.burstGapMs) return 1
    if (continues && gap <= curve.streakGapMs) {
      const fade = 2 ** (-gap / curve.halfLifeMs)
      const limit = gap < curve.slowGapMs ? curve.fastCapRows : curve.slowCapRows
      speed = Math.min(limit, 1 + (speed - 1 + curve.boostRows) * fade)
    } else {
      speed = baseRows
      carried = 0
    }
    const rows = Math.floor(speed + carried)
    carried += speed - rows
    return rows
  }
}

/** The signed rows that one frame applies from the waiting rows. */
export function frameWheelRows(profile: WheelProfile, waiting: number): number {
  if (waiting === 0) return 0
  const size = Math.abs(waiting)
  return Math.sign(waiting) * Math.min(size, Math.max(1, Math.ceil(size * profile.frameShare)))
}

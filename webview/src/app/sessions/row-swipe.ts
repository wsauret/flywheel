/** The arithmetic of a swipe that slides a session row aside to show the
 *  actions behind it, kept apart from the touch events that feed it so the
 *  decisions have tests. A row opens leftward, the way a mail row does: the
 *  finger drags the row's face across, the tray behind it comes into view by
 *  the same amount, and lifting either settles the tray fully open or lets the
 *  row spring back. Recognising the gesture, and telling it from a scroll,
 *  reuses the screen swipe's rule so the two never disagree about what a
 *  sideways move is. */

/** Travel past the tray's edge moves at this fraction, so the row resists
 *  rather than stops dead. */
const OVERSHOOT_FRACTION = 0.3

/** The speed at which a short flick settles the tray, in pixels per
 *  millisecond of leftward travel. */
const FLICK_PX_PER_MS = 0.3

/** How far the row's face sits aside, in pixels, for a finger that has moved
 *  `dx` from where it landed on a row already revealed by `rest` pixels. */
export function rowReveal(dx: number, rest: number, trayWidth: number): number {
  const wanted = rest - dx
  if (wanted <= 0) return 0
  if (wanted <= trayWidth) return wanted
  return trayWidth + (wanted - trayWidth) * OVERSHOOT_FRACTION
}

/** True when a horizontal move is the row's to take: leftward opens a row, and
 *  only an open row answers a rightward move, by closing. A rightward move on
 *  a closed row is left to whatever else wants it. */
export function rowSwipeOwns(dx: number, rest: number): boolean {
  return dx < 0 || rest > 0
}

/** Whether lifting the finger leaves the tray open. `velocity` is leftward
 *  travel per millisecond over the last movement, so a quick flick settles the
 *  tray either way and a slow drag settles by where it stopped. */
export function rowSettlesOpen(reveal: number, trayWidth: number, velocity: number): boolean {
  if (velocity >= FLICK_PX_PER_MS) return true
  if (velocity <= -FLICK_PX_PER_MS) return false
  return reveal >= trayWidth / 2
}

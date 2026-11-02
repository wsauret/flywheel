/** The arithmetic of a sideways swipe between screens, kept apart from the
 *  touch events that feed it so the decisions have tests. A swipe may begin
 *  anywhere. It is recognised once it moves clearly across rather than along,
 *  which is what keeps a scroll a scroll, and it commits when it has travelled
 *  far enough or fast enough. Content under the finger that can still scroll
 *  the same way keeps the touch, so a wide code block pans before the screen
 *  moves. */

/** Sideways travel before the swipe is the gesture's owner. Under this, a
 *  finger that is still deciding gets neither a moving screen nor a blocked
 *  scroll. */
const RECOGNIZE_PX = 10

/** How much more across than along a swipe must move to be one. A swipe can
 *  start over a scrolling transcript, so a diagonal drag stays a scroll. */
const ACROSS_RATIO = 2

/** The fraction of the width past which lifting commits, and the speed at
 *  which a shorter flick does. */
const COMMIT_FRACTION = 1 / 3
const FLICK_PX_PER_MS = 0.45

/** Back drags the chat rightward off the list; forward pulls it leftward in. */
export type SwipeDirection = "back" | "forward"

/** Travel the way the gesture goes: positive when the finger moves with it. */
function travelAlong(direction: SwipeDirection, dx: number): number {
  return direction === "back" ? dx : -dx
}

/** The direction a horizontal move names, before anything is decided. */
export function swipeDirectionOf(dx: number): SwipeDirection {
  return dx > 0 ? "back" : "forward"
}

/** True once the finger has moved far enough sideways, and clearly more
 *  across than along, for the swipe to take the touch from the scroller. */
export function swipeRecognized(dx: number, dy: number): boolean {
  return Math.abs(dx) >= RECOGNIZE_PX && Math.abs(dx) > Math.abs(dy) * ACROSS_RATIO
}

/** True when the touch has shown itself to be a scroll before the swipe was
 *  recognised. */
export function swipeAbandoned(dx: number, dy: number): boolean {
  return Math.abs(dy) >= RECOGNIZE_PX && Math.abs(dy) >= Math.abs(dx)
}

/** The horizontal scroll state of the element under the finger. */
export interface ScrollerState {
  readonly scrollLeft: number
  readonly clientWidth: number
  readonly scrollWidth: number
}

/** True when the content under the finger can still pan the way the swipe
 *  goes, so the swipe yields to it. A back swipe drags content rightward,
 *  which is what a scroller with room on its left does; forward, the reverse. */
export function scrollerKeepsTouch(scroller: ScrollerState | undefined, direction: SwipeDirection): boolean {
  if (scroller === undefined) return false
  if (direction === "back") return scroller.scrollLeft > 0
  return scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1
}

/** How far through the swipe the finger is, as a fraction of the width. */
export function swipeProgress(direction: SwipeDirection, dx: number, width: number): number {
  if (width <= 0) return 0
  return Math.min(1, Math.max(0, travelAlong(direction, dx) / width))
}

/** Whether lifting the finger finishes the swipe. `velocity` is travel along
 *  the swipe per millisecond over the last movement, so a short quick flick
 *  commits and a long slow drag that stopped short does not. */
export function swipeCommits(progress: number, velocity: number): boolean {
  if (velocity <= -FLICK_PX_PER_MS) return false
  return progress >= COMMIT_FRACTION || velocity >= FLICK_PX_PER_MS
}

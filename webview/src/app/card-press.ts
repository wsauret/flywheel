export const CARD_HOLD_MS = 500

/** A header hold yields to a scroll gesture once it moves more than 10px. */
export function cardPressMoved(start: { readonly x: number; readonly y: number }, point: { readonly x: number; readonly y: number }): boolean {
  return Math.hypot(point.x - start.x, point.y - start.y) > 10
}

/** The rail's two layout choices a person makes with the pointer or the
 *  keyboard, and where they are kept. They are conveniences of one browser,
 *  never runtime state: a fresh browser gets the defaults, and a browser that
 *  denies storage still resizes for the life of the page. */

const WIDTH_KEY = "flywheel.rail.width"
const COLLAPSED_KEY = "flywheel.rail.collapsed"

/** Narrow enough to keep the transcript usable beside it, wide enough that a
 *  long title still reads: the same span a sidebar gets in an editor. */
export const RAIL_WIDTH_MIN_PX = 192
export const RAIL_WIDTH_MAX_PX = 448

export interface RailLayout {
  /** A width the person chose, in pixels; absent when the stylesheet's own
   *  rung applies. */
  readonly width: number | undefined
  readonly collapsed: boolean
}

interface LayoutStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function clampRailWidth(px: number): number {
  return Math.min(RAIL_WIDTH_MAX_PX, Math.max(RAIL_WIDTH_MIN_PX, Math.round(px)))
}

export function readRailLayout(storage: LayoutStorage): RailLayout {
  try {
    const stored = Number(storage.getItem(WIDTH_KEY))
    return {
      width: Number.isFinite(stored) && stored > 0 ? clampRailWidth(stored) : undefined,
      collapsed: storage.getItem(COLLAPSED_KEY) === "1",
    }
  } catch {
    return { width: undefined, collapsed: false }
  }
}

export function writeRailLayout(storage: LayoutStorage, layout: RailLayout): void {
  try {
    if (layout.width === undefined) storage.removeItem(WIDTH_KEY)
    else storage.setItem(WIDTH_KEY, String(layout.width))
    if (layout.collapsed) storage.setItem(COLLAPSED_KEY, "1")
    else storage.removeItem(COLLAPSED_KEY)
  } catch {
    // Storage denied: the choice lasts for this page and no longer.
  }
}

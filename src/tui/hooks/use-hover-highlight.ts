import type { MouseEvent, RGBA } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { createSignal } from "solid-js"

/** The pointer handlers of a hover affordance, spread onto the row's box. */
export interface HoverHandlers {
  onMouseOver: (event: MouseEvent) => void
  onMouseMove: (event: MouseEvent) => void
  onMouseOut: (event: MouseEvent) => void
}

export interface HoverHighlightHook {
  handlers: HoverHandlers
  hovered: () => boolean
  background: () => RGBA | undefined
}

/** Shared hover affordance for clickable rows: spread `handlers` onto the row's
 *  box and feed `background()` to its backgroundColor, or read `hovered()` to
 *  drive a quieter cue (rail recolor, chevron emphasis). The optional
 *  `clickable` accessor suppresses the affordance when the row currently does
 *  nothing. The optional `hits` predicate limits the affordance to the points
 *  it accepts: a toggle passes the same predicate that decides its clicks, the
 *  drawn content of a line or header and every cell of a shown body
 *  (PI-INTERACTION-080). The pointer can leave drawn content without leaving the
 *  renderable it is over, so every move decides again. */
export function useHoverHighlight(clickable: () => boolean = () => true, hits: (event: MouseEvent) => boolean = () => true): HoverHighlightHook {
  const { theme } = useTheme()
  const [hovered, setHovered] = createSignal(false)
  const isHovered = () => clickable() && hovered()
  const track = (event: MouseEvent) => setHovered(hits(event))
  return {
    handlers: { onMouseOver: track, onMouseMove: track, onMouseOut: () => setHovered(false) },
    hovered: isHovered,
    background: () => isHovered() ? theme.backgroundElement : undefined,
  }
}

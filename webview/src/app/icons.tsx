import { brandTileSvg, FLYWHEEL_MARK_PATHS } from "../../../src/protocol/client/brand.js"
import { WORKFLOW_GLYPH } from "../../../src/protocol/client/glyphs.js"

/** The workflow glyph in its text form. iOS Safari draws U+2699 as a colour
 *  emoji unless the text presentation selector follows it. Only the browser
 *  adds the selector, because a terminal keeps it in its cells. */
export const WORKFLOW_TEXT_GLYPH = `${WORKFLOW_GLYPH}\uFE0E`

/** Stroked glyphs drawn in the client's own vocabulary, so every control shares
 *  one line weight and takes the theme's colour. Paths are Flywheel's own
 *  16-unit strokes sized to sit beside the editor's icons; no icon set's path
 *  data is copied. */

export function Icon(props: { readonly path: string; readonly size?: number }) {
  return (
    <svg
      class="icon"
      viewBox="0 0 16 16"
      width={props.size ?? 14}
      height={props.size ?? 14}
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={props.path} />
    </svg>
  )
}

export const ICONS = {
  plus: "M8 3.5v9M3.5 8h9",
  close: "M5 5l6 6M11 5l-6 6",
  /** Stop: ends a child's run for its parent, never to resume. An outlined
   *  square, apart from Close's cross and Interrupt's filled square. */
  stop: "M4 4h8v8H4z",
  chevronDown: "M4 6.5L8 10.5L12 6.5",
  chevronUp: "M4 9.5L8 5.5L12 9.5",
  chevronLeft: "M10 4L6 8l4 4",
  trash: "M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8",
  bell: "M8 2.5a3.5 3.5 0 0 0-3.5 3.5v2.2L3.2 10.5h9.6L11.5 8.2V6A3.5 3.5 0 0 0 8 2.5zM6.6 12.5a1.4 1.4 0 0 0 2.8 0",
  search: "M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.3 10.3L13.5 13.5",
  copy: "M5.5 5.5h7v7h-7zM3.5 10.5h-1v-7h7v1",
  list: "M3 4.5h10M3 8h10M3 11.5h10",
  terminal: "M3 4l4 4-4 4M9 12h4",
  check: "M3.5 8.5l2.8 2.8L12.5 5",
  arrowUpRight: "M5 11l6-6M6 5h5v5",
  arrowUp: "M8 12.5v-9M4.5 7L8 3.5 11.5 7",
  arrowDown: "M8 3.5v9M4.5 9L8 12.5 11.5 9",
  pencil: "M11 3l2 2-7 7H4v-2l7-7z",
  sidebar: "M2.5 3.5h11v9h-11zM6 3.5v9",
  file: "M4 1.5h5l3.5 3.5v9.5H4zM9 1.5V5h3.5",
  branch: "M4 5v6M4 6c0 3 8 0 8-3M4 2a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3M4 11a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3M12 1a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3",
} as const

/** The Flywheel mark as a hairline glyph in the current colour. The geometry
 *  is the brand module's, so it cannot drift from the editor's or the tile's. */
export function Mark(props: { readonly class?: string }) {
  return <svg class={props.class ?? "mark"} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true" innerHTML={FLYWHEEL_MARK_PATHS} />
}

/** The brand tile: the same drawing as the phone's Home Screen icon, inline,
 *  so the app opens on the icon that was just tapped. `markClass` names the
 *  group a stylesheet may set turning. */
export function BrandTile(props: { readonly size: number; readonly class?: string; readonly markClass?: string }) {
  return <div class={props.class ?? "brand-tile"} aria-hidden="true" innerHTML={brandTileSvg(props.size, { corners: "rounded", markClass: props.markClass })} />
}

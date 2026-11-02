/** @jsxImportSource @opentui/solid */

import { Spinner } from "@tui/components/spinner.js"
import { useTheme } from "@tui/context/theme"
import type { Accessor, JSX } from "solid-js"
import type { TextRenderable } from "@opentui/core"
import { allowSelectionStartWithoutContent } from "@tui/utils/selection.js"

/** The dot every rendering block is prefaced with - the same glyph tool calls use. */
const BLOCK_DOT = "\u2022"

/** Marker gutter width: the dot glyph (1 col) plus one column of spacing. Every
 * block aligns its content to this single value, so the indent is defined once.
 * Exported so blocks that wrap their own content can derive their available
 * columns from the shared row width (see context/row-width.ts). */
export const BLOCK_GUTTER_WIDTH = 2

interface BlockFrameProps {
  children: JSX.Element
  /** Opt-in reactive gutter: when this accessor is true the dot is replaced by
   * an animated spinner, resolving back to the static dot when it flips false.
   * Undefined keeps the gutter static - the default for every non-agent block. */
  active?: Accessor<boolean>
}

/**
 * Prefaces a rendering block with a static dot and indents its content to a
 * single shared gutter. This is the one mechanism for the dot and the indent --
 * the dot is never reactive and never varies by block. The gutter is one text
 * that spans the block's full height, so every gutter cell is a selection START
 * zone but never selection CONTENT (allowSelectionStartWithoutContent): a drag
 * that begins there can highlight into the adjacent block (including
 * collapsible bodies) without the release being mistaken for a toggle click,
 * while copying a block line still yields the content as one contiguous region
 * instead of fragmenting on the row split (see AGENTS 8b).
 *
 * The gutter text is a direct child of the row because OpenTUI notifies only
 * the descendants of the start renderable's parent until the drag leaves that
 * parent, so a wrapper box around the dot hid the content from a drag that
 * stayed in the gutter. The row lays out in reverse with the content first, so
 * walks that take the first child covering a row, such as the scroll anchor's
 * text-position capture, meet the content before the full-height gutter.
 *
 * The gutter is always a visible child. OpenTUI 0.6.8 lays out a row that holds
 * a flexGrow child next to a hidden sibling at about the viewport height inside
 * scroll content, so a tall block would clip and scroll its own text.
 */
export function BlockFrame(props: BlockFrameProps) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row-reverse">
      <box flexGrow={1} flexDirection="column">
        {props.children}
      </box>
      {props.active?.() ? (
        <Spinner color={theme.textSubtle} isActive={props.active} width={BLOCK_GUTTER_WIDTH} />
      ) : (
        <text width={BLOCK_GUTTER_WIDTH} flexShrink={0} fg={theme.textSubtle} overflow="hidden" wrapMode="none" ref={(el: TextRenderable) => { allowSelectionStartWithoutContent(el) }}>{BLOCK_DOT}</text>
      )}
    </box>
  )
}

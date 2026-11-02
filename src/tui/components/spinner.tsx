/** @jsxImportSource @opentui/solid */

import type { RGBA, TextRenderable } from "@opentui/core"
import type { Accessor } from "solid-js"
import { useSpinnerFrame } from "../hooks/use-spinner-frame.js"
import { allowSelectionStartWithoutContent } from "@tui/utils/selection.js"

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
export const SPINNER_INTERVAL = 80

interface SpinnerProps {
  color?: RGBA
  isActive?: Accessor<boolean>
  /** A fixed width that never shrinks, for a spinner that fills a gutter. */
  width?: number
}

export function Spinner(props: SpinnerProps) {
  // eslint-disable-next-line solid/reactivity -- isActive is passed as an Accessor to useSpinnerFrame, not read here
  const frame = useSpinnerFrame(props.isActive ?? (() => true))
  // Decoration, never content: a spinner frame must not land in copied text,
  // but a drag starting on it should still begin a selection (it can sit over
  // dead space like the block gutter). The ref helper owns `selectable`; a JSX
  // selectable prop would be applied after the ref and clobber it.
  return <text width={props.width} flexShrink={props.width === undefined ? undefined : 0} fg={props.color} ref={(el: TextRenderable) => { allowSelectionStartWithoutContent(el) }}>{frame()}</text>
}

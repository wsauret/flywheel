/** @jsxImportSource @opentui/solid */
/**
 * CollapsibleBox
 *
 * Conditionally renders a bordered container for expand/collapse toggling.
 * When collapsed, the box is completely removed from the tree.
 * When expanded, a bordered box wraps the children.
 */

import { Show } from "solid-js"
import type { JSX } from "solid-js"
import type { RGBA } from "@opentui/core"

export interface CollapsibleBoxProps {
  expanded: boolean
  children: JSX.Element
  /** Box props passed through to the container. */
  border?: boolean | ("top" | "bottom" | "left" | "right")[]
  borderColor?: RGBA
  paddingLeft?: number
  paddingRight?: number
  paddingTop?: number
  paddingBottom?: number
  onMouseDown?: () => void
}

export function CollapsibleBox(props: CollapsibleBoxProps) {
  return (
    <Show when={props.expanded}>
      <box
        flexDirection="column"
        border={props.border ?? false}
        borderColor={props.borderColor}
        paddingLeft={props.paddingLeft}
        paddingRight={props.paddingRight}
        paddingTop={props.paddingTop}
        paddingBottom={props.paddingBottom}
        onMouseDown={props.onMouseDown}
      >
        {props.children}
      </box>
    </Show>
  )
}

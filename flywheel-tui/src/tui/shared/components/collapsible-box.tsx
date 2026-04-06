/** @jsxImportSource @opentui/solid */
/**
 * CollapsibleBox
 *
 * Stable-layout container for expand/collapse toggling.
 *
 * The container box stays in the layout tree at all times to avoid
 * white-flash flicker from layout shift on remount. When collapsed,
 * children are swapped out via <For each={[1] | []}> and the box is
 * hidden with height={0} and no border/padding.
 */

import { For } from "solid-js"
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
    <box
      flexDirection="column"
      border={props.expanded ? (props.border ?? false) : false}
      borderColor={props.borderColor}
      paddingLeft={props.expanded ? props.paddingLeft : 0}
      paddingRight={props.expanded ? props.paddingRight : 0}
      paddingTop={props.expanded ? props.paddingTop : 0}
      paddingBottom={props.expanded ? props.paddingBottom : 0}
      height={props.expanded ? undefined : 0}
      onMouseDown={props.expanded ? props.onMouseDown : undefined}
    >
      <For each={props.expanded ? [true] : []}>
        {() => <>{props.children}</>}
      </For>
    </box>
  )
}

/** @jsxImportSource @opentui/solid */

import type { BorderCharacters, Renderable, RGBA } from "@opentui/core"
import type { ClickToggleHandlers } from "@tui/hooks/use-body-toggle.js"
import type { JSX } from "solid-js"
import { Show } from "solid-js"
interface CollapsibleBoxProps {
  expanded: boolean
  children: JSX.Element
  border?: boolean | ("top" | "bottom" | "left" | "right")[]
  borderColor?: RGBA
  customBorderChars?: BorderCharacters
  backgroundColor?: RGBA
  paddingLeft?: number
  paddingRight?: number
  paddingTop?: number
  paddingBottom?: number
  handlers?: ClickToggleHandlers
  ref?: (box: Renderable) => void
}

export function CollapsibleBox(props: CollapsibleBoxProps) {
  return (
    <Show when={props.expanded}>
      <box
        ref={props.ref}
        flexDirection="column"
        border={props.border ?? false}
        borderColor={props.borderColor}
        customBorderChars={props.customBorderChars}
        backgroundColor={props.backgroundColor}
        {...props.handlers}
        paddingLeft={props.paddingLeft}
        paddingRight={props.paddingRight}
        paddingTop={props.paddingTop}
        paddingBottom={props.paddingBottom}
      >
        {props.children}
      </box>
    </Show>
  )
}

/** @jsxImportSource @opentui/solid */

import type { BoxRenderable, RGBA } from "@opentui/core"
import type { JSX } from "solid-js"
import { createSignal } from "solid-js"

/** Subtle clickable chrome for labels embedded in existing TUI framing. */
export function ChromeControl(props: {
  children?: JSX.Element
  onPress: () => void
  hoverColor: RGBA
  enabled?: boolean
  ref?: (element: BoxRenderable) => void
  position?: "absolute" | "relative"
  top?: number
  bottom?: number
  left?: number
  width?: number
}) {
  const [hovered, setHovered] = createSignal(false)
  const enabled = () => props.enabled ?? true
  return (
    <box ref={props.ref} position={props.position} top={props.top} bottom={props.bottom} left={props.left}
      width={props.width} height={1} selectable={false} paddingLeft={1} paddingRight={1}
      backgroundColor={hovered() && enabled() ? props.hoverColor : undefined}
      onMouseOver={() => setHovered(true)} onMouseOut={() => setHovered(false)}
      onMouseDown={(event) => { event.stopPropagation(); if (enabled()) props.onPress() }}>
      {props.children}
    </box>
  )
}

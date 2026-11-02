/** @jsxImportSource @opentui/solid */

import type { ColorInput } from "@opentui/core"
import { For, Show } from "solid-js"
import type { TextEditorPresentation } from "../keymap/text-entry.js"
import { displayWidth, graphemes } from "../utils/text.js"

const CURSOR = { inverse: true } as const

export interface ControlledTextFieldProps {
  presentation: TextEditorPresentation
  focused: boolean
  placeholder?: string
  width: number
  textColor?: ColorInput
  placeholderColor?: ColorInput
  selectionForeground?: ColorInput
  selectionBackground?: ColorInput
}

/** Renders caller-owned single-line text. The component has no editable state and
 * never reconciles a native input buffer with its owner. */
export function ControlledTextField(props: ControlledTextFieldProps) {
  const value = () => props.presentation.value.replace(/[\r\n]/g, "")
  const viewport = () => visibleSlice(value(), props.presentation.cursor, Math.max(1, props.width))

  return (
    <box width={props.width} height={1} overflow="hidden">
      <Show when={value().length > 0} fallback={<text fg={props.placeholderColor}>{props.focused ? <span style={CURSOR}> </span> : null}{props.placeholder ?? ""}</text>}>
        <text fg={props.textColor} wrapMode="none">
          <For each={viewport()}>{(item) => {
            const selected = props.presentation.selection !== null && item.start >= props.presentation.selection.start && item.end <= props.presentation.selection.end
            const cursor = props.focused && item.start === props.presentation.cursor
            const style = selected ? { fg: props.selectionForeground, bg: props.selectionBackground } : cursor ? CURSOR : {}
            return <span style={style}>{item.segment}</span>
          }}</For>
          <Show when={props.focused && props.presentation.cursor === value().length}><span style={CURSOR}> </span></Show>
        </text>
      </Show>
    </box>
  )
}

function visibleSlice(value: string, cursor: number, width: number) {
  const items = graphemes(value).map((item) => ({ segment: item.segment, start: item.index, end: item.index + item.segment.length, width: displayWidth(item.segment) }))
  let cursorIndex = items.findIndex((item) => item.start === cursor)
  if (cursorIndex < 0) cursorIndex = items.length
  let start = cursorIndex
  let used = cursorIndex === items.length ? 1 : items[cursorIndex]?.width ?? 1
  while (start > 0 && used + (items[start - 1]?.width ?? 0) <= width) { start--; used += items[start]?.width ?? 0 }
  let end = cursorIndex === items.length ? items.length : cursorIndex + 1
  while (end < items.length && used + (items[end]?.width ?? 0) <= width) { used += items[end]?.width ?? 0; end++ }
  return items.slice(start, end)
}

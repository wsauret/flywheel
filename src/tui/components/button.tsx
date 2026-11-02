/** @jsxImportSource @opentui/solid */

import { Show } from "solid-js"
import { useTheme } from "../context/theme.js"
import { useHoverHighlight } from "../hooks/use-hover-highlight.js"
import { BOLD } from "../utils/text-attributes.js"

/** A padded action with shared default, hover, and keyboard-focus styling.
 *  Callers own keyboard routing; the hotkey is a label, not a key binding. */
export function Button(props: {
  label: string
  hotkey?: string
  onPress: () => void
  muted?: boolean
  disabled?: boolean
  focused?: boolean
}) {
  const { theme } = useTheme()
  const hover = useHoverHighlight()
  const highlighted = () => !props.disabled && (props.focused || hover.hovered())
  const foreground = () => highlighted() ? theme.background : props.muted || props.disabled ? theme.textMuted : theme.primary
  return <box flexDirection="row" alignSelf="flex-start" gap={1} paddingLeft={1} paddingRight={1} selectable={false}
    backgroundColor={highlighted() ? theme.primary : theme.backgroundElement}
    {...hover.handlers} onMouseDown={() => { if (!props.disabled) props.onPress() }}>
    <text selectable={false} fg={foreground()} attributes={props.muted || props.disabled ? undefined : BOLD}>{props.focused && !props.disabled ? `> ${props.label}` : props.label}</text>
    <Show when={props.hotkey}>{(hotkey) => <text selectable={false} fg={highlighted() ? theme.background : theme.textMuted}>{hotkey()}</text>}</Show>
  </box>
}

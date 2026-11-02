/** @jsxImportSource @opentui/solid */

import { Show, type JSX } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { Button } from "@tui/components/button"
import { OpaqueBox } from "@tui/components/opaque-box"
import { BOLD } from "@tui/utils/text-attributes"
import { displayWidth } from "@tui/utils/text"

const MODAL_SIDE_PADDING = 2
const MODAL_FRAME_CHROME_ROWS = 5
const TERMINAL_VERTICAL_MARGIN_ROWS = 2
export const MODAL_FRAME_HORIZONTAL_INSET = 2 * (1 + MODAL_SIDE_PADDING)
/** The columns between the title row's content and the close affordance,
 *  the same for every caller, so the close affordance never touches a
 *  title, a control, or a caller's own text. */
const CLOSE_GAP = 2
/** The columns that the close affordance takes on the title row, with its
 *  gap. A caller that fits its own title content to the row leaves them. */
export const MODAL_FRAME_CLOSE_WIDTH = CLOSE_GAP + 1

/** Every session viewer shares this size so layout does not move between them. */
export function sessionViewerBodyHeight(terminalHeight: number): number {
  return Math.max(1, terminalHeight - MODAL_FRAME_CHROME_ROWS - TERMINAL_VERTICAL_MARGIN_ROWS)
}

export function sessionViewerWidth(terminalWidth: number): number {
  return Math.max(34, terminalWidth - 2)
}

/** The columns that the back control of `label` takes on the title row: the
 *  button with its padding, and the column after it. */
export function modalFrameBackWidth(label: string): number {
  return displayWidth(backText(label)) + 3
}

function backText(label: string): string {
  return `‹ ${label}`
}

/** Shared modal chrome with an optional close affordance. Every modal renders
 * inside this frame so chrome changes are a one-file edit. */
export function ModalFrame(props: {
  title: string
  width: number
  /** Optional bounded layout for bodies with a flexible viewport. */
  height?: number
  onClose: () => void
  /** Receives bubbled clicks so an editor can finish when the person leaves its field. */
  onMouseDown?: () => void
  closeDisabled?: boolean
  /** Shown on the title row, right-aligned before the close affordance. It
   *  keeps its own width, and the title gives up columns to it, so the
   *  accessory sizes its content to the row. */
  titleAccessory?: JSX.Element
  /** Border + title color override (e.g. model modal scope accent). */
  accentColor?: string
  /** Row gap between frame children; modals with self-spacing bodies use 1. */
  gap?: number
  /** The way back, drawn as a `‹ label` button before the title. It keeps
   *  its label whole, so a caller fits the label to the row with
   *  {@link modalFrameBackWidth}. */
  back?: { label: string; onPress: () => void }
  /** Drawn in place of the title's text, such as styled chits. It gives up
   *  columns before the accessory does. */
  titleContent?: JSX.Element
  children: JSX.Element
}) {
  const { theme } = useTheme()
  const accent = () => props.accentColor ?? theme.primary
  return (
    <OpaqueBox flexDirection="column" borderColor={accent()} border={["top", "bottom", "left", "right"]} borderStyle="rounded" paddingLeft={MODAL_SIDE_PADDING} paddingRight={MODAL_SIDE_PADDING} paddingTop={1} paddingBottom={1} width={props.width} height={props.height} gap={props.gap} onMouseDown={props.onMouseDown}>
      <box flexDirection="row" flexShrink={props.height === undefined ? undefined : 0} justifyContent="space-between">
        <Show when={props.back}>{(back) => <box flexShrink={0} paddingRight={1}><Button label={backText(back().label)} muted onPress={() => back().onPress()} /></box>}</Show>
        <Show when={props.titleContent} fallback={<text fg={accent()} attributes={BOLD} flexShrink={1} minWidth={0} overflow="hidden" wrapMode="none">{props.title}</text>}>
          <box flexShrink={1} minWidth={0} overflow="hidden">{props.titleContent}</box>
        </Show>
        <Show when={props.titleAccessory}><box flexDirection="row" flexGrow={1} flexShrink={0} justifyContent="flex-end" gap={1} paddingLeft={1}>{props.titleAccessory}</box></Show>
        <box selectable={false} flexShrink={0} paddingLeft={CLOSE_GAP} onMouseDown={() => { if (!props.closeDisabled) props.onClose() }}><text selectable={false} fg={theme.textMuted}>x</text></box>
      </box>
      {props.children}
    </OpaqueBox>
  )
}

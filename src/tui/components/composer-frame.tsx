/** @jsxImportSource @opentui/solid */

import { StyledText, fg as stFg, type TextareaRenderable, type TextChunk, type TextRenderable } from "@opentui/core"
import type { Accessor, JSX } from "solid-js"
import { createEffect, createMemo, Show } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import { useTheme } from "@tui/context/theme"
import type { TuiTheme } from "@tui/context/theme/resolve"
import { bottomBorderContent, dividerContent, topBorderContent } from "@tui/utils/border-content.js"
import { chunksLength } from "@tui/utils/text-attributes.js"
import { ChromeControl } from "./chrome-control.js"
import type { ModuleRowAction } from "../../protocol/protocol-module.js"
import type { ComposerBorderControl, ComposerControlAction, ComposerControlLabel } from "./composer-border-labels.js"
import { NATIVE_TEXT_ENTRY_KEY_BINDINGS } from "../keymap/text-entry.js"

const PROMPT_FRAME_SIDE_PADDING = 1
const PROMPT_FRAME_SIDE_BORDER = 1

const PROMPT_FRAME_HORIZONTAL_INSET = 2 * (PROMPT_FRAME_SIDE_BORDER + PROMPT_FRAME_SIDE_PADDING)
export const PROMPT_LEFT_INSET = 3

/** Ordinary prompt geometry, including the empty prompt's breathing room. */
export function composerBodyGeometry(width: number, lines: number) {
  const height = Math.max(3, lines)
  return { width: Math.max(0, width - PROMPT_FRAME_HORIZONTAL_INSET), height, top: lines === 1 ? 1 : 0 }
}

/** The normal multiline editor body. Callers own input and focus, never styling. */
export function ComposerBody(props: {
  theme: TuiTheme
  width: number
  lines: number
  text: string
  placeholder: string
  attach: (prompt: TextareaRenderable) => void
  onSubmit: () => void
  children?: JSX.Element
}) {
  const themeContext = useTheme()
  const geometry = () => composerBodyGeometry(props.width, props.lines)
  return <box position="relative" width={geometry().width} height={geometry().height} overflow="hidden">
    <text fg={props.theme.textMuted} position="absolute" top={geometry().top} left={PROMPT_LEFT_INSET - 2} selectable={false}>{">"}</text>
    <textarea ref={props.attach}
      position="absolute" top={geometry().top} left={PROMPT_LEFT_INSET}
      width={Math.max(0, geometry().width - PROMPT_LEFT_INSET)} height={Math.max(1, geometry().height - geometry().top)} wrapMode="word"
      cursorColor={themeContext.cursorColor}
      selectionBg={props.theme.selectionBackground} selectionFg={props.theme.selectionForeground}
      textColor={props.theme.text} focusedTextColor={props.theme.text}
      backgroundColor="transparent" focusedBackgroundColor="transparent"
      selectable={props.text.length > 0}
      placeholder={props.text ? null : new StyledText([stFg(props.theme.textMuted)(`  ${props.placeholder}`)])}
      onSubmit={() => props.onSubmit()}
      keyBindings={NATIVE_TEXT_ENTRY_KEY_BINDINGS}
    />
    {props.children}
  </box>
}

interface ComposerFrameProps {
  theme: TuiTheme
  width: number
  bodyHeight: number
  topRightChunks: Accessor<readonly TextChunk[]>
  bottomLeftChunks: Accessor<readonly TextChunk[]>
  bottomRightChunks: Accessor<readonly TextChunk[]>
  controls: Accessor<readonly ComposerBorderControl[]>
  actions: { readonly [Action in ComposerControlAction]?: () => void }
  onModuleAction?: (action: ModuleRowAction) => void
  onMouseDown?: () => void
  /** Popup section rendered between the top border and the input body,
   *  separated from the body by a divider rule. 0 hides the section. */
  popupHeight?: number
  popup?: JSX.Element
  children: JSX.Element
}

export function ComposerFrame(props: ComposerFrameProps): JSX.Element {
  const popupHeight = () => props.popupHeight ?? 0
  const topBorder = createMemo(() => topBorderContent(props.theme, props.width, props.topRightChunks()))
  const divider = createMemo(() => dividerContent(props.theme, props.width))
  const bottomBorder = createMemo(() => bottomBorderContent(props.theme, props.width, props.bottomLeftChunks(), props.bottomRightChunks()))
  const labelWidth = (label: ComposerControlLabel) => {
    const chunks = label === "topRight" ? props.topRightChunks() : label === "bottomLeft" ? props.bottomLeftChunks() : props.bottomRightChunks()
    return chunksLength(chunks)
  }
  const labelLeft = (label: ComposerControlLabel) => label === "bottomLeft" ? 2 : props.width - labelWidth(label) - 2

  return (
    <box
      position="relative"
      flexDirection="column"
      width={props.width}
      height={props.bodyHeight + 2 + (popupHeight() > 0 ? popupHeight() + 1 : 0)}
      selectable={false}
      onMouseDown={() => props.onMouseDown?.()}
    >
      <text
        ref={(el: TextRenderable) => { createEffect(() => { el.content = topBorder() }) }}
        width={props.width}
        height={1}
        overflow="hidden"
        wrapMode="none"
      />
      <Show when={popupHeight() > 0}>
        <box
          width={props.width}
          height={popupHeight()}
          border={["left", "right"]}
          borderColor={props.theme.border}
          paddingLeft={PROMPT_FRAME_SIDE_PADDING}
          paddingRight={PROMPT_FRAME_SIDE_PADDING}
        >
          {props.popup}
        </box>
        <text
          ref={(el: TextRenderable) => { createEffect(() => { el.content = divider() }) }}
          width={props.width}
          height={1}
          overflow="hidden"
          wrapMode="none"
        />
      </Show>
      <box
        width={props.width}
        height={props.bodyHeight}
        border={["left", "right"]}
        borderColor={props.theme.border}
        paddingLeft={PROMPT_FRAME_SIDE_PADDING}
        paddingRight={PROMPT_FRAME_SIDE_PADDING}
      >
        {props.children}
      </box>
      <text
        ref={(el: TextRenderable) => { createEffect(() => { el.content = bottomBorder() }) }}
        width={props.width}
        height={1}
        overflow="hidden"
        wrapMode="none"
      />
      {/* Keyed by what each control does, so a control keeps its element, and
          its hover, while the status line rebuilds the controls on every
          spinner frame. */}
      <Key each={props.controls()} by={(control) => `${control.label}:${typeof control.action === "string" ? control.action : `${control.action.kind}:${control.action.id}`}`}>
        {(control) => (
          <ChromeControl
            position="absolute"
            top={control().label === "topRight" ? 0 : undefined}
            bottom={control().label === "topRight" ? undefined : 0}
            left={labelLeft(control().label) + control().offset - 1}
            width={chunksLength(control().chunks) + 2}
            hoverColor={props.theme.backgroundRaised}
            onPress={() => { const action = control().action; if (typeof action === "string") props.actions[action]?.(); else props.onModuleAction?.(action) }}
          >
            <text
              ref={(el: TextRenderable) => { createEffect(() => { el.content = new StyledText([...control().chunks]) }) }}
              selectable={false}
              wrapMode="none"
            />
          </ChromeControl>
        )}
      </Key>
    </box>
  )
}

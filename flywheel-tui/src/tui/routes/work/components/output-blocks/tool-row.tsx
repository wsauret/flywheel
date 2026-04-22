/** @jsxImportSource @opentui/solid */

import { createMemo, createEffect } from "solid-js"
import { StyledText, fg as stFg, type TextChunk } from "@opentui/core"
import type { TextRenderable } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { useSpinnerFrame } from "@tui/shared/hooks/use-spinner-frame.js"
import type { ToolEntry } from "@infra/output-blocks"
import { getToolDisplayName } from "@infra/tool-display-registry.js"

export const BOX_MAX_VISIBLE_TOOLS = 4
export const SUCCESS_ICON = "✓"
export const ERROR_ICON = "✗"

export function moreHint(hiddenCount: number, expanded: boolean): string {
  return expanded ? "▾ show less" : `▸ ${hiddenCount} more`
}

interface ToolRowProps {
  tool: ToolEntry
  interrupted?: boolean
}

const DIAMOND = "◆"

export function ToolRow(props: ToolRowProps) {
  const { theme } = useTheme()
  const hasError = () => !!props.tool.errorMessage
  const isCompleted = () => props.tool.completed === true
  const isInterrupted = () => props.interrupted === true && !isCompleted() && !hasError()
  const isThinking = () => props.tool.name === "Thinking"

  const spinnerFrame = useSpinnerFrame(() => !isCompleted() && !hasError() && !isInterrupted())

  const icon = createMemo(() => {
    if (isThinking()) {
      if (isCompleted()) return { text: DIAMOND, color: theme.accent }
      return { text: spinnerFrame(), color: theme.accent }
    }
    if (hasError()) return { text: ERROR_ICON, color: theme.error }
    if (isInterrupted()) return { text: ERROR_ICON, color: theme.warning }
    if (isCompleted()) return { text: SUCCESS_ICON, color: theme.primary }
    return { text: spinnerFrame(), color: theme.secondary }
  })

  const rowContent = createMemo(() => {
    const displayName = isThinking() ? "Thinking..." : getToolDisplayName(props.tool.name, props.tool)
    const chunks: TextChunk[] = [
      stFg(icon().color)(icon().text),
      stFg(theme.text)(" "),
      stFg(theme.text)(displayName),
    ]
    if (props.tool.detail) {
      chunks.push(stFg(theme.text)(" "))
      chunks.push(stFg(theme.textSubtle)(props.tool.detail))
    }
    if (hasError() && props.tool.errorMessage) {
      chunks.push(stFg(theme.text)(" "))
      chunks.push(stFg(theme.error)(props.tool.errorMessage))
    }
    return new StyledText(chunks)
  })

  return (
    <box paddingLeft={1}>
      <text
        ref={(el: TextRenderable) => {
          createEffect(() => { el.content = rowContent() })
        }}
        overflow="hidden"
        wrapMode="none"
      />
    </box>
  )
}

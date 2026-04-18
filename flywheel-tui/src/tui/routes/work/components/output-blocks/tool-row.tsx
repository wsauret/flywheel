/** @jsxImportSource @opentui/solid */

import { createMemo, Show } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import { useSpinnerFrame } from "@tui/shared/hooks/use-spinner-frame.js"
import type { ToolEntry } from "@infra/output-blocks"
import { getToolDisplayName } from "@infra/tool-display-registry.js"

/** Single source of truth for tool-row rendering inside any box (subagent or Tools group). */
export const BOX_MAX_VISIBLE_TOOLS = 4
export const SUCCESS_ICON = "✓"
export const ERROR_ICON = "✗"

export function moreHint(hiddenCount: number, expanded: boolean): string {
  return expanded ? "▾ show less" : `▸ ${hiddenCount} more`
}

interface ToolRowProps {
  tool: ToolEntry
}

/**
 * Tool row rendered inside a box (subagent children or Tools ad-hoc group) or
 * inline as a single-tool Tools group. Three visual states, driven by the
 * ToolEntry fields: unresolved (spinner), completed (✓), errored (✗ + message).
 * The spinner/✓/✗ glyphs are all 1 cell wide, so the row layout is stable
 * across the single state transition.
 */
export function ToolRow(props: ToolRowProps) {
  const { theme } = useTheme()
  const hasError = () => !!props.tool.errorMessage
  const isCompleted = () => props.tool.completed === true

  const spinnerFrame = useSpinnerFrame(() => !isCompleted() && !hasError())

  const icon = createMemo(() => {
    if (hasError()) return { text: ERROR_ICON, color: theme.error }
    if (isCompleted()) return { text: SUCCESS_ICON, color: theme.primary }
    return { text: spinnerFrame(), color: theme.secondary }
  })

  return (
    <box flexDirection="row" gap={1} paddingLeft={1} overflow="hidden">
      <text fg={icon().color} flexShrink={0}>{icon().text}</text>
      <text fg={theme.text} flexShrink={0}>{getToolDisplayName(props.tool.name)}</text>
      <text fg={theme.textSubtle} flexShrink={1} overflow="hidden" wrapMode="none">{props.tool.detail}</text>
      <Show when={hasError()}>
        <text fg={theme.error} flexShrink={0} overflow="hidden" wrapMode="none">{props.tool.errorMessage}</text>
      </Show>
    </box>
  )
}

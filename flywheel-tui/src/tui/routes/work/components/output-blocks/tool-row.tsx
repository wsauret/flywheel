/** @jsxImportSource @opentui/solid */

import { Show } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import { Spinner } from "@tui/shared/components/spinner"
import type { ToolEntry } from "@infra/output-blocks"
import { displayToolName } from "./tool-entry.js"

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

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1} paddingLeft={1} overflow="hidden">
        <Show
          when={hasError()}
          fallback={
            <Show
              when={isCompleted()}
              fallback={<Spinner color={theme.secondary} />}
            >
              <text fg={theme.primary} flexShrink={0}>{SUCCESS_ICON}</text>
            </Show>
          }
        >
          <text fg={theme.error} flexShrink={0}>{ERROR_ICON}</text>
        </Show>
        <text fg={theme.text} flexShrink={0}>{displayToolName(props.tool.name)}</text>
        <text fg={theme.textSubtle} flexShrink={1} overflow="hidden" wrapMode="none">{props.tool.detail}</text>
      </box>
      <Show when={hasError()}>
        <box paddingLeft={3} overflow="hidden">
          <text fg={theme.error} overflow="hidden" wrapMode="none">{props.tool.errorMessage}</text>
        </box>
      </Show>
    </box>
  )
}

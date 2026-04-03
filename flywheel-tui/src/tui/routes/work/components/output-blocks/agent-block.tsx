/** @jsxImportSource @opentui/solid */
/**
 * AgentBlock Component
 *
 * Renders a subagent block following OpenCode's display pattern:
 *
 * Running:
 *   ◐ Explore: Find settings page files
 *     ↳ Glob src/tui/routes/**
 *
 * Completed:
 *   ✓ Explore: Find settings page files
 *     └ 14 toolcalls · 2.3s
 *
 * Error:
 *   ✗ Explore: Find settings page files
 *     error message
 *
 * The ↳ line live-updates in place showing the latest tool the subagent is calling.
 * On completion it switches to a summary with count + duration.
 */

import { Show, For } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import { Spinner } from "@tui/shared/components/spinner"
import { truncate, MAX_BLOCK_LINE_LENGTH } from "@tui/utils/text"
import type { AgentBlock as AgentBlockType } from "@tui/types"

export interface AgentBlockProps {
  block: AgentBlockType
  expanded?: boolean
  onToggleExpand?: (id: string) => void
}

/**
 * Format milliseconds to human-readable duration.
 * Exported for testing.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`
}

export function AgentBlock(props: AgentBlockProps) {
  const themeCtx = useTheme()

  const label = () => `${props.block.agentLabel}: ${props.block.description}`
  const toolCount = () => props.block.toolCount ?? props.block.children.length
  const isExpanded = () => props.expanded ?? false
  const canToggle = () => props.block.status === "completed" || props.block.status === "paused"
  const expandIcon = () => isExpanded() ? "▾" : "▸"

  const handleClick = () => {
    if (canToggle() && props.onToggleExpand) {
      props.onToggleExpand(props.block.id)
    }
  }

  return (
    <box flexDirection="column" marginTop={1}>
      {/* Header line */}
      <Show when={props.block.status === "active"}>
        <box flexDirection="row">
          <Spinner color={themeCtx.theme.primary} />
          <text fg={themeCtx.theme.primary}>{` ${label()}`}</text>
        </box>
      </Show>

      <Show when={props.block.status === "completed"}>
        <box onMouseDown={handleClick}>
          <text fg={themeCtx.theme.secondary}>{`${expandIcon()} ${label()}`}</text>
        </box>
      </Show>

      <Show when={props.block.status === "paused"}>
        <box onMouseDown={handleClick}>
          <text fg={themeCtx.theme.textMuted}>{`${expandIcon()} ${label()}`}</text>
        </box>
      </Show>

      <Show when={props.block.status === "error"}>
        <text fg={themeCtx.theme.error}>{`✗ ${label()}`}</text>
      </Show>

      {/* Running: show latest tool being called */}
      <Show when={props.block.status === "active" && props.block.latestChild}>
        <text fg={themeCtx.theme.textMuted}>{`  ↳ ${truncate(props.block.latestChild!, MAX_BLOCK_LINE_LENGTH - 4)}`}</text>
      </Show>

      {/* Completed/Paused collapsed: show tool count + duration summary */}
      <Show when={(props.block.status === "completed" || props.block.status === "paused") && !isExpanded()}>
        <box onMouseDown={handleClick}>
          <text fg={themeCtx.theme.textMuted}>
            {`  └ ${toolCount()} toolcalls${props.block.duration != null ? ` · ${formatDuration(props.block.duration)}` : ""}`}
          </text>
        </box>
      </Show>

      {/* Completed/Paused expanded: show all children */}
      <Show when={(props.block.status === "completed" || props.block.status === "paused") && isExpanded()}>
        <For each={props.block.children}>
          {(child) => (
            <text fg={themeCtx.theme.textMuted}>{`  ▸ ${child.name}: ${truncate(child.detail, MAX_BLOCK_LINE_LENGTH - child.name.length - 6)}`}</text>
          )}
        </For>
        <box onMouseDown={handleClick}>
          <text fg={themeCtx.theme.textMuted}>
            {`  └ ${toolCount()} toolcalls${props.block.duration != null ? ` · ${formatDuration(props.block.duration)}` : ""}`}
          </text>
        </box>
      </Show>

      {/* Error: show error message */}
      <Show when={props.block.status === "error" && props.block.errorMessage}>
        <text fg={themeCtx.theme.error}>{`    ${props.block.errorMessage}`}</text>
      </Show>
    </box>
  )
}

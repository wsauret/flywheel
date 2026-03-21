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

import { Show } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import { Spinner } from "@tui/shared/components/spinner"
import { truncate, MAX_BLOCK_LINE_LENGTH } from "@tui/utils/text"
import type { AgentBlock as AgentBlockType } from "../../state/types"

export interface AgentBlockProps {
  block: AgentBlockType
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
        <text fg={themeCtx.theme.text}>{`✓ ${label()}`}</text>
      </Show>

      <Show when={props.block.status === "paused"}>
        <text fg={themeCtx.theme.textMuted}>{`⏸ ${label()}`}</text>
      </Show>

      <Show when={props.block.status === "error"}>
        <text fg={themeCtx.theme.error}>{`✗ ${label()}`}</text>
      </Show>

      {/* Running: show latest tool being called */}
      <Show when={props.block.status === "active" && props.block.latestChild}>
        <text fg={themeCtx.theme.textMuted}>{`  ↳ ${truncate(props.block.latestChild!, MAX_BLOCK_LINE_LENGTH - 4)}`}</text>
      </Show>

      {/* Completed/Paused: show tool count + duration */}
      <Show when={props.block.status === "completed" || props.block.status === "paused"}>
        <text fg={themeCtx.theme.textMuted}>
          {`  └ ${toolCount()} toolcalls${props.block.duration != null ? ` · ${formatDuration(props.block.duration)}` : ""}`}
        </text>
      </Show>

      {/* Error: show error message */}
      <Show when={props.block.status === "error" && props.block.errorMessage}>
        <text fg={themeCtx.theme.error}>{`    ${props.block.errorMessage}`}</text>
      </Show>
    </box>
  )
}

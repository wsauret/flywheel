/** @jsxImportSource @opentui/solid */
/**
 * AgentBlock Component
 *
 * Renders a subagent/tool-group block:
 *
 * Running:
 *   ┌─ Worker (3) ──────────────────────┐
 *   │  → Read  package.json             │
 *   │  ← Write  fib.ts                  │
 *   │  $ Bash  bun test                 │
 *   │  ↳ Running...                     │
 *   └──────────────────────────────────-┘
 *
 * Completed (collapsed):
 *   ▸ Worker · 3 tools · 14.3s
 *
 * Completed (expanded):
 *   ▾ Worker · 3 tools · 14.3s
 *   ┌──────────────────────────────────-┐
 *   │  → Read  package.json             │
 *   │  ← Write  fib.ts                  │
 *   │  $ Bash  bun test                 │
 *   └──────────────────────────────────-┘
 */

import { createSignal, Show, For } from "solid-js"
import { createTextAttributes } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { Spinner } from "@tui/shared/components/spinner"
import { truncate } from "@tui/utils/text"
import { displayToolName } from "./tool-block"
import type { AgentBlock as AgentBlockType, ToolBlock as ToolBlockType } from "@tui/types"

const MAX_VISIBLE_TOOLS = 6

export interface AgentBlockProps {
  block: AgentBlockType
  expanded?: boolean
  onToggleExpand?: (id: string) => void
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`
}

function ToolRow(props: { tool: ToolBlockType }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={1} paddingLeft={1}>
      <text fg={theme.text}>{displayToolName(props.tool.name)}</text>
      <text fg={theme.textMuted}>{truncate(props.tool.detail, 70)}</text>
    </box>
  )
}

export function AgentBlock(props: AgentBlockProps) {
  const { theme } = useTheme()
  const [showAll, setShowAll] = createSignal(false)

  const toolCount = () => props.block.toolCount ?? props.block.children.length
  const canToggle = () => props.block.status === "completed" || props.block.status === "paused"
  const summary = () => `${toolCount()} tools${props.block.duration != null ? ` · ${formatDuration(props.block.duration)}` : ""}`

  const visibleChildren = () => {
    const all = props.block.children
    if (showAll() || all.length <= MAX_VISIBLE_TOOLS) return all
    // Show first (MAX - 1) + always the latest one so active tool is visible
    const head = all.slice(0, MAX_VISIBLE_TOOLS - 1)
    const last = all[all.length - 1]
    return [...head, last]
  }
  const hiddenCount = () => {
    const all = props.block.children
    if (showAll() || all.length <= MAX_VISIBLE_TOOLS) return 0
    // head (MAX-1) + last (1) = MAX shown, rest hidden
    return all.length - MAX_VISIBLE_TOOLS
  }

  return (
    <box flexDirection="column" marginTop={1}>
      {/* ── Active: header above bordered tool list ── */}
      <Show when={props.block.status === "active"}>
        <box flexDirection="row" gap={1}>
          <Spinner color={theme.primary} />
          <text fg={theme.primary} attributes={createTextAttributes({ bold: true })}>{props.block.agentLabel}</text>
          <Show when={toolCount() > 0}>
            <text fg={theme.textMuted}>({toolCount()})</text>
          </Show>
        </box>
        <Show when={visibleChildren().length > 0}>
          <box
            flexDirection="column"
            border={true}
            borderColor={theme.borderSubtle}
            paddingTop={0}
            paddingBottom={0}
            onMouseDown={!showAll() && hiddenCount() > 0 ? () => setShowAll(true) : undefined}
          >
            <For each={visibleChildren()}>
              {(child) => <ToolRow tool={child} />}
            </For>
            <Show when={!showAll() && hiddenCount() > 0}>
              <box paddingLeft={1}>
                <text fg={theme.textMuted}>▸ {hiddenCount()} more</text>
              </box>
            </Show>
          </box>
        </Show>
      </Show>

      {/* ── Completed/Paused: header + bordered tool list (always visible) ── */}
      <Show when={canToggle()}>
        <box flexDirection="row" gap={1}>
          <text fg={theme.secondary}>✓</text>
          <text fg={theme.secondary} attributes={createTextAttributes({ bold: true })}>{props.block.agentLabel}</text>
          <text fg={theme.textMuted}>· {summary()}</text>
        </box>
        <box
          flexDirection="column"
          border={true}
          borderColor={theme.borderSubtle}
          paddingTop={0}
          paddingBottom={0}
          onMouseDown={!showAll() && hiddenCount() > 0 ? () => setShowAll(true) : undefined}
        >
          <For each={visibleChildren()}>
            {(child) => <ToolRow tool={child} />}
          </For>
          <Show when={!showAll() && hiddenCount() > 0}>
            <box paddingLeft={1}>
              <text fg={theme.textMuted}>▸ {hiddenCount()} more</text>
            </box>
          </Show>
        </box>
      </Show>

      {/* ── Error ── */}
      <Show when={props.block.status === "error"}>
        <box flexDirection="row" gap={1}>
          <text fg={theme.error}>✗</text>
          <text fg={theme.error} attributes={createTextAttributes({ bold: true })}>{props.block.agentLabel}</text>
          <text fg={theme.error}>{props.block.description}</text>
        </box>
        <Show when={props.block.errorMessage}>
          <text fg={theme.error} paddingLeft={2}>{props.block.errorMessage}</text>
        </Show>
      </Show>
    </box>
  )
}

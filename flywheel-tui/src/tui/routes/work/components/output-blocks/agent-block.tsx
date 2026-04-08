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
import { CollapsibleBox } from "@tui/shared/components/collapsible-box"
import { truncate } from "@tui/utils/text"
import { formatDuration } from "../../../../format.js"
import { displayToolName } from "./tool-block"
import type { AgentBlock as AgentBlockType, ToolBlock as ToolBlockType } from "@tui/types"

const MAX_VISIBLE_TOOLS = 6

export interface AgentBlockProps {
  block: AgentBlockType
  expanded?: boolean
  onToggleExpand?: (id: string) => void
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
  const [activeCollapsed, setActiveCollapsed] = createSignal(false)

  const toolCount = () => props.block.children.length
  const canToggle = () => props.block.status === "completed" || props.block.status === "paused"
  const descriptionText = () => {
    const d = props.block.description
    // Only show description in completed/paused state if it differs from the initial active-state label
    const isInitial = d === "Analyzing step and crafting worker prompt" || d === "Checking output quality"
    return (!isInitial && d) ? d : ""
  }
  const summary = () => {
    const parts: string[] = []
    const desc = descriptionText()
    if (desc) parts.push(desc)
    parts.push(`${toolCount()} tools`)
    if (props.block.duration != null) parts.push(formatDuration(props.block.duration))
    return parts.join(" · ")
  }

  const isActive = () => props.block.status === "active"
  const visibleChildren = () => {
    const all = props.block.children
    if (!isActive() || showAll() || all.length <= MAX_VISIBLE_TOOLS) return all
    // Show the most recent MAX_VISIBLE_TOOLS — older tools scroll off the top
    return all.slice(-MAX_VISIBLE_TOOLS)
  }
  const hiddenCount = () => {
    const all = props.block.children
    if (!isActive() || showAll() || all.length <= MAX_VISIBLE_TOOLS) return 0
    return all.length - MAX_VISIBLE_TOOLS
  }

  const toggleShowAll = () => setShowAll((v) => !v)

  return (
    <box flexDirection="column" marginTop={1}>
      {/* ── Active: header above bordered tool list ── */}
      <Show when={props.block.status === "active"}>
        <box flexDirection="row" gap={1} onMouseDown={() => setActiveCollapsed((v) => !v)}>
          <Spinner color={theme.primary} />
          <text fg={theme.primary} attributes={createTextAttributes({ bold: true })}>{props.block.agentLabel}</text>
          <Show when={toolCount() > 0}>
            <text fg={theme.textMuted}>({toolCount()})</text>
          </Show>
          <text fg={theme.textMuted}>{activeCollapsed() ? "▸" : "▾"}</text>
        </box>
        <CollapsibleBox
          expanded={!activeCollapsed() && visibleChildren().length > 0}
          border={true}
          borderColor={theme.borderSubtle}
          paddingTop={0}
          paddingBottom={0}
          onMouseDown={hiddenCount() > 0 ? toggleShowAll : undefined}
        >
          <For each={visibleChildren()}>
            {(child) => <ToolRow tool={child} />}
          </For>
          <Show when={hiddenCount() > 0}>
            <box paddingLeft={1}>
              <text fg={theme.textMuted}>{showAll() ? "▾ show less" : `▸ ${hiddenCount()} more`}</text>
            </box>
          </Show>
        </CollapsibleBox>
      </Show>

      {/* ── Completed/Paused: collapsible header + bordered tool list ── */}
      <Show when={canToggle()}>
        <box flexDirection="row" gap={1} onMouseDown={() => props.onToggleExpand?.(props.block.id)}>
          <text fg={theme.secondary}>✓</text>
          <text fg={theme.secondary} attributes={createTextAttributes({ bold: true })}>{props.block.agentLabel}</text>
          <text fg={theme.textMuted}>{props.expanded ? "▾" : "▸"}</text>
          <text fg={theme.textMuted}>· {summary()}</text>
        </box>
        <CollapsibleBox
          expanded={props.expanded ?? false}
          border={true}
          borderColor={theme.borderSubtle}
          paddingTop={0}
          paddingBottom={0}
          onMouseDown={hiddenCount() > 0 ? toggleShowAll : undefined}
        >
          <For each={visibleChildren()}>
            {(child) => <ToolRow tool={child} />}
          </For>
          <Show when={hiddenCount() > 0}>
            <box paddingLeft={1}>
              <text fg={theme.textMuted}>{showAll() ? "▾ show less" : `▸ ${hiddenCount()} more`}</text>
            </box>
          </Show>
        </CollapsibleBox>
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

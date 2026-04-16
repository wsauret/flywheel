/** @jsxImportSource @opentui/solid */

import { createSignal, Show, For } from "solid-js"
import { BOLD } from "@tui/shared/ui/text-attributes"
import { useTheme } from "@tui/shared/context/theme"
import { Spinner } from "@tui/shared/components/spinner"
import { CollapsibleBox } from "@tui/shared/components/collapsible-box"
import { ExpandToggle } from "@tui/shared/components/expand-toggle"
import { useElapsed } from "@tui/shared/hooks/use-elapsed"
import { formatDuration, formatElapsed } from "@infra/format.js"
import { ToolEntry } from "./tool-entry.js"
import { DISPATCHER_INITIAL_DESCRIPTION, EVALUATOR_INITIAL_DESCRIPTION } from "../../../../adapters/ndjson-pipeline.js"
import type { AgentBlock as AgentBlockType } from "@infra/output-blocks"

const MAX_VISIBLE_TOOLS = 4

interface AgentBlockProps {
  block: AgentBlockType
  expanded?: boolean
  onToggleExpand?: (id: string) => void
}

export function AgentBlock(props: AgentBlockProps) {
  const { theme } = useTheme()
  const [showAll, setShowAll] = createSignal(false)
  const activeElapsed = useElapsed(() => props.block.status === "active" ? props.block.timestamp : undefined)

  const toolCount = () => props.block.children.length
  const canToggle = () => props.block.status === "completed" || props.block.status === "paused"
  const goalText = () => {
    const d = props.block.description
    if (props.block.agentLabel === "Tools") return ""
    const isInitial = d === DISPATCHER_INITIAL_DESCRIPTION || d === EVALUATOR_INITIAL_DESCRIPTION
    if (isInitial || !d) return ""
    // Suppress when description is just the tool name (fallback in parser)
    if (d === props.block.agentLabel) return ""
    return d
  }
  const activeSummary = () => {
    const parts: string[] = []
    const goal = goalText()
    if (goal) parts.push(goal)
    if (toolCount() > 0) parts.push(`${toolCount()} tools`)
    const elapsed = activeElapsed()
    if (elapsed >= 1000) parts.push(formatElapsed(elapsed))
    return parts.join(" · ")
  }

  const completedSummary = () => {
    const parts: string[] = []
    const goal = goalText()
    if (goal) parts.push(goal)
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
    if (!isActive() || all.length <= MAX_VISIBLE_TOOLS) return 0
    return all.length - MAX_VISIBLE_TOOLS
  }

  const toggleShowAll = () => setShowAll((v) => !v)

  function ToolList() {
    return (
      <>
        <For each={visibleChildren()}>
          {(child) => <ToolEntry block={child} />}
        </For>
        <Show when={hiddenCount() > 0}>
          <box paddingLeft={1}>
            <text fg={theme.textMuted}>{showAll() ? "▾ show less" : `▸ ${hiddenCount()} more`}</text>
          </box>
        </Show>
      </>
    )
  }

  return (
    <box flexDirection="column" marginTop={1}>
      <Show when={props.block.status === "active"}>
        <box flexDirection="row" gap={1} onMouseDown={hiddenCount() > 0 ? toggleShowAll : undefined}>
          <Spinner color={theme.secondary} />
          <text fg={theme.secondary} attributes={BOLD}>{props.block.agentLabel}</text>
          <Show when={activeSummary()}>
            <text fg={theme.textSubtle} flexShrink={1} overflow="hidden" wrapMode="none">· {activeSummary()}</text>
          </Show>
          <Show when={hiddenCount() > 0}>
            <ExpandToggle expanded={showAll()} />
          </Show>
        </box>
        <CollapsibleBox
          expanded={visibleChildren().length > 0}
          border={true}
          borderColor={theme.borderSubtle}
          paddingTop={0}
          paddingBottom={0}
          onMouseDown={hiddenCount() > 0 ? toggleShowAll : undefined}
        >
          <ToolList />
        </CollapsibleBox>
      </Show>

      <Show when={canToggle()}>
        <box flexDirection="row" gap={1} onMouseDown={() => props.onToggleExpand?.(props.block.id)}>
          <text fg={theme.primary}>✓</text>
          <text fg={theme.primary} attributes={BOLD}>{props.block.agentLabel}</text>
          <ExpandToggle expanded={props.expanded ?? false} />
          <text fg={theme.textSubtle}>· {completedSummary()}</text>
        </box>
        <CollapsibleBox
          expanded={props.expanded ?? false}
          border={true}
          borderColor={theme.borderSubtle}
          paddingTop={0}
          paddingBottom={0}
          onMouseDown={hiddenCount() > 0 ? toggleShowAll : undefined}
        >
          <ToolList />
        </CollapsibleBox>
      </Show>

      <Show when={props.block.status === "error"}>
        <box flexDirection="row" gap={1}>
          <text fg={theme.error}>✗</text>
          <text fg={theme.error} attributes={BOLD}>{props.block.agentLabel}</text>
          <text fg={theme.error} flexShrink={1} overflow="hidden" wrapMode="none">{props.block.description}</text>
        </box>
        <Show when={props.block.errorMessage}>
          <box paddingLeft={3} overflow="hidden">
            <text fg={theme.error} overflow="hidden" wrapMode="none">{props.block.errorMessage}</text>
          </box>
        </Show>
      </Show>
    </box>
  )
}

/** @jsxImportSource @opentui/solid */

/**
 * Renders a titled group of ToolRows — used for both subagent blocks (Task/Agent)
 * and ad-hoc Tools groups. Underlying storage is AgentBlock in the schema; the
 * component is generic because both cases share the same shape: a title, a
 * collapsible box of rows, and active/completed/error states.
 *
 * Tools groups with a single child render as just the row — no "Tools" header,
 * no border. The chrome materializes when a second row joins. Subagents always
 * render their title because it names what the agent is doing.
 */

import { createSignal, Show, Index } from "solid-js"
import { BOLD } from "@tui/shared/ui/text-attributes"
import { useTheme } from "@tui/shared/context/theme"
import { Spinner } from "@tui/shared/components/spinner"
import { CollapsibleBox } from "@tui/shared/components/collapsible-box"
import { ExpandToggle } from "@tui/shared/components/expand-toggle"
import { useElapsed } from "@tui/shared/hooks/use-elapsed"
import { formatDuration, formatElapsed } from "@infra/format.js"
import { ToolRow, BOX_MAX_VISIBLE_TOOLS, SUCCESS_ICON, ERROR_ICON, moreHint } from "./tool-row.js"
import { ToolEntry as ToolEntryBlock, displayToolName } from "./tool-entry.js"
import { DISPATCHER_INITIAL_DESCRIPTION, EVALUATOR_INITIAL_DESCRIPTION } from "../../../../adapters/ndjson-pipeline.js"
import type { AgentBlock } from "@infra/output-blocks"

const TOOLS_LABEL = "Tools"

interface ToolGroupBlockProps {
  block: AgentBlock
  expanded?: boolean
  onToggleExpand?: (id: string) => void
}

function pluralizeTools(n: number): string {
  return `${n} tool${n === 1 ? "" : "s"}`
}

export function ToolGroupBlock(props: ToolGroupBlockProps) {
  const { theme } = useTheme()
  const [showAll, setShowAll] = createSignal(false)
  const activeElapsed = useElapsed(() => props.block.status === "active" ? props.block.timestamp : undefined)

  const toolCount = () => props.block.children.length
  const canToggle = () => props.block.status === "completed" || props.block.status === "paused"
  const isToolsGroup = () => props.block.agentLabel === TOOLS_LABEL
  const isBareSingleTool = () => isToolsGroup() && toolCount() === 1

  const goalText = () => {
    const d = props.block.description
    if (isToolsGroup()) return ""
    const isInitial = d === DISPATCHER_INITIAL_DESCRIPTION || d === EVALUATOR_INITIAL_DESCRIPTION
    if (isInitial || !d) return ""
    if (d === props.block.agentLabel) return ""
    return d
  }
  const activeSummary = () => {
    const parts: string[] = []
    const goal = goalText()
    if (goal) parts.push(goal)
    if (toolCount() > 0) parts.push(pluralizeTools(toolCount()))
    const elapsed = activeElapsed()
    if (elapsed >= 1000) parts.push(formatElapsed(elapsed))
    return parts.join(" · ")
  }

  const completedSummary = () => {
    const parts: string[] = []
    const goal = goalText()
    if (goal) parts.push(goal)
    if (toolCount() > 0) parts.push(pluralizeTools(toolCount()))
    if (props.block.duration != null) parts.push(formatDuration(props.block.duration))
    return parts.join(" · ")
  }

  const isActive = () => props.block.status === "active"
  const hasChildren = () => toolCount() > 0
  const visibleChildren = () => {
    const all = props.block.children
    if (!isActive() || showAll() || all.length <= BOX_MAX_VISIBLE_TOOLS) return all
    return all.slice(-BOX_MAX_VISIBLE_TOOLS)
  }
  const hiddenCount = () => {
    const all = props.block.children
    if (!isActive() || all.length <= BOX_MAX_VISIBLE_TOOLS) return 0
    return all.length - BOX_MAX_VISIBLE_TOOLS
  }

  const toggleShowAll = () => setShowAll((v) => !v)

  function ToolList() {
    return (
      <>
        <Index each={visibleChildren()}>
          {(child) => <ToolRow tool={child()} />}
        </Index>
        <Show when={hiddenCount() > 0}>
          <box paddingLeft={1}>
            <text fg={theme.textMuted}>{moreHint(hiddenCount(), showAll())}</text>
          </box>
        </Show>
      </>
    )
  }

  return (
    <box flexDirection="column">
      <Show when={isBareSingleTool() && (isActive() || canToggle())}>
        <Show when={props.block.children[0]!.completed || props.block.children[0]!.errorMessage}
          fallback={
            <box flexDirection="row" gap={1} overflow="hidden">
              <Spinner color={theme.secondary} />
              <text fg={theme.text} attributes={BOLD}>{displayToolName(props.block.children[0]!.name)}</text>
              <text fg={theme.textSubtle} flexShrink={1} overflow="hidden" wrapMode="none">{props.block.children[0]!.detail}</text>
            </box>
          }
        >
          <ToolEntryBlock block={props.block.children[0]!} />
        </Show>
      </Show>

      <Show when={props.block.status === "active" && !isBareSingleTool()}>
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
        <Show when={hasChildren()}>
          <CollapsibleBox
            expanded={true}
            border={true}
            borderColor={theme.borderSubtle}
            paddingTop={0}
            paddingBottom={0}
            onMouseDown={hiddenCount() > 0 ? toggleShowAll : undefined}
          >
            <ToolList />
          </CollapsibleBox>
        </Show>
      </Show>

      <Show when={canToggle() && !isBareSingleTool()}>
        <box flexDirection="row" gap={1} onMouseDown={() => props.onToggleExpand?.(props.block.id)}>
          <text fg={theme.primary}>{SUCCESS_ICON}</text>
          <text fg={theme.primary} attributes={BOLD}>{props.block.agentLabel}</text>
          <Show when={hasChildren()}>
            <ExpandToggle expanded={props.expanded ?? false} />
          </Show>
          <Show when={completedSummary()}>
            <text fg={theme.textSubtle}>· {completedSummary()}</text>
          </Show>
        </box>
        <Show when={hasChildren()}>
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
      </Show>

      <Show when={props.block.status === "error"}>
        <box flexDirection="row" gap={1}>
          <text fg={theme.error}>{ERROR_ICON}</text>
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

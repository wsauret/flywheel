/** @jsxImportSource @opentui/solid */

import { createSignal, createMemo, createEffect, Show, Index } from "solid-js"
import { StyledText, fg as stFg, bold as stBold, type TextChunk } from "@opentui/core"
import type { TextRenderable } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { CollapsibleBox } from "@tui/shared/components/collapsible-box"
import { useElapsed } from "@tui/shared/hooks/use-elapsed"
import { useSpinnerFrame } from "@tui/shared/hooks/use-spinner-frame.js"
import { formatDuration, formatElapsed } from "@infra/format.js"
import { ToolRow, BOX_MAX_VISIBLE_TOOLS, SUCCESS_ICON, ERROR_ICON, moreHint } from "./tool-row.js"
import { ToolEntry as ToolEntryBlock } from "./tool-entry.js"
import { DISPATCHER_INITIAL_DESCRIPTION, EVALUATOR_INITIAL_DESCRIPTION } from "../../../../adapters/ndjson-pipeline.js"
import { deriveGroupSummary, toolsGroupLabel } from "./group-summary.js"
import { shouldRenderGroupedToolAsEntry } from "./tool-entry-helpers.js"
import type { ToolGroupBlock as ToolGroupBlockType } from "@infra/output-blocks"

interface ToolGroupBlockProps {
  block: ToolGroupBlockType
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

  const toolCount = () => props.block.children.filter(c => c.name !== "Thinking").length
  const canToggle = () => props.block.status === "completed" || props.block.status === "paused"
  const isToolsGroup = () => props.block.groupKind === "tools"
  const isBareSingleTool = () => isToolsGroup() && toolCount() === 1

  const goalText = () => {
    const d = props.block.description
    if (isToolsGroup()) return ""
    const isInitial = d === DISPATCHER_INITIAL_DESCRIPTION || d === EVALUATOR_INITIAL_DESCRIPTION
    if (isInitial || !d) return ""
    if (d === props.block.label) return ""
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

  const isActive = () => props.block.status === "active"
  const isPaused = () => props.block.status === "paused"
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

  const dynamicLabel = createMemo(() => {
    if (props.block.groupKind === "agent") return props.block.label
    return toolsGroupLabel(props.block.status)
  })
  const dynamicSummary = createMemo(() =>
    deriveGroupSummary(props.block.children)
  )

  const spinnerFrame = useSpinnerFrame(() => props.block.status === "active")
  const toggleShowAll = () => setShowAll((v) => !v)

  const activeHeaderContent = createMemo(() => {
    const chunks: TextChunk[] = [
      stFg(theme.secondary)(spinnerFrame()),
      stFg(theme.text)(" "),
      stBold(stFg(theme.secondary)(dynamicLabel())),
    ]
    const summary = activeSummary()
    if (summary) {
      chunks.push(stFg(theme.text)(" "))
      chunks.push(stFg(theme.textSubtle)(`· ${summary}`))
    }
    if (hiddenCount() > 0) {
      chunks.push(stFg(theme.text)(" "))
      chunks.push(stFg(theme.textMuted)(showAll() ? "▾" : "▸"))
    }
    return new StyledText(chunks)
  })

  const completedHeaderContent = createMemo(() => {
    const chunks: TextChunk[] = [
      stFg(theme.primary)(SUCCESS_ICON),
      stFg(theme.text)(" "),
      stBold(stFg(theme.primary)(dynamicLabel())),
    ]
    const goal = goalText()
    if (goal) {
      chunks.push(stFg(theme.textSubtle)(` · ${goal}`))
    }
    const summary = dynamicSummary()
    if (summary) {
      chunks.push(stFg(theme.textSubtle)(` · ${summary}`))
    }
    if (props.block.duration != null) {
      chunks.push(stFg(theme.textSubtle)(` · ${formatDuration(props.block.duration)}`))
    }
    if (hasChildren()) {
      chunks.push(stFg(theme.text)("  "))
      chunks.push(stFg(theme.textMuted)((props.expanded ?? false) ? "▾" : "▸"))
    }
    return new StyledText(chunks)
  })

  const pausedHeaderContent = createMemo(() => {
    const chunks: TextChunk[] = [
      stFg(theme.warning)(ERROR_ICON),
      stFg(theme.text)(" "),
      stBold(stFg(theme.warning)(dynamicLabel())),
    ]
    const goal = goalText()
    if (goal) {
      chunks.push(stFg(theme.textSubtle)(` · ${goal}`))
    }
    const summary = dynamicSummary()
    if (summary) {
      chunks.push(stFg(theme.textSubtle)(` · ${summary}`))
    }
    if (props.block.duration != null) {
      chunks.push(stFg(theme.textSubtle)(` · ${formatDuration(props.block.duration)}`))
    }
    if (hasChildren()) {
      chunks.push(stFg(theme.text)("  "))
      chunks.push(stFg(theme.textMuted)((props.expanded ?? false) ? "▾" : "▸"))
    }
    return new StyledText(chunks)
  })

  const errorHeaderContent = createMemo(() => {
    const chunks: TextChunk[] = [
      stFg(theme.error)(ERROR_ICON),
      stFg(theme.text)(" "),
      stBold(stFg(theme.error)(props.block.label)),
    ]
    if (props.block.description) {
      chunks.push(stFg(theme.text)(" "))
      chunks.push(stFg(theme.error)(props.block.description))
    }
    if (props.block.errorMessage) {
      chunks.push(stFg(theme.text)(" "))
      chunks.push(stFg(theme.error)(props.block.errorMessage))
    }
    return new StyledText(chunks)
  })

  function ToolList() {
    return (
      <>
        <Index each={visibleChildren()}>
          {(child) => shouldRenderGroupedToolAsEntry(child())
            ? <ToolEntryBlock block={child()} interrupted={isPaused()} />
            : <ToolRow tool={child()} interrupted={isPaused()} />}
        </Index>
        <Show when={hiddenCount() > 0}>
          <box selectable={false} paddingLeft={1} onMouseDown={toggleShowAll}>
            <text selectable={false} fg={theme.textMuted}>{moreHint(hiddenCount(), showAll())}</text>
          </box>
        </Show>
      </>
    )
  }

  return (
    <box flexDirection="column">
      <Show when={isBareSingleTool() && (isActive() || canToggle())}>
        <ToolEntryBlock block={props.block.children[0]!} interrupted={isPaused()} />
      </Show>

      <Show when={props.block.status === "active" && !isBareSingleTool()}>
        <box selectable={false} onMouseDown={hiddenCount() > 0 ? toggleShowAll : undefined}>
          <text
            selectable={false}
            ref={(el: TextRenderable) => {
              createEffect(() => { el.content = activeHeaderContent() })
            }}
            overflow="hidden"
            wrapMode="none"
          />
        </box>
        <Show when={hasChildren()}>
          <CollapsibleBox
            expanded={true}
            border={true}
            borderColor={theme.borderSubtle}
            paddingTop={0}
            paddingBottom={0}
          >
            <ToolList />
          </CollapsibleBox>
        </Show>
      </Show>

      <Show when={props.block.status === "completed" && !isBareSingleTool()}>
        <box selectable={false} onMouseDown={() => props.onToggleExpand?.(props.block.id)}>
          <text
            selectable={false}
            ref={(el: TextRenderable) => {
              createEffect(() => { el.content = completedHeaderContent() })
            }}
            overflow="hidden"
            wrapMode="none"
          />
        </box>
        <Show when={hasChildren()}>
          <CollapsibleBox
            expanded={props.expanded ?? false}
            border={true}
            borderColor={theme.borderSubtle}
            paddingTop={0}
            paddingBottom={0}
          >
            <ToolList />
          </CollapsibleBox>
        </Show>
      </Show>

      <Show when={props.block.status === "paused" && !isBareSingleTool()}>
        <box selectable={false} onMouseDown={() => props.onToggleExpand?.(props.block.id)}>
          <text
            selectable={false}
            ref={(el: TextRenderable) => {
              createEffect(() => { el.content = pausedHeaderContent() })
            }}
            overflow="hidden"
            wrapMode="none"
          />
        </box>
        <Show when={hasChildren()}>
          <CollapsibleBox
            expanded={props.expanded ?? false}
            border={true}
            borderColor={theme.borderSubtle}
            paddingTop={0}
            paddingBottom={0}
          >
            <ToolList />
          </CollapsibleBox>
        </Show>
      </Show>

      <Show when={props.block.status === "error"}>
        <box>
          <text
            ref={(el: TextRenderable) => {
              createEffect(() => { el.content = errorHeaderContent() })
            }}
            overflow="hidden"
            wrapMode="none"
          />
        </box>
      </Show>
    </box>
  )
}

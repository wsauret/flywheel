/** @jsxImportSource @opentui/solid */
/**
 * Output Window Component
 *
 * Displays streaming workflow output with auto-scroll.
 * Step progress is shown in the shell header — this component
 * focuses purely on output block rendering.
 */

import { Show, Index, createSignal } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { useKeyboard } from "@opentui/solid"
import { ShimmerText } from "@tui/shared/components/shimmer-text"
import { Spinner } from "@tui/shared/components/spinner"
import { BlockRenderer } from "./output-blocks/block-renderer"
import type { WorkflowStatus, AnyBlock } from "@tui/types"

export interface OutputWindowProps {
  outputBlocks: readonly AnyBlock[]
  workflowStatus: WorkflowStatus
  approvalPending: boolean
  isPromptFocused: boolean
}

export function OutputWindow(props: OutputWindowProps) {
  const themeCtx = useTheme()
  const [scrollRef, setScrollRef] = createSignal<ScrollBoxRenderable | undefined>()
  const [expandedIds, setExpandedIds] = createSignal<Set<string>>(new Set())

  const toggleBlock = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    const agentBlocks = props.outputBlocks.filter((b): b is import("@tui/types").AgentBlock => b.kind === "agent")
    const currentExpanded = expandedIds()
    const allExpanded = agentBlocks.every((b) => currentExpanded.has(b.id))
    if (allExpanded) {
      setExpandedIds(new Set<string>())
    } else {
      setExpandedIds(new Set<string>(agentBlocks.map((b) => b.id)))
    }
  }

  useKeyboard((evt) => {
    if (evt.name === "o" && evt.ctrl && !evt.meta) {
      evt.preventDefault()
      toggleAll()
    }
  })

  const isRunning = () => props.workflowStatus === "running"
  const hasContent = () => props.outputBlocks.length > 0

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Content */}
      <box paddingLeft={1} paddingRight={0} flexDirection="column" flexGrow={1}>
        <Show when={!hasContent() && isRunning()}>
          <box flexDirection="row">
            <Spinner color={themeCtx.theme.primary} />
            <text> </text>
            <ShimmerText text="Starting worker..." color={themeCtx.theme.textMuted} />
          </box>
        </Show>

        <Show when={!hasContent() && !isRunning() && props.workflowStatus !== "idle"}>
          <text fg={themeCtx.theme.textMuted}>
            {props.workflowStatus === "completed"
              ? "Workflow completed with no output"
              : props.workflowStatus === "interrupted"
                ? "Workflow was stopped before producing output"
                : props.workflowStatus === "failed"
                  ? "Workflow failed before producing output"
                  : ""}
          </text>
        </Show>

        <Show when={hasContent()}>
          <scrollbox
            ref={(r: ScrollBoxRenderable) => setScrollRef(r)}
            flexGrow={1}
            width="100%"
            stickyScroll={true}
            stickyStart="bottom"
            viewportOptions={{
              paddingRight: 1,
            }}
            verticalScrollbarOptions={{
              paddingLeft: 1,
              trackOptions: {
                foregroundColor: themeCtx.theme.border,
                backgroundColor: themeCtx.theme.backgroundElement,
              },
            }}
            viewportCulling={true}
            focused={!props.isPromptFocused}
          >
            <Index each={props.outputBlocks}>
              {(block) => <BlockRenderer block={block()} expandedIds={expandedIds()} onToggleExpand={toggleBlock} />}
            </Index>
          </scrollbox>
        </Show>

      </box>
    </box>
  )
}

/** @jsxImportSource @opentui/solid */

import { Show, Index, createSignal, createMemo, createEffect } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { useKeyboard } from "@opentui/solid"
import { ShimmerText } from "@tui/shared/components/shimmer-text"
import { Spinner } from "@tui/shared/components/spinner"
import { BlockRenderer } from "./output-blocks/block-renderer.js"
import type { AnyBlock } from "@infra/output-blocks"

type WorkflowStatus = "idle" | "running" | "completed" | "interrupted"

interface OutputWindowProps {
  outputBlocks: readonly AnyBlock[]
  workflowStatus: WorkflowStatus
  showThinking?: boolean
}

export function OutputWindow(props: OutputWindowProps) {
  const themeCtx = useTheme()
  const [expandedIds, setExpandedIds] = createSignal<Set<string>>(new Set())

  const toggleBlock = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const agentBlockIds = createMemo(() =>
    props.outputBlocks.filter((b) => b.kind === "toolGroup").map((b) => b.id)
  )

  const toggleAll = () => {
    const ids = agentBlockIds()
    const currentExpanded = expandedIds()
    const allExpanded = ids.every((id) => currentExpanded.has(id))
    if (allExpanded) {
      setExpandedIds(new Set<string>())
    } else {
      setExpandedIds(new Set<string>(ids))
    }
  }

  useKeyboard((evt) => {
    if (evt.name === "o" && evt.ctrl && !evt.meta) {
      evt.preventDefault()
      toggleAll()
    }
  })

  let scrollboxRef: ScrollBoxRenderable | undefined

  const hasUnansweredQuestion = createMemo(() => {
    const last = props.outputBlocks.at(-1)
    return last?.kind === "question" && !last.answers && !last.cancelled
  })

  createEffect(() => {
    if (hasUnansweredQuestion()) scrollboxRef?.scrollTo(scrollboxRef.scrollHeight)
  })

  const isRunning = () => props.workflowStatus === "running"
  const hasContent = () => props.outputBlocks.length > 0

  return (
    <box flexDirection="column" flexGrow={1}>
      <box paddingLeft={1} paddingRight={0} flexDirection="column" flexGrow={1}>
        <Show when={!hasContent() && isRunning()}>
          <box flexDirection="row" gap={1}>
            <Spinner color={themeCtx.theme.primary} />
            <ShimmerText text="Starting worker..." color={themeCtx.theme.textMuted} />
          </box>
        </Show>

        <Show when={!hasContent() && !isRunning() && props.workflowStatus !== "idle"}>
          <text fg={themeCtx.theme.textMuted}>
            {props.workflowStatus === "completed"
              ? "Workflow completed with no output"
              : "Workflow was stopped before producing output"}
          </text>
        </Show>

        <Show when={hasContent()}>
          <scrollbox
            ref={(el: ScrollBoxRenderable) => { scrollboxRef = el }}
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
            viewportCulling={false}
            focused={false}
          >
            <Index each={props.outputBlocks}>
              {(block) => <BlockRenderer block={block()} expandedIds={expandedIds()} onToggleExpand={toggleBlock} showThinking={props.showThinking} />}
            </Index>
          </scrollbox>
        </Show>

      </box>
    </box>
  )
}

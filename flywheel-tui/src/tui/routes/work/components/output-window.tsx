/** @jsxImportSource @opentui/solid */
/**
 * Output Window Component
 *
 * Displays streaming workflow output with auto-scroll.
 * The prompt now lives outside OutputWindow as UnifiedPrompt.
 */

import { Show, Index, createSignal } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { useKeyboard } from "@opentui/solid"
import { ShimmerText } from "@tui/shared/components/shimmer-text"
import { Spinner } from "@tui/shared/components/spinner"
import { BlockRenderer } from "./output-blocks/block-renderer"
import type { RGBA } from "@opentui/core"
import type { WorkflowStatus, QueueStepStatus, AnyBlock } from "@tui/types"
import { getStepStatusIcon } from "../../../components/workflow-panel-logic"

const MIN_WIDTH_FOR_INLINE_STATUS = 75

/** Get color for a queue step status. */
function getStepStatusColor(status: QueueStepStatus, theme: ReturnType<typeof useTheme>["theme"]): RGBA {
  switch (status) {
    case "completed": return theme.success
    case "running":   return theme.primary
    case "failed":    return theme.error
    case "skipped":   return theme.textMuted
    default:          return theme.text
  }
}

export interface CurrentStepInfo {
  index: number
  name: string
  status: QueueStepStatus
}

export interface OutputWindowProps {
  outputBlocks: readonly AnyBlock[]
  workflowStatus: WorkflowStatus
  approvalPending: boolean
  isPromptFocused: boolean
  availableWidth?: number
  currentStep?: CurrentStepInfo | null
  isInterrupted?: boolean
  /** Seconds since the last output block arrived. Used to show "Thinking... Xs" while the model is silent. */
  thinkingElapsed?: number
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
  const isWide = () => (props.availableWidth ?? 80) >= MIN_WIDTH_FOR_INLINE_STATUS
  // Block count removed — not a user-relevant metric

  const statusHeading = () => {
    if (isRunning()) return "Starting..."
    switch (props.workflowStatus) {
      case "completed": return "Completed"
      case "interrupted": return "Stopped"
      case "failed": return "Failed"
      default: return "Output"
    }
  }

  const activityPhrase = () => {
    if (props.approvalPending) return "Waiting for approval..."
    const elapsed = props.thinkingElapsed ?? 0
    if (isRunning() && hasContent() && elapsed >= 1) return `Thinking... ${elapsed}s`
    return null
  }

  const currentStepStatusLabel = () => (props.isInterrupted ? "interrupted" : props.currentStep?.status ?? "")

  const currentStepStatusColor = () => {
    if (props.isInterrupted) return themeCtx.theme.warning
    return props.currentStep ? getStepStatusColor(props.currentStep.status, themeCtx.theme) : themeCtx.theme.text
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Rich Header (when step is active) */}
      <Show when={props.currentStep}>
        {(step) => {
          const statusColor = () => getStepStatusColor(step().status, themeCtx.theme)

          return (
            <Show when={isWide()} fallback={
              /* Narrow layout: 4 lines */
              <box flexDirection="column" paddingLeft={1} height={4} flexShrink={0}>
                <text fg={themeCtx.theme.border}>{"\u2500\u2500"}</text>
                {/* Line 1: Step name */}
                <box flexDirection="row">
                  <text fg={themeCtx.theme.border}>{" "}</text>
                  <text fg={themeCtx.theme.text} attributes={1}>
                    Step {step().index + 1}: {step().name}
                  </text>
                </box>
                {/* Line 2: Status icon */}
                <box flexDirection="row">
                  <text fg={themeCtx.theme.border}>{" "}</text>
                  <Show when={step().status === "running" && !props.isInterrupted} fallback={
                    <text fg={currentStepStatusColor()}>{props.isInterrupted ? "⏸" : getStepStatusIcon(step().status)} {currentStepStatusLabel()}</text>
                  }>
                    <Spinner color={statusColor()} />
                    <text fg={statusColor()}> {step().status}</text>
                  </Show>
                </box>
                {/* Line 3: Activity phrase + line count */}
                <box flexDirection="row" justifyContent="space-between" paddingRight={2}>
                  <box flexDirection="row">
                    <text fg={themeCtx.theme.border}>{" "}</text>
                    <Show when={activityPhrase()} fallback={
                      <text fg={themeCtx.theme.textMuted}>{"\u21B3 "}{""}</text>
                    }>
                      {(phrase) => (
                        <>
                          <text fg={themeCtx.theme.textMuted}>{"\u21B3 "}</text>
                          <ShimmerText text={phrase()} color={themeCtx.theme.textMuted} />
                        </>
                      )}
                    </Show>
                  </box>
                  <Show when={activityPhrase()}>
                    <text fg={themeCtx.theme.textMuted}>{""}</text>
                  </Show>
                </box>
              </box>
            }>
              {/* Wide layout: 3 lines */}
              <box flexDirection="column" paddingLeft={1} height={3} flexShrink={0}>
                <text fg={themeCtx.theme.border}>{"\u2500\u2500"}</text>
                {/* Line 1: Step name + status */}
                <box flexDirection="row" justifyContent="space-between" paddingRight={2}>
                  <box flexDirection="row">
                    <text fg={themeCtx.theme.border}>{" "}</text>
                    <text fg={themeCtx.theme.text} attributes={1}>
                      Step {step().index + 1}: {step().name}
                    </text>
                  </box>
                  <box flexDirection="row">
                    <Show when={step().status === "running" && !props.isInterrupted} fallback={
                      <text fg={currentStepStatusColor()}>{props.isInterrupted ? "⏸" : getStepStatusIcon(step().status)} {currentStepStatusLabel()}</text>
                    }>
                      <Spinner color={statusColor()} />
                      <text fg={statusColor()}> {step().status}</text>
                    </Show>
                  </box>
                </box>
                {/* Line 2: Activity phrase + line count */}
                <box flexDirection="row" justifyContent="space-between" paddingRight={2}>
                  <box flexDirection="row">
                    <text fg={themeCtx.theme.border}>{" "}</text>
                    <Show when={activityPhrase()} fallback={
                      <text fg={themeCtx.theme.textMuted}>{"\u21B3 "}</text>
                    }>
                      {(phrase) => (
                        <>
                          <text fg={themeCtx.theme.textMuted}>{"\u21B3 "}</text>
                          <ShimmerText text={phrase()} color={themeCtx.theme.textMuted} />
                        </>
                      )}
                    </Show>
                  </box>
                  <text fg={themeCtx.theme.textMuted}>{""}</text>
                </box>
              </box>
            </Show>
          )
        }}
      </Show>

      {/* Content */}
      <box paddingLeft={1} paddingRight={1} flexDirection="column" flexGrow={1}>
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

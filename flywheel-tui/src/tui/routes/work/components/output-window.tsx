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
  outputBlocks: AnyBlock[]
  workflowStatus: WorkflowStatus
  approvalPending: boolean
  isPromptFocused: boolean
  availableWidth?: number
  currentStep?: CurrentStepInfo | null
}

export function OutputWindow(props: OutputWindowProps) {
  const themeCtx = useTheme()
  const [scrollRef, setScrollRef] = createSignal<ScrollBoxRenderable | undefined>()

  const isRunning = () => props.workflowStatus === "running"
  const hasContent = () => props.outputBlocks.length > 0
  const isWide = () => (props.availableWidth ?? 80) >= MIN_WIDTH_FOR_INLINE_STATUS
  const blockCountText = () => `${props.outputBlocks.length} blocks`

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
    if (props.currentStep?.status === "running") return "Executing step..."
    return null
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Rich Header (when step is active) */}
      <Show when={props.currentStep} fallback={
        /* Simple header: no active step — show status-aware heading */
        <box flexDirection="column" paddingLeft={1} height={2} flexShrink={0}>
          <text fg={themeCtx.theme.border}>{"\u2500\u2500"}</text>
          <box flexDirection="row" justifyContent="space-between" paddingRight={2}>
            <box flexDirection="row">
              <text fg={themeCtx.theme.border}>{" "}</text>
              <text fg={themeCtx.theme.text} attributes={1}>
                {hasContent() ? "Output" : statusHeading()}
              </text>
            </box>
            <Show when={hasContent()}>
              <text fg={themeCtx.theme.textMuted}>{blockCountText()}</text>
            </Show>
          </box>
        </box>
      }>
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
                  <Show when={step().status === "running"} fallback={
                    <text fg={statusColor()}>{getStepStatusIcon(step().status)} {step().status}</text>
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
                      <text fg={themeCtx.theme.textMuted}>{"\u21B3 "}{blockCountText()}</text>
                    }>
                      {(phrase) => (
                        <>
                          <text fg={themeCtx.theme.textMuted}>{"\u21B3 "}</text>
                          <ShimmerText text={phrase()} />
                        </>
                      )}
                    </Show>
                  </box>
                  <Show when={activityPhrase()}>
                    <text fg={themeCtx.theme.textMuted}>{blockCountText()}</text>
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
                    <Show when={step().status === "running"} fallback={
                      <text fg={statusColor()}>{getStepStatusIcon(step().status)} {step().status}</text>
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
                          <ShimmerText text={phrase()} />
                        </>
                      )}
                    </Show>
                  </box>
                  <text fg={themeCtx.theme.textMuted}>{blockCountText()}</text>
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
            <text fg={themeCtx.theme.text}>{"\u25CF "}</text>
            <ShimmerText text="Waiting for output..." />
          </box>
        </Show>

        <Show when={!hasContent() && !isRunning()}>
          <text fg={themeCtx.theme.textMuted}>
            {props.workflowStatus === "completed"
              ? "Workflow completed with no output"
              : props.workflowStatus === "interrupted"
                ? "Workflow was stopped before producing output"
                : props.workflowStatus === "failed"
                  ? "Workflow failed before producing output"
                  : "No output yet"}
          </text>
        </Show>

        <Show when={hasContent()}>
          <scrollbox
            ref={(r: ScrollBoxRenderable) => setScrollRef(r)}
            flexGrow={1}
            width="100%"
            stickyScroll={true}
            stickyStart="bottom"
            scrollbarOptions={{
              trackOptions: {
                foregroundColor: themeCtx.theme.info,
                backgroundColor: themeCtx.theme.border,
              },
            }}
            viewportCulling={true}
            focused={!props.isPromptFocused}
          >
            <Index each={props.outputBlocks}>
              {(block) => <BlockRenderer block={block()} />}
            </Index>
          </scrollbox>
        </Show>
      </box>
    </box>
  )
}

/** @jsxImportSource @opentui/solid */
/**
 * Telemetry Bar Component
 *
 * Show queue step progress, current step name/type, and runtime timer.
 * VAL-TUI-010: Step N/M display
 * VAL-TUI-011: Current step name/type
 * VAL-TUI-012: Runtime timer
 * VAL-TUI-013: Updates on step transitions
 */

import { Show, createMemo } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import { formatQueueStepProgress, formatQueueStepName, formatSprintIteration, type QueueStepProgressInfo, type SprintIterationInfo } from "../../../utils/format"
import type { WorkflowStatus } from "../state/types"

export interface TelemetryBarProps {
  /** Session or plan name displayed in the bar. */
  planName: string
  /** Formatted runtime string (e.g. "03:42"). Increments during execution. */
  runtime: string
  /** Current workflow status for status indicator. */
  status: WorkflowStatus
  /** Queue progress info: currentStep, totalSteps, stepName. */
  queueProgress?: QueueStepProgressInfo | null
  /** Sprint iteration info (optional, for sprint workflows). */
  sprintInfo?: SprintIterationInfo | null
}

/**
 * Show queue step progress, current step name/type, and runtime in footer.
 */
export function TelemetryBar(props: TelemetryBarProps) {
  const themeCtx = useTheme()

  const stepProgressText = createMemo(() => formatQueueStepProgress(props.queueProgress))
  const stepNameText = createMemo(() => formatQueueStepName(props.queueProgress))
  const sprintIterationText = createMemo(() => formatSprintIteration(props.sprintInfo))

  const showStatus = () => props.status === "stopping" || props.status === "interrupted" || props.status === "failed"

  const statusColor = () => {
    switch (props.status) {
      case "failed": return themeCtx.theme.error
      case "interrupted": return themeCtx.theme.warning
      case "stopping": return themeCtx.theme.warning
      default: return themeCtx.theme.textMuted
    }
  }

  const statusText = () => {
    switch (props.status) {
      case "stopping": return "Stopping"
      case "interrupted": return "Interrupted"
      case "failed": return "Failed"
      default: return ""
    }
  }

  return (
    <box
      paddingLeft={1}
      paddingRight={1}
      flexDirection="row"
      justifyContent="space-between"
      width="100%"
      borderStyle="rounded"
      borderColor={themeCtx.theme.border}
    >
      {/* Left side: runtime */}
      <box flexDirection="row" flexShrink={0}>
        <text fg={themeCtx.theme.textMuted}>Runtime: </text>
        <text fg={themeCtx.theme.text}>{props.runtime}</text>
      </box>

      {/* Separator to prevent left/right merging */}
      <text fg={themeCtx.theme.textMuted}> • </text>

      {/* Right side: plan name, step progress, step name, sprint info, status */}
      <box flexDirection="row" flexShrink={1} overflow="hidden">
        <text wrapMode="none" fg={themeCtx.theme.text} attributes={1}>
          {props.planName}
        </text>
        <Show when={stepProgressText()}>
          <text wrapMode="none" fg={themeCtx.theme.text}> • </text>
          <text wrapMode="none" fg={themeCtx.theme.primary}>{stepProgressText()}</text>
        </Show>
        <Show when={stepNameText()}>
          <text wrapMode="none" fg={themeCtx.theme.text}> • </text>
          <text wrapMode="none" fg={themeCtx.theme.secondary}>{stepNameText()}</text>
        </Show>
        <Show when={sprintIterationText()}>
          <text wrapMode="none" fg={themeCtx.theme.text}> • </text>
          <text wrapMode="none" fg={themeCtx.theme.primary}>{sprintIterationText()}</text>
        </Show>
        <Show when={showStatus()}>
          <text wrapMode="none" fg={themeCtx.theme.text}> • </text>
          <text wrapMode="none" fg={statusColor()}>{statusText()}</text>
        </Show>
      </box>
    </box>
  )
}

/** @jsxImportSource @opentui/solid */
/**
 * Telemetry Bar Component
 *
 * Show plan info, status, and phase progress in footer
 */

import { Show, createMemo } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import { formatPipelineStage, formatSprintIteration, type PipelineStageInfo, type SprintIterationInfo } from "../../../utils/format"
import type { WorkflowStatus } from "../state/types"

export interface TelemetryBarProps {
  planName: string
  runtime: string
  status: WorkflowStatus
  currentPhase?: number
  totalPhases?: number
  workflowLabel?: string  // "work" | "plan" | "review" etc.
  stepLabel?: string      // "Phase" | "Step" | "Cycle"
  pipelineInfo?: PipelineStageInfo | null
  sprintInfo?: SprintIterationInfo | null
}

/**
 * Show plan info, status, and phase progress in footer
 */
export function TelemetryBar(props: TelemetryBarProps) {
  const themeCtx = useTheme()

  const pipelineStageText = createMemo(() => formatPipelineStage(props.pipelineInfo))
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

      {/* Right side: plan name, pipeline stage, phase progress, status */}
      <box flexDirection="row" flexShrink={1} overflow="hidden">
        <text wrapMode="none" fg={themeCtx.theme.text} attributes={1}>
          {props.planName}
        </text>
        <Show when={pipelineStageText()}>
          <text wrapMode="none" fg={themeCtx.theme.text}> • </text>
          <text wrapMode="none" fg={themeCtx.theme.secondary}>{pipelineStageText()}</text>
        </Show>
        <Show when={sprintIterationText()}>
          <text wrapMode="none" fg={themeCtx.theme.text}> • </text>
          <text wrapMode="none" fg={themeCtx.theme.primary}>{sprintIterationText()}</text>
        </Show>
        <Show when={props.totalPhases && props.totalPhases > 0}>
          <text wrapMode="none" fg={themeCtx.theme.text}> • </text>
          <text wrapMode="none" fg={themeCtx.theme.primary}>{props.stepLabel ?? "Phase"} {props.currentPhase ?? 0}/{props.totalPhases}</text>
        </Show>
        <Show when={showStatus()}>
          <text wrapMode="none" fg={themeCtx.theme.text}> • </text>
          <text wrapMode="none" fg={statusColor()}>{statusText()}</text>
        </Show>
      </box>
    </box>
  )
}

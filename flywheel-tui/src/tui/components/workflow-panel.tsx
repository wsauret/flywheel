/** @jsxImportSource @opentui/solid */
/**
 * Workflow Panel — Right-side panel with summary + detailed phase timeline
 *
 * Consolidates the former WorkflowPanel (summary stats) and PhaseProgress
 * (detailed scrollable phase list) into a single right-side panel.
 *
 * Shows:
 *   - Workflow status and aggregate progress
 *   - Plan name
 *   - Scrollable phase list with selection, live durations, errors, spinners
 *
 * Collapses automatically when terminal width < 120 columns
 * (handled by SharedLayout, which controls visibility).
 */

import { Show, For } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import { useTimer } from "@tui/shared/services"
import { Spinner } from "@tui/shared/components/spinner"
import { computeProgress, statusLabel } from "./workflow-panel-logic"
import { getStatusIcon, getStatusColor } from "../routes/work/components/status-utils"
import type { Theme } from "@tui/shared/context/theme"
import type { WorkState, PhaseState } from "../routes/work/state/types"

// Re-export pure logic for consumers
export { computeProgress, statusLabel, type PanelProgress } from "./workflow-panel-logic"

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface WorkflowPanelProps {
  /** Current workflow state from the store. */
  state: WorkState
  /** Whether the panel is collapsed (hidden by user). */
  collapsed?: boolean
  /** Step label override (e.g., "Phase", "Step", "Cycle"). */
  stepLabel?: string
  /** Index of the currently selected phase (for keyboard navigation). */
  selectedPhaseIndex?: number
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WorkflowPanel(props: WorkflowPanelProps) {
  const themeCtx = useTheme()
  const timer = useTimer()
  const label = () => props.stepLabel ?? "Phase"

  const progress = () => computeProgress(props.state.phases)

  const statusColor = () => {
    switch (props.state.workflowStatus) {
      case "running":     return themeCtx.theme.info
      case "completed":   return themeCtx.theme.success
      case "failed":      return themeCtx.theme.error
      case "interrupted": return themeCtx.theme.warning
      default:            return themeCtx.theme.textMuted
    }
  }

  return (
    <Show when={!props.collapsed}>
      <box
        flexDirection="column"
        height="100%"
        borderStyle="single"
        borderColor={themeCtx.theme.border}
      >
        {/* Panel header */}
        <box paddingLeft={1} paddingRight={1} flexShrink={0}>
          <text fg={themeCtx.theme.text} attributes={1}>
            Workflow
          </text>
        </box>

        {/* Status */}
        <box paddingLeft={1} paddingRight={1} flexShrink={0} marginTop={1}>
          <text fg={themeCtx.theme.textMuted}>Status: </text>
          <text fg={statusColor()}>
            {statusLabel(props.state.workflowStatus)}
          </text>
        </box>

        {/* Progress summary */}
        <box paddingLeft={1} paddingRight={1} flexShrink={0}>
          <text fg={themeCtx.theme.textMuted}>
            {label()}s: {progress().completed}/{progress().total}
          </text>
        </box>

        <Show when={progress().running > 0}>
          <box paddingLeft={1} paddingRight={1} flexShrink={0}>
            <text fg={themeCtx.theme.info}>
              Running: {progress().running}
            </text>
          </box>
        </Show>

        <Show when={progress().failed > 0}>
          <box paddingLeft={1} paddingRight={1} flexShrink={0}>
            <text fg={themeCtx.theme.error}>
              Failed: {progress().failed}
            </text>
          </box>
        </Show>

        {/* Plan name */}
        <Show when={props.state.planName}>
          <box paddingLeft={1} paddingRight={1} flexShrink={0} marginTop={1}>
            <text fg={themeCtx.theme.textMuted}>Plan: </text>
            <text fg={themeCtx.theme.text}>
              {truncate(props.state.planName, 28)}
            </text>
          </box>
        </Show>

        {/* ── Detailed phase timeline (scrollable) ── */}
        <Show
          when={props.state.phases.length > 0}
          fallback={
            <box paddingLeft={1} marginTop={1}>
              <text fg={themeCtx.theme.textMuted}>No phases yet.</text>
            </box>
          }
        >
          <box paddingLeft={1} paddingRight={1} marginTop={1} flexShrink={0}>
            <text fg={themeCtx.theme.textMuted} attributes={1}>
              {label()}s
            </text>
          </box>

          <scrollbox
            flexGrow={1}
            scrollbarOptions={{ visible: false }}
            viewportCulling={true}
          >
            <For each={props.state.phases}>
              {(phase) => (
                <PhaseRow
                  phase={phase}
                  isSelected={phase.index === (props.selectedPhaseIndex ?? -1)}
                  timer={timer}
                  theme={themeCtx.theme}
                />
              )}
            </For>
          </scrollbox>
        </Show>
      </box>
    </Show>
  )
}

// ---------------------------------------------------------------------------
// PhaseRow — detailed phase entry with duration, spinner, errors
// ---------------------------------------------------------------------------

interface PhaseRowProps {
  phase: PhaseState
  isSelected: boolean
  timer: ReturnType<typeof useTimer>
  theme: Theme
}

function PhaseRow(props: PhaseRowProps) {
  const color = () =>
    props.phase.error
      ? props.theme.error
      : getStatusColor(props.phase.status, props.theme)

  const duration = () => {
    if (props.phase.duration !== undefined) {
      if (props.phase.duration < 1 && props.phase.status === "completed") {
        return "done"
      }
      const s = Math.max(0, Math.floor(props.phase.duration))
      const m = Math.floor(s / 60)
      const sec = s % 60
      return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`
    }
    if (props.phase.status === "running") {
      return props.timer.agentDuration(`phase-${props.phase.index}`)
    }
    return ""
  }

  const selectionPrefix = () => (props.isSelected ? "> " : "  ")

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" overflow="hidden">
        <text wrapMode="none" fg={props.theme.text}>
          {selectionPrefix()}
        </text>
        <Show
          when={props.phase.status === "running"}
          fallback={
            <text wrapMode="none" fg={color()}>
              {getStatusIcon(props.phase.status)}{" "}
            </text>
          }
        >
          <Spinner color={color()} />
          <text wrapMode="none"> </text>
        </Show>
        <text wrapMode="none" fg={props.theme.text} attributes={1}>
          {truncate(props.phase.name, 22)}
        </text>
        <Show when={duration()}>
          <text wrapMode="none" fg={props.theme.textMuted}>
            {" "}
            &bull; {duration()}
          </text>
        </Show>
      </box>
      <Show when={props.phase.error}>
        <box paddingLeft={4}>
          <text fg={props.theme.error}>{"\u2717"} {props.phase.error}</text>
        </box>
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(text: string, maxLen: number): string {
  if (maxLen < 4) return text.slice(0, maxLen)
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + "\u2026"
}

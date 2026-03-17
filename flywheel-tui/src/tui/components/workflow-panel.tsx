/** @jsxImportSource @opentui/solid */
/**
 * Workflow Panel — Right-side collapsible info panel
 *
 * Displays contextual workflow information in the right column:
 *   - Session state (lifecycle, name)
 *   - Workflow progress (phases completed / total)
 *   - Next valid actions
 *   - Aggregate session cost (if tracked)
 *
 * Collapses automatically when terminal width < 120 columns
 * (handled by SharedLayout, which controls visibility).
 *
 * Toggle: Ctrl+P or via keybind passed from parent.
 */

import { Show, For } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import { computeProgress, statusLabel } from "./workflow-panel-logic"
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
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WorkflowPanel(props: WorkflowPanelProps) {
  const themeCtx = useTheme()
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
              {truncate(props.state.planName, 22)}
            </text>
          </box>
        </Show>

        {/* Phase list (compact) */}
        <Show when={props.state.phases.length > 0}>
          <box flexDirection="column" paddingLeft={1} paddingRight={1} marginTop={1} flexGrow={1}>
            <text fg={themeCtx.theme.textMuted} attributes={1}>
              {label()}s
            </text>
            <For each={props.state.phases}>
              {(phase) => (
                <box>
                  <text fg={phaseColor(phase.status, themeCtx.theme)}>
                    {phaseIcon(phase.status)} {truncate(phase.name, 20)}
                  </text>
                </box>
              )}
            </For>
          </box>
        </Show>
      </box>
    </Show>
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

function phaseIcon(status: PhaseState["status"]): string {
  switch (status) {
    case "pending":   return "\u25cb" // ○
    case "running":   return "\u25d3" // ◓
    case "completed": return "\u25cf" // ●
    case "failed":    return "\u2717" // ✗
    case "skipped":   return "\u2013" // –
    default:          return "\u25cb"
  }
}

function phaseColor(status: PhaseState["status"], theme: Record<string, any>): string {
  switch (status) {
    case "running":   return theme.info
    case "completed": return theme.success
    case "failed":    return theme.error
    case "skipped":   return theme.textMuted
    default:          return theme.text
  }
}

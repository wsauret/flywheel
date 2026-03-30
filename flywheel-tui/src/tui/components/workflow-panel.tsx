/** @jsxImportSource @opentui/solid */
/**
 * Workflow Panel — Right-side panel showing queue step progress
 *
 * Shows:
 *   - Workflow status and aggregate progress
 *   - Plan name
 *   - Scrollable queue step list with status icons, types, titles
 *   - Running step highlighted with animated spinner
 *   - Failed steps show error message below
 *   - Progress summary "Steps: X/Y"
 *
 * Collapses automatically when terminal width < 120 columns
 * (handled by SharedLayout, which controls visibility).
 */

import { Show, For, createMemo, createEffect, createSignal } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import { useTimer } from "@tui/shared/services"
import { Spinner } from "@tui/shared/components/spinner"
import {
  computeQueueProgress,
  statusLabel,
  getStepStatusIcon,
  getStepTypeLabel,
} from "./workflow-panel-logic"
import { truncate } from "../utils/text"
import type { Theme } from "@tui/shared/context/theme"
import type { WorkState, QueueStepState } from "../routes/work/state/types"

// Re-export pure logic for consumers
export {
  computeQueueProgress,
  statusLabel,
  getStepStatusIcon,
  getStepTypeLabel,
  type PanelProgress,
} from "./workflow-panel-logic"

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface WorkflowPanelProps {
  /** Current workflow state from the store. */
  state: WorkState
  /** Whether the panel is collapsed (hidden by user). */
  collapsed?: boolean
  /** Step label override (e.g., "Step", "Cycle"). */
  stepLabel?: string
  /** Index of the currently selected step (for keyboard navigation). */
  selectedStepIndex?: number
  /**
   * Direct reactive queue steps override.
   *
   * When provided, this signal-backed accessor is used instead of
   * props.state.queueSteps for all panel rendering. This bypasses the
   * store → workState signal chain which can break SolidJS fine-grained
   * reactivity for nested array properties at runtime.
   *
   * The shell maintains this as a dedicated signal updated directly from
   * event bus subscriptions, matching the proven pattern used by
   * activeQueueInfo (telemetry bar).
   */
  queueSteps?: QueueStepState[]
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WorkflowPanel(props: WorkflowPanelProps) {
  const themeCtx = useTheme()
  const timer = useTimer()
  const label = () => props.stepLabel ?? "Step"

  // Use the direct reactive override when it has steps (fixes SolidJS reactivity
  // for nested array properties that break through the store → workState chain).
  // Length-check instead of ?? so empty [] from shell cleanup falls through to
  // the store's queue steps (which are populated for historical sessions).
  const queueSteps = () =>
    (props.queueSteps && props.queueSteps.length > 0)
      ? props.queueSteps
      : props.state.queueSteps

  const hasQueueSteps = () => queueSteps().length > 0
  const progress = () => computeQueueProgress(queueSteps())

  const statusColor = () => {
    switch (props.state.workflowStatus) {
      case "running":     return themeCtx.theme.info
      case "completed":   return themeCtx.theme.success
      case "failed":      return themeCtx.theme.error
      case "interrupted": return themeCtx.theme.warning
      default:            return themeCtx.theme.textMuted
    }
  }

  // Track the index of the running step for auto-scroll
  const runningIndex = createMemo(() => {
    const steps = queueSteps()
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].status === "running") return i
    }
    return -1
  })

  // Scrollbox ref for auto-scroll
  const [scrollboxRef, setScrollboxRef] = createSignal<any>(null)

  // Auto-scroll to running step when it changes
  createEffect(() => {
    const idx = runningIndex()
    const ref = scrollboxRef()
    if (idx >= 0 && ref && typeof ref.scrollTo === "function") {
      // Each step row is ~2 lines tall (title + optional error)
      ref.scrollTo(0, Math.max(0, idx * 2 - 2))
    }
  })

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

        {/* Progress summary — "Steps: X/Y" */}
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

        {/* ── Queue step list (scrollable) ── */}
        <Show
          when={hasQueueSteps()}
          fallback={
            <box paddingLeft={1} marginTop={1}>
              <text fg={themeCtx.theme.textMuted}>No steps yet.</text>
            </box>
          }
        >
          <box paddingLeft={1} paddingRight={1} marginTop={1} flexShrink={0}>
            <text fg={themeCtx.theme.textMuted} attributes={1}>
              {label()}s
            </text>
          </box>

          <scrollbox
            ref={setScrollboxRef}
            flexGrow={1}
            scrollbarOptions={{ visible: false }}
            viewportCulling={true}
          >
            <For each={queueSteps()}>
              {(step) => (
                <QueueStepRow
                  step={step}
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
// QueueStepRow — single step entry with status icon, type, title, error
// ---------------------------------------------------------------------------

interface QueueStepRowProps {
  step: QueueStepState
  timer: ReturnType<typeof useTimer>
  theme: Theme
}

function QueueStepRow(props: QueueStepRowProps) {
  const stepColor = () => {
    switch (props.step.status) {
      case "completed": return props.theme.success
      case "running":   return props.theme.info
      case "failed":    return props.theme.error
      case "skipped":   return props.theme.textMuted
      default:          return props.theme.text
    }
  }

  const duration = () => {
    if (props.step.duration !== undefined) {
      if (props.step.duration < 1 && props.step.status === "completed") {
        return "done"
      }
      const s = Math.max(0, Math.floor(props.step.duration))
      const m = Math.floor(s / 60)
      const sec = s % 60
      return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`
    }
    if (props.step.status === "running") {
      return props.timer.agentDuration(`queue-step-${props.step.id}`)
    }
    return ""
  }

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" overflow="hidden">
        <Show
          when={props.step.status === "running"}
          fallback={
            <text wrapMode="none" fg={stepColor()}>
              {getStepStatusIcon(props.step.status)}{" "}
            </text>
          }
        >
          <Spinner color={stepColor()} />
          <text wrapMode="none"> </text>
        </Show>
        <text wrapMode="none" fg={props.theme.textMuted}>
          {getStepTypeLabel(props.step.type)}{" "}
        </text>
        <text wrapMode="none" fg={props.theme.text} attributes={props.step.status === "running" ? 1 : 0}>
          {truncate(props.step.title, 22)}
        </text>
        <Show when={duration()}>
          <text wrapMode="none" fg={props.theme.textMuted}>
            {" "}&bull; {duration()}
          </text>
        </Show>
      </box>
      <Show when={props.step.error}>
        <box paddingLeft={3}>
          <text fg={props.theme.error}>{"\u2717"} {props.step.error}</text>
        </box>
      </Show>
    </box>
  )
}



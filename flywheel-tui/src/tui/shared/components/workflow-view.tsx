/** @jsxImportSource @opentui/solid */
/**
 * WorkflowView Component
 *
 * Generalized split-view layout for any workflow:
 * - Phase/step progress panel (left, collapsible via Tab)
 * - Output window with prompt line (right, shown when terminal is wide enough)
 *
 * Subscribes to the UI store and wires keyboard/events.
 * Used by WorkShell (work workflow) and future workflow views (plan, review, debug).
 */

import { createSignal, createEffect, onCleanup, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { SharedLayout } from "../../routes/work/components/shared-layout"
import { PhaseProgress } from "../../routes/work/components/phase-progress"
import { OutputWindow, type CurrentPhaseInfo } from "../../routes/work/components/output-window"
import { useWorkKeyboard } from "../../routes/work/hooks/use-work-keyboard"
import { useTimer } from "@tui/shared/services"
import type { UIActions } from "../../routes/work/context/ui-state/types"
import type { WorkState } from "../../routes/work/state/types"

const MIN_WIDTH_FOR_SPLIT_VIEW = 100

export interface WorkflowViewProps {
  store: UIActions
  stepLabel?: string          // "Phase" | "Step" | "Cycle" — defaults to "Phase"
  workflowName?: string       // shown in TelemetryBar
  onStop?: () => void
  onApprovalDecision?: (approved: boolean, skip?: boolean) => void
  onPromptSubmit?: (prompt: string) => void
  onSkip?: () => void
  onToggleRawMode?: () => void
}

export function WorkflowView(props: WorkflowViewProps) {
  const dimensions = useTerminalDimensions()
  const timer = useTimer()
  const [state, setState] = createSignal<WorkState>(props.store.getState())
  const [showStopModal, setShowStopModal] = createSignal(false)
  const [isPromptFocused, setIsPromptFocused] = createSignal(false)
  const [timelineCollapsed, setTimelineCollapsed] = createSignal(false)

  // Subscribe to store updates
  createEffect(() => {
    const unsub = props.store.subscribe(() => setState(props.store.getState()))
    onCleanup(unsub)
  })

  // Auto-focus prompt when approval is pending
  createEffect(() => {
    if (state().approvalState.pending) {
      setIsPromptFocused(true)
    }
  })

  // Keyboard + event wiring
  useWorkKeyboard({
    actions: props.store,
    showStopModal,
    setShowStopModal,
    state,
    timelineCollapsed,
    setTimelineCollapsed,
    isPromptFocused,
    setIsPromptFocused,
    onSkip: props.onSkip,
    onToggleRawMode: props.onToggleRawMode,
  })

  const showSplit = () => (dimensions()?.width ?? 80) >= MIN_WIDTH_FOR_SPLIT_VIEW
  const timelineWidth = () => (showSplit() ? "35%" : "100%")
  const outputWidth = () => (timelineCollapsed() ? "100%" : "65%")
  const runtime = () => timer.workflowRuntime()

  // Derive current phase for the rich output header
  const currentPhase = (): CurrentPhaseInfo | null => {
    const phases = state().phases
    // Prefer the running phase
    const running = phases.find((p) => p.status === "running")
    if (running) {
      return { index: running.index, name: running.name, status: running.status }
    }
    // Fall back to the last completed/failed phase
    for (let i = phases.length - 1; i >= 0; i--) {
      const p = phases[i]
      if (p.status === "completed" || p.status === "failed") {
        return { index: p.index, name: p.name, status: p.status }
      }
    }
    return null
  }

  const handlePromptSubmit = (prompt: string) => {
    if (state().approvalState.pending) {
      // Enter with empty prompt = continue approval
      // Enter with text = steer (submit prompt, then continue)
      if (prompt) {
        props.onPromptSubmit?.(prompt)
      }
      props.onApprovalDecision?.(true)
      props.store.clearApproval()
    } else {
      // Not in approval state — submit as steering prompt
      if (prompt) {
        props.onPromptSubmit?.(prompt)
      }
    }
  }

  return (
    <SharedLayout
      state={state()}
      runtime={runtime()}
      showStopModal={showStopModal()}
      showApprovalGate={false}
      showErrorModal={!!state().error && state().workflowStatus === "failed"}
      errorMessage={state().error}
      approvalPending={state().approvalState.pending}
      isPromptFocused={isPromptFocused()}
      workflowLabel={props.workflowName}
      stepLabel={props.stepLabel}
      onStopConfirm={() => {
        setShowStopModal(false)
        props.onStop?.()
      }}
      onStopCancel={() => setShowStopModal(false)}
      onApprovalContinue={() => {
        props.onApprovalDecision?.(true)
        props.store.clearApproval()
      }}
      onApprovalReject={() => {
        props.onApprovalDecision?.(false)
        props.store.clearApproval()
      }}
      onApprovalSkip={() => {
        props.onApprovalDecision?.(false, true)
        props.store.clearApproval()
      }}
      onErrorClose={() => {}}
    >
      <Show when={!timelineCollapsed()}>
        <box flexDirection="column" width={timelineWidth()}>
          <PhaseProgress
            phases={state().phases}
            selectedIndex={state().selectedPhaseIndex}
            stepLabel={props.stepLabel}
          />
        </box>
      </Show>

      <Show when={showSplit() || timelineCollapsed()}>
        <box flexDirection="column" width={outputWidth()}>
          <OutputWindow
            outputLines={state().outputLines}
            workflowStatus={state().workflowStatus}
            approvalPending={state().approvalState.pending}
            isPromptFocused={isPromptFocused()}
            onPromptSubmit={handlePromptSubmit}
            onPromptFocusExit={() => setIsPromptFocused(false)}
            availableWidth={dimensions()?.width}
            currentPhase={currentPhase()}
          />
        </box>
      </Show>
    </SharedLayout>
  )
}

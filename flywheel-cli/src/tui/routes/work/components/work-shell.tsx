/** @jsxImportSource @opentui/solid */
/**
 * Work Shell Component
 *
 * Main content split view:
 * - Phase progress panel (left, collapsible via Tab)
 * - Output window with prompt line (right, shown when terminal is wide enough)
 *
 * Subscribes to the UI store and wires keyboard/events.
 */

import { createSignal, createEffect, onCleanup, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { SharedLayout } from "./shared-layout"
import { PhaseProgress } from "./phase-progress"
import { OutputWindow, type CurrentPhaseInfo } from "./output-window"
import { useWorkKeyboard } from "../hooks/use-work-keyboard"
import { useTimer } from "@tui/shared/services"
import type { UIActions } from "../context/ui-state/types"
import type { WorkState } from "../state/types"

const MIN_WIDTH_FOR_SPLIT_VIEW = 100

export interface WorkShellProps {
  actions: UIActions
  onApprovalDecision?: (approved: boolean, skip?: boolean) => void
  onStop?: () => void
  onPromptSubmit?: (prompt: string) => void
  onSkip?: () => void
  onToggleRawMode?: () => void
}

export function WorkShell(props: WorkShellProps) {
  const dimensions = useTerminalDimensions()
  const timer = useTimer()
  const [state, setState] = createSignal<WorkState>(props.actions.getState())
  const [showStopModal, setShowStopModal] = createSignal(false)
  const [isPromptFocused, setIsPromptFocused] = createSignal(false)
  const [timelineCollapsed, setTimelineCollapsed] = createSignal(false)

  // Subscribe to store updates
  createEffect(() => {
    const unsub = props.actions.subscribe(() => setState(props.actions.getState()))
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
    actions: props.actions,
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
      props.actions.clearApproval()
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
      onStopConfirm={() => {
        setShowStopModal(false)
        props.onStop?.()
      }}
      onStopCancel={() => setShowStopModal(false)}
      onApprovalContinue={() => {
        props.onApprovalDecision?.(true)
        props.actions.clearApproval()
      }}
      onApprovalReject={() => {
        props.onApprovalDecision?.(false)
        props.actions.clearApproval()
      }}
      onApprovalSkip={() => {
        props.onApprovalDecision?.(false, true)
        props.actions.clearApproval()
      }}
      onErrorClose={() => {}}
    >
      <Show when={!timelineCollapsed()}>
        <box flexDirection="column" width={timelineWidth()}>
          <PhaseProgress
            phases={state().phases}
            selectedIndex={state().selectedPhaseIndex}
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

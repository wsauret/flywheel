/** @jsxImportSource @opentui/solid */
/**
 * WorkflowView Component
 *
 * Layout: sidebar (left) | output window (center) | workflow panel (right)
 *
 * The workflow panel on the right contains both summary stats and the
 * detailed phase timeline (merged from the former PhaseProgress component).
 * The output window gets the full center width.
 *
 * Subscribes to the UI store and wires keyboard/events.
 * Used by WorkShell (work workflow) and future workflow views (plan, review, debug).
 */

import { createSignal, createEffect, createMemo, onCleanup } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { SharedLayout } from "../../routes/work/components/shared-layout"
import { OutputWindow, type CurrentPhaseInfo } from "../../routes/work/components/output-window"
import { useWorkKeyboard } from "../../routes/work/hooks/use-work-keyboard"
import { useTimer } from "@tui/shared/services"
import { useSession } from "@tui/shared/context/session"
import { SessionSidebar } from "../../components/session-sidebar"
import { WorkflowPanel } from "../../components/workflow-panel"
import { SessionHeader } from "../../components/session-header"
import { SIDEBAR_WIDTH } from "../../components/shell-modes"
import type { UIActions } from "../../routes/work/context/ui-state/types"
import type { WorkState } from "../../routes/work/state/types"

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
  const sessionCtx = useSession()
  const [state, setState] = createSignal<WorkState>(props.store.getState())
  const [showStopModal, setShowStopModal] = createSignal(false)
  const [isPromptFocused, setIsPromptFocused] = createSignal(false)

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

  // Keyboard + event wiring (timelineCollapsed no longer used but hook still accepts it)
  const [_unused, _setUnused] = createSignal(false)
  useWorkKeyboard({
    actions: props.store,
    showStopModal,
    setShowStopModal,
    state,
    timelineCollapsed: _unused,
    setTimelineCollapsed: _setUnused,
    isPromptFocused,
    setIsPromptFocused,
    onSkip: props.onSkip,
    onToggleRawMode: props.onToggleRawMode,
  })

  const runtime = () => timer.workflowRuntime()

  // Derive current phase for the rich output header (memoized to avoid linear scan on every access)
  const currentPhase = createMemo((): CurrentPhaseInfo | null => {
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
  })

  const handlePromptSubmit = (prompt: string) => {
    if (state().approvalState.pending) {
      if (prompt) {
        props.onPromptSubmit?.(prompt)
      }
      props.onApprovalDecision?.(true)
      props.store.clearApproval()
    } else {
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
      showApprovalGate={state().approvalState.pending}
      showErrorModal={!!state().error && state().workflowStatus === "failed"}
      errorMessage={state().error}
      approvalPending={state().approvalState.pending}
      isPromptFocused={isPromptFocused()}
      workflowLabel={props.workflowName}
      stepLabel={props.stepLabel}
      header={
        <SessionHeader
          info={{
            sessionName: state().planName,
            planName: state().planName,
            workflowStatus: state().workflowStatus,
            currentPhase: currentPhase()?.name,
          }}
          version={state().version}
        />
      }
      sidebar={
        <SessionSidebar
          sessions={sessionCtx.sessions()}
          terminalWidth={dimensions()?.width}
          width={SIDEBAR_WIDTH}
        />
      }
      panel={
        <WorkflowPanel
          state={state()}
          stepLabel={props.stepLabel}
          selectedPhaseIndex={state().selectedPhaseIndex}
        />
      }
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
        props.onApprovalDecision?.(true, true)
        props.store.clearApproval()
      }}
      onErrorClose={() => props.store.clearError()}
    >
      {/* Output window takes full center width */}
      <box flexDirection="column" width="100%">
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
    </SharedLayout>
  )
}

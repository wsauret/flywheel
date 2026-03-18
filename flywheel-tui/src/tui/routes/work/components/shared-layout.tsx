/** @jsxImportSource @opentui/solid */
/**
 * Shared Layout Component
 *
 * Three-column layout skeleton:
 *   - Left sidebar (optional, 25 cols, hidden below 90 cols)
 *   - Center content area (flex-grow)
 *   - Right panel (optional, 30 cols, hidden below 120 cols)
 *
 * Plus:
 *   - Header slot (BrandingHeader by default, SessionHeader when active)
 *   - Telemetry bar + status footer at bottom
 *   - Modal overlays (approval gate, stop, error)
 */

import { Show, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { BrandingHeader } from "@tui/shared/components/layout/branding-header"
import { TelemetryBar } from "./telemetry-bar"
import { StatusFooter } from "./status-footer"
import { StopModal } from "./modals/stop-modal"
import { ErrorModal } from "./modals/error-modal"
import { ApprovalGate } from "./modals/approval-gate"
import {
  layoutVisibility,
  SIDEBAR_WIDTH,
  PANEL_WIDTH,
} from "../../../components/shell-modes"
import type { WorkState } from "../state/types"

export interface SharedLayoutProps {
  state: WorkState
  runtime: string
  showStopModal: boolean
  showApprovalGate: boolean
  showErrorModal: boolean
  errorMessage?: string
  approvalPending?: boolean
  isPromptFocused?: boolean
  workflowLabel?: string  // "work" | "plan" | "review" etc.
  stepLabel?: string      // "Phase" | "Step" | "Cycle"
  onStopConfirm: () => void
  onStopCancel: () => void
  onApprovalContinue: () => void
  onApprovalReject: () => void
  onApprovalSkip: () => void
  onErrorClose: () => void
  /** Optional header to replace BrandingHeader (e.g., SessionHeader). */
  header?: JSX.Element
  /** Optional left sidebar slot (e.g., SessionSidebar). */
  sidebar?: JSX.Element
  /** Optional right panel slot (e.g., WorkflowPanel). */
  panel?: JSX.Element
  children: JSX.Element
}

export function SharedLayout(props: SharedLayoutProps) {
  const dimensions = useTerminalDimensions()

  const termWidth = () => dimensions()?.width ?? 120

  const visibility = () => layoutVisibility(termWidth())

  const runningPhaseIndex = () => {
    const running = props.state.phases.findIndex((p) => p.status === "running")
    if (running >= 0) return running + 1
    // Fall back to last completed/failed/skipped phase
    for (let i = props.state.phases.length - 1; i >= 0; i--) {
      if (props.state.phases[i].status !== "pending") return i + 1
    }
    return 0
  }

  return (
    <box flexDirection="column" height="100%">
      {/* Header: custom header slot or default BrandingHeader */}
      <box flexShrink={0}>
        <Show
          when={props.header}
          fallback={
            <BrandingHeader
              version={props.state.version}
              currentDir={props.state.planName}
            />
          }
        >
          {props.header}
        </Show>
      </box>

      {/* Three-column content area */}
      <box flexDirection="row" flexGrow={1} gap={1}>
        {/* Left sidebar — hidden below MIN_WIDTH_SIDEBAR */}
        <Show when={props.sidebar && visibility().showSidebar}>
          <box flexShrink={0} width={SIDEBAR_WIDTH} overflow="hidden">
            {props.sidebar}
          </box>
        </Show>

        {/* Center content */}
        <box flexDirection="row" flexGrow={1} gap={1}>
          {props.children}
        </box>

        {/* Right panel — hidden below MIN_WIDTH_PANEL */}
        <Show when={props.panel && visibility().showPanel}>
          <box flexShrink={0} width={PANEL_WIDTH} overflow="hidden">
            {props.panel}
          </box>
        </Show>
      </box>

      <box flexShrink={0} flexDirection="column">
        <TelemetryBar
          planName={props.state.planName}
          runtime={props.runtime}
          status={props.state.workflowStatus}
          currentPhase={runningPhaseIndex()}
          totalPhases={props.state.phases.length}
          workflowLabel={props.workflowLabel}
          stepLabel={props.stepLabel}
        />
        <StatusFooter
          approvalPending={props.approvalPending}
          isPromptFocused={props.isPromptFocused}
        />
      </box>

      <Show when={props.showApprovalGate}>
        <ApprovalGate
          description={props.state.approvalState.description}
          onContinue={props.onApprovalContinue}
          onReject={props.onApprovalReject}
          onSkip={props.onApprovalSkip}
        />
      </Show>

      <Show when={props.showStopModal}>
        <StopModal
          onConfirm={props.onStopConfirm}
          onCancel={props.onStopCancel}
        />
      </Show>

      <Show when={props.showErrorModal}>
        <ErrorModal
          message={props.errorMessage!}
          onClose={props.onErrorClose}
        />
      </Show>
    </box>
  )
}

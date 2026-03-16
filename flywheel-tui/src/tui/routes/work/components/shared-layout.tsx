/** @jsxImportSource @opentui/solid */
/**
 * Shared Layout Component
 *
 * Main layout skeleton providing:
 * - Branding header
 * - Content area (children)
 * - Telemetry bar + status footer
 * - Modal overlays (approval gate, stop, error)
 */

import { Show, type JSX } from "solid-js"
import { BrandingHeader } from "@tui/shared/components/layout/branding-header"
import { TelemetryBar } from "./telemetry-bar"
import { StatusFooter } from "./status-footer"
import { StopModal } from "./modals/stop-modal"
import { ErrorModal } from "./modals/error-modal"
import { ApprovalGate } from "./modals/approval-gate"
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
  children: JSX.Element
}

export function SharedLayout(props: SharedLayoutProps) {
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
      <box flexShrink={0}>
        <BrandingHeader
          version={props.state.version}
          currentDir={props.state.planName}
        />
      </box>

      <box flexDirection="row" flexGrow={1} gap={1}>
        {props.children}
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

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
 *   - Modal overlays (approval gate, stop, error)
 */

import { Show, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { BrandingHeader } from "@tui/shared/components/layout/branding-header"

import { StopModal } from "./modals/stop-modal"
import { ErrorModal } from "./modals/error-modal"
import { ApprovalGate } from "./modals/approval-gate"
import {
  layoutVisibility,
  SIDEBAR_WIDTH,
  PANEL_WIDTH,
} from "../../../shell/shell-modes"
import type { WorkState } from "../state/types"
export interface SharedLayoutProps {
  state: WorkState
  showStopModal: boolean
  showApprovalGate: boolean
  showErrorModal: boolean
  errorMessage?: string
  approvalPending?: boolean
  isPromptFocused?: boolean
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

  return (
    <box flexDirection="column" height="100%" zIndex={0}>
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

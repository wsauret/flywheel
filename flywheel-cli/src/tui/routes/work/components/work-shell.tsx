/** @jsxImportSource @opentui/solid */
/**
 * Work Shell Component
 *
 * Thin wrapper around WorkflowView for the "work" workflow.
 * Defaults stepLabel to "Phase" and workflowName to "work".
 */

import { WorkflowView } from "@tui/shared/components/workflow-view"
import type { UIActions } from "../context/ui-state/types"

export interface WorkShellProps {
  actions: UIActions
  onApprovalDecision?: (approved: boolean, skip?: boolean) => void
  onStop?: () => void
  onPromptSubmit?: (prompt: string) => void
  onSkip?: () => void
  onToggleRawMode?: () => void
}

export function WorkShell(props: WorkShellProps) {
  return (
    <WorkflowView
      store={props.actions}
      stepLabel="Phase"
      workflowName="work"
      onStop={props.onStop}
      onApprovalDecision={props.onApprovalDecision}
      onPromptSubmit={props.onPromptSubmit}
      onSkip={props.onSkip}
      onToggleRawMode={props.onToggleRawMode}
    />
  )
}

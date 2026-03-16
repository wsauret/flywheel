/** @jsxImportSource @opentui/solid */
/**
 * Approval Gate Actions Component
 *
 * Continue/Reject/Skip buttons with selection state.
 */

import { useTheme } from "@tui/shared/context/theme"

export type ApprovalGateButtonType = "continue" | "reject" | "skip"

export interface ApprovalGateActionsProps {
  selectedButton: ApprovalGateButtonType
  onContinue: () => void
  onReject: () => void
  onSkip: () => void
}

export function ApprovalGateActions(props: ApprovalGateActionsProps) {
  const themeCtx = useTheme()

  return (
    <box paddingTop={1} gap={4} flexDirection="row">
      <box
        backgroundColor={props.selectedButton === "continue" ? themeCtx.theme.success : undefined}
        paddingLeft={1}
        paddingRight={1}
        onMouseDown={props.onContinue}
      >
        <text
          fg={props.selectedButton === "continue" ? themeCtx.theme.background : themeCtx.theme.success}
          attributes={1}
        >
          {props.selectedButton === "continue" ? "> " : "  "}[C]ontinue
        </text>
      </box>
      <box
        backgroundColor={props.selectedButton === "reject" ? themeCtx.theme.error : undefined}
        paddingLeft={1}
        paddingRight={1}
        onMouseDown={props.onReject}
      >
        <text fg={props.selectedButton === "reject" ? themeCtx.theme.background : themeCtx.theme.error}>
          {props.selectedButton === "reject" ? "> " : "  "}[R]eject
        </text>
      </box>
      <box
        backgroundColor={props.selectedButton === "skip" ? themeCtx.theme.warning : undefined}
        paddingLeft={1}
        paddingRight={1}
        onMouseDown={props.onSkip}
      >
        <text fg={props.selectedButton === "skip" ? themeCtx.theme.background : themeCtx.theme.warning}>
          {props.selectedButton === "skip" ? "> " : "  "}[S]kip
        </text>
      </box>
    </box>
  )
}

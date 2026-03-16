/** @jsxImportSource @opentui/solid */
/**
 * Approval Gate Modal
 *
 * Pauses execution for user review with Continue/Reject/Skip actions.
 * Supports keyboard navigation and direct key shortcuts.
 */

import { createSignal } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/shared/context/theme"
import { ModalBase, ModalHeader, ModalFooter } from "@tui/shared/components/modal"
import { ApprovalGateContent } from "./approval-gate-content"
import { ApprovalGateActions, type ApprovalGateButtonType } from "./approval-gate-actions"

export interface ApprovalGateProps {
  description?: string
  onContinue: () => void
  onReject: () => void
  onSkip: () => void
}

export function ApprovalGate(props: ApprovalGateProps) {
  const themeCtx = useTheme()
  const dimensions = useTerminalDimensions()
  const [selectedButton, setSelectedButton] = createSignal<ApprovalGateButtonType>("continue")

  const modalWidth = () => Math.min(Math.max(40, (dimensions()?.width ?? 80) - 8), 80)

  useKeyboard((evt) => {
    if (evt.name === "left" || evt.name === "right") {
      evt.preventDefault()
      // Cycle through: continue -> reject -> skip -> continue
      setSelectedButton((prev) => {
        if (evt.name === "right") {
          if (prev === "continue") return "reject"
          if (prev === "reject") return "skip"
          return "continue"
        }
        // left
        if (prev === "continue") return "skip"
        if (prev === "skip") return "reject"
        return "continue"
      })
      return
    }

    if (evt.name === "return") {
      evt.preventDefault()
      const btn = selectedButton()
      if (btn === "continue") props.onContinue()
      else if (btn === "reject") props.onReject()
      else props.onSkip()
      return
    }

    if (evt.name === "c") {
      evt.preventDefault()
      props.onContinue()
      return
    }
    if (evt.name === "r") {
      evt.preventDefault()
      props.onReject()
      return
    }
    if (evt.name === "s") {
      evt.preventDefault()
      props.onSkip()
      return
    }
  })

  return (
    <ModalBase width={modalWidth()}>
      <ModalHeader
        title="APPROVAL GATE - Review Required"
        icon="#"
        iconColor={themeCtx.theme.warning}
      />
      <ApprovalGateContent reason={props.description} modalWidth={modalWidth()} />
      <ApprovalGateActions
        selectedButton={selectedButton()}
        onContinue={props.onContinue}
        onReject={props.onReject}
        onSkip={props.onSkip}
      />
      <ModalFooter shortcuts="[Left/Right] Navigate  [ENTER] Confirm  [C]ontinue / [R]eject / [S]kip" />
    </ModalBase>
  )
}

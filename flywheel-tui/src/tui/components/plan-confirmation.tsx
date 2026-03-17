/** @jsxImportSource @opentui/solid */
/**
 * Plan Confirmation Component
 *
 * Displays a plan summary (phases, steps, acceptance criteria, issues)
 * and offers Approve / Edit actions. Rendered inside a ModalBase overlay.
 *
 * Pure logic (data preparation, action defs, types) lives in
 * `./plan-confirmation-logic.ts` for testability.
 */

import { For, Show, createSignal } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import { useKeyboard } from "@opentui/solid"
import { ModalBase } from "@tui/shared/components/modal/modal-base"
import type { PlanImportResult } from "../../controller/plan-import"
import {
  preparePlanSummary,
  PLAN_ACTIONS,
  type PlanAction,
  type PlanSummaryDisplay,
} from "./plan-confirmation-logic"

// Re-export for consumers
export {
  preparePlanSummary,
  PLAN_ACTIONS,
  type PlanAction,
  type PlanSummaryDisplay,
  type PhaseSummaryItem,
  type PlanActionDef,
} from "./plan-confirmation-logic"

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PlanConfirmationProps {
  plan: PlanImportResult
  onApprove: () => void
  onEdit: () => void
  onClose?: () => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PlanConfirmation(props: PlanConfirmationProps) {
  const theme = useTheme()
  const summary = () => preparePlanSummary(props.plan)
  const [selectedAction, setSelectedAction] = createSignal(0)

  // Keyboard navigation for action buttons
  useKeyboard((event) => {
    switch (event.name) {
      case "left":
        setSelectedAction((prev) => Math.max(0, prev - 1))
        break
      case "right":
        setSelectedAction((prev) =>
          Math.min(PLAN_ACTIONS.length - 1, prev + 1)
        )
        break
      case "return": {
        const action = PLAN_ACTIONS[selectedAction()]
        if (action?.value === "approve") props.onApprove()
        else if (action?.value === "edit") props.onEdit()
        break
      }
      case "escape":
        props.onClose?.()
        break
    }
  })

  return (
    <ModalBase width={70} onClose={props.onClose}>
      <box flexDirection="column">
        {/* Title */}
        <box marginBottom={1}>
          <text fg={theme.theme.primary} attributes={1}>
            Plan Review
          </text>
        </box>

        {/* Status indicator */}
        <box marginBottom={1}>
          <text
            fg={
              summary().status === "ready"
                ? theme.theme.success
                : theme.theme.warning
            }
          >
            Status: {summary().status === "ready" ? "Ready" : "Needs Fix"}
          </text>
        </box>

        {/* Summary stats */}
        <box flexDirection="row" marginBottom={1} gap={3}>
          <text fg={theme.theme.text}>
            {summary().phaseCount} phase{summary().phaseCount !== 1 ? "s" : ""}
          </text>
          <text fg={theme.theme.text}>
            {summary().totalSteps} step{summary().totalSteps !== 1 ? "s" : ""}
          </text>
          <text
            fg={
              summary().hasAcceptanceCriteria
                ? theme.theme.success
                : theme.theme.warning
            }
          >
            Acceptance criteria:{" "}
            {summary().hasAcceptanceCriteria ? "Yes" : "Missing"}
          </text>
        </box>

        {/* Phase list */}
        <Show when={summary().phases.length > 0}>
          <box flexDirection="column" marginBottom={1}>
            <text fg={theme.theme.textMuted} attributes={1}>
              Phases
            </text>
            <For each={summary().phases}>
              {(phase, i) => (
                <box paddingLeft={1}>
                  <text fg={theme.theme.text}>
                    {i() + 1}. {phase.title}
                  </text>
                  <text fg={theme.theme.textMuted}>
                    {" "}
                    ({phase.stepCount} step{phase.stepCount !== 1 ? "s" : ""})
                  </text>
                </box>
              )}
            </For>
          </box>
        </Show>

        {/* Issues */}
        <Show when={summary().issues.length > 0}>
          <box flexDirection="column" marginBottom={1}>
            <text fg={theme.theme.warning} attributes={1}>
              Issues
            </text>
            <For each={summary().issues}>
              {(issue) => (
                <box paddingLeft={1}>
                  <text fg={theme.theme.warning}>• {issue}</text>
                </box>
              )}
            </For>
          </box>
        </Show>

        {/* Action buttons */}
        <box flexDirection="row" gap={2} marginTop={1}>
          <For each={PLAN_ACTIONS}>
            {(action, i) => {
              const isSelected = () => selectedAction() === i()
              return (
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={
                    isSelected() ? theme.theme.primary : theme.theme.backgroundElement
                  }
                >
                  <text
                    fg={isSelected() ? theme.theme.background : theme.theme.text}
                    attributes={isSelected() ? 1 : 0}
                  >
                    {action.label}
                  </text>
                </box>
              )
            }}
          </For>
        </box>

        {/* Hint */}
        <box marginTop={1}>
          <text fg={theme.theme.textMuted}>
            ←→ select action  enter confirm  esc cancel
          </text>
        </box>
      </box>
    </ModalBase>
  )
}

export default PlanConfirmation

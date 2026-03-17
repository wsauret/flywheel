/**
 * Plan Confirmation — Pure logic & data preparation
 *
 * Exported separately from the JSX component so unit tests can import
 * these without pulling in the OpenTUI/SolidJS JSX runtime.
 */

import type { PlanImportResult } from "../../controller/plan-import"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Action the user can take on a plan confirmation screen */
export type PlanAction = "approve" | "edit"

/** Single phase summary for display */
export interface PhaseSummaryItem {
  title: string
  stepCount: number
}

/** Full plan summary prepared for the confirmation UI */
export interface PlanSummaryDisplay {
  status: "ready" | "needs-fix"
  phases: PhaseSummaryItem[]
  phaseCount: number
  totalSteps: number
  hasAcceptanceCriteria: boolean
  issues: string[]
}

/** Action button definition */
export interface PlanActionDef {
  value: PlanAction
  label: string
  description: string
}

// ---------------------------------------------------------------------------
// Action definitions
// ---------------------------------------------------------------------------

export const PLAN_ACTIONS: PlanActionDef[] = [
  {
    value: "approve",
    label: "Approve",
    description: "Accept this plan and begin execution",
  },
  {
    value: "edit",
    label: "Edit",
    description: "Request changes to the plan (triggers LLM evaluator)",
  },
]

// ---------------------------------------------------------------------------
// Data preparation
// ---------------------------------------------------------------------------

/**
 * Transforms a `PlanImportResult` into a flat display-friendly structure.
 *
 * This pure function extracts what the PlanConfirmation component needs
 * to render: phase list with step counts, acceptance criteria status,
 * issues, and overall status.
 */
export function preparePlanSummary(result: PlanImportResult): PlanSummaryDisplay {
  return {
    status: result.status,
    phases: result.phases.map((phase) => ({
      title: phase.title,
      stepCount: phase.steps.length,
    })),
    phaseCount: result.summary.phaseCount,
    totalSteps: result.summary.totalSteps,
    hasAcceptanceCriteria: result.summary.hasAcceptanceCriteria,
    issues: result.issues,
  }
}

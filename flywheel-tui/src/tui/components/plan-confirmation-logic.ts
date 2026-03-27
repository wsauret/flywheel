/**
 * Plan Confirmation — Pure logic & data preparation
 *
 * Exported separately from the JSX component so unit tests can import
 * these without pulling in the OpenTUI/SolidJS JSX runtime.
 *
 * Supports both JSON plans (steps with acceptance criteria, behavioral
 * contract) and legacy markdown plans (steps with step counts).
 */

import type { PlanImportResult, PlanImportStep } from "../../controller/plan-import"
import type { BehavioralAssertion } from "../../controller/plan-json-parser"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Action the user can take on a plan confirmation screen */
export type PlanAction = "approve" | "edit"

/** Single step summary for display (JSON plans) */
export interface StepSummaryItem {
  title: string
  description: string
  acceptanceCriteria: string[]
  fileReferences?: string[]
  feature?: string
  fulfills?: string[]
  milestone?: string
  estimatedComplexity?: string
}

/** Behavioral assertion summary for display (JSON plans) */
export interface AssertionSummaryItem {
  id: string
  title: string
  description: string
  evidence: string
  area: string
}

/** Full plan summary prepared for the confirmation UI */
export interface PlanSummaryDisplay {
  status: "ready" | "needs-fix"
  /** Legacy markdown steps. Empty for JSON plans. */
  legacySteps: StepSummaryItem[]
  /** JSON plan steps. Empty for markdown plans. */
  steps: StepSummaryItem[]
  /** Behavioral contract assertions. Empty for markdown plans. */
  behavioralContract: AssertionSummaryItem[]
  /** Architectural decisions. */
  decisions: string[]
  /** Identified risks. */
  risks: string[]
  stepCount: number
  totalSteps: number
  hasAcceptanceCriteria: boolean
  issues: string[]
  /** Whether this is a JSON plan. */
  isJsonPlan: boolean
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
 * Maps JSON plan steps, behavioral contract, decisions, and risks.
 */
export function preparePlanSummary(result: PlanImportResult): PlanSummaryDisplay {
  return {
    status: result.status,
    legacySteps: [],
    steps: (result.steps ?? []).map(mapStep),
    behavioralContract: (result.behavioralContract ?? []).map(mapAssertion),
    decisions: result.decisions ?? [],
    risks: result.risks ?? [],
    stepCount: result.summary.stepCount,
    totalSteps: result.summary.totalSteps,
    hasAcceptanceCriteria: result.summary.hasAcceptanceCriteria,
    issues: result.issues,
    isJsonPlan: true,
  }
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapStep(step: PlanImportStep): StepSummaryItem {
  return {
    title: step.title,
    description: step.description,
    acceptanceCriteria: step.acceptanceCriteria,
    fileReferences: step.fileReferences,
    feature: step.feature,
    fulfills: step.fulfills,
    milestone: step.milestone,
    estimatedComplexity: step.estimatedComplexity,
  }
}

function mapAssertion(a: BehavioralAssertion): AssertionSummaryItem {
  return {
    id: a.id,
    title: a.title,
    description: a.description,
    evidence: a.evidence,
    area: a.area,
  }
}

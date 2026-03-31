/**
 * Start Command — Workflow picker logic for /start wizard
 *
 * Pure functions and data for the `/start` guided workflow launcher.
 * The `/start` command collects a description and a workflow type,
 * then builds the appropriate Queue for startQueueExecution().
 *
 * Terminology:
 *   Workflow — named template that generates an initial queue
 *   Step     — single unit of work (replaces "step")
 *   Queue    — mutable, ordered list of steps
 */

import type { WorkflowName } from "../../queue/templates"

// Re-export WorkflowName so consumers can import from start-command
export type { WorkflowName }

// ---------------------------------------------------------------------------
// Workflow option types
// ---------------------------------------------------------------------------

export interface WorkflowOption {
  label: string
  description: string
  value: WorkflowName
}

// ---------------------------------------------------------------------------
// Workflow options (displayed in the question prompt)
// ---------------------------------------------------------------------------

export const WORKFLOW_OPTIONS: WorkflowOption[] = [
  {
    label: "Just Plan",
    description: "Create a plan only",
    value: "plan-only",
  },
  {
    label: "Plan + Work",
    description: "Create a plan and execute it",
    value: "plan-work",
  },
  {
    label: "Plan + Work + Review",
    description: "Create, execute, and review (recommended)",
    value: "plan-work-review",
  },
  {
    label: "Full Queue",
    description: "Create, execute, review, and ship",
    value: "full",
  },
  {
    label: "Sprint",
    description: "Fast iteration — implement, verify, retry",
    value: "sprint",
  },
]

// ---------------------------------------------------------------------------
// Workflow helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the given workflow includes a review step.
 * Used to decide whether to show the "triage review findings" question.
 */
export function workflowHasReview(workflow: WorkflowName): boolean {
  return workflow === "plan-work-review" || workflow === "full"
}



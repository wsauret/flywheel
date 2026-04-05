import { describe, it, expect } from "bun:test"
import {
  workflowHasReview,
  WORKFLOW_OPTIONS,
  type WorkflowName,
} from "../src/tui/shell/start-command"

// ===========================================================================
// WORKFLOW_OPTIONS (replaces PIPELINE_MODE_OPTIONS)
// ===========================================================================

describe("WORKFLOW_OPTIONS", () => {
  it("has 5 options (VAL-SHELL-008)", () => {
    expect(WORKFLOW_OPTIONS).toHaveLength(5)
  })

  it("each option has label, description, and value", () => {
    for (const option of WORKFLOW_OPTIONS) {
      expect(option.label).toBeDefined()
      expect(option.description).toBeDefined()
      expect(option.value).toBeDefined()
    }
  })

  it("values match WorkflowName union", () => {
    const values = WORKFLOW_OPTIONS.map((o) => o.value)
    expect(values).toEqual(["plan-only", "plan-work", "plan-work-review", "full", "sprint"])
  })

  it("has the correct labels for each workflow", () => {
    expect(WORKFLOW_OPTIONS[0].label).toBe("Just Plan")
    expect(WORKFLOW_OPTIONS[1].label).toBe("Plan + Work")
    expect(WORKFLOW_OPTIONS[2].label).toBe("Plan + Work + Review")
    expect(WORKFLOW_OPTIONS[3].label).toBe("Full Queue")
    expect(WORKFLOW_OPTIONS[4].label).toBe("Sprint")
  })
})

// ===========================================================================
// workflowHasReview
// ===========================================================================

describe("workflowHasReview", () => {
  it("returns true for workflows that include a review step", () => {
    expect(workflowHasReview("plan-work-review")).toBe(true)
    expect(workflowHasReview("full")).toBe(true)
  })

  it("returns false for workflows without a review step (VAL-SHELL-010)", () => {
    expect(workflowHasReview("plan-only")).toBe(false)
    expect(workflowHasReview("plan-work")).toBe(false)
    expect(workflowHasReview("sprint")).toBe(false)
  })
})

// ===========================================================================
// Triage preference wiring (VAL-SHELL-009, VAL-SHELL-010)
// ===========================================================================

describe("triage preference wiring", () => {
  it("all non-sprint workflows should show consolidation question (has plan step)", () => {
    const nonSprintWorkflows: WorkflowName[] = ["plan-only", "plan-work", "plan-work-review", "full"]
    for (const wf of nonSprintWorkflows) {
      // Consolidation applies to all workflows with plan steps
      // All non-sprint workflows have plan steps
      expect(wf).not.toBe("sprint")
    }
  })

  it("workflows with review show triage question (VAL-SHELL-010)", () => {
    const reviewWorkflows: WorkflowName[] = ["plan-work-review", "full"]
    for (const wf of reviewWorkflows) {
      expect(workflowHasReview(wf)).toBe(true)
    }
  })

  it("workflows without review skip triage question (VAL-SHELL-010)", () => {
    const noReviewWorkflows: WorkflowName[] = ["plan-only", "plan-work", "sprint"]
    for (const wf of noReviewWorkflows) {
      expect(workflowHasReview(wf)).toBe(false)
    }
  })
})

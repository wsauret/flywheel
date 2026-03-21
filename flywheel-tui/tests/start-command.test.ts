import { describe, it, expect } from "bun:test"
import {
  buildCustomPipeline,
  modeHasReview,
  PIPELINE_MODE_OPTIONS,
  type PipelineMode,
} from "../src/tui/components/start-command"

describe("buildCustomPipeline", () => {
  it('"plan-only" produces [plan]', () => {
    const stages = buildCustomPipeline("plan-only")
    expect(stages).toEqual([{ workflow: "plan" }])
  })

  it('"plan-work" produces [plan, work]', () => {
    const stages = buildCustomPipeline("plan-work")
    expect(stages).toEqual([{ workflow: "plan" }, { workflow: "work" }])
  })

  it('"plan-work-review" produces [plan, work, review]', () => {
    const stages = buildCustomPipeline("plan-work-review")
    expect(stages).toEqual([
      { workflow: "plan" },
      { workflow: "work" },
      { workflow: "review" },
    ])
  })

  it('"full" produces [plan, work, review, ship]', () => {
    const stages = buildCustomPipeline("full")
    expect(stages).toEqual([
      { workflow: "plan" },
      { workflow: "work" },
      { workflow: "review" },
      { workflow: "ship" },
    ])
  })
})

describe("PIPELINE_MODE_OPTIONS", () => {
  it("has 4 options", () => {
    expect(PIPELINE_MODE_OPTIONS).toHaveLength(4)
  })

  it("each option has label, description, and value", () => {
    for (const option of PIPELINE_MODE_OPTIONS) {
      expect(option.label).toBeDefined()
      expect(option.description).toBeDefined()
      expect(option.value).toBeDefined()
    }
  })

  it("values match PipelineMode union", () => {
    const values = PIPELINE_MODE_OPTIONS.map((o) => o.value)
    expect(values).toEqual(["plan-only", "plan-work", "plan-work-review", "full"])
  })
})

describe("modeHasReview", () => {
  it("returns true for modes that include a review stage", () => {
    expect(modeHasReview("plan-work-review")).toBe(true)
    expect(modeHasReview("full")).toBe(true)
  })

  it("returns false for modes without a review stage", () => {
    expect(modeHasReview("plan-only")).toBe(false)
    expect(modeHasReview("plan-work")).toBe(false)
  })
})

describe("triage preference wiring", () => {
  it("all modes include a plan stage (consolidation question always applies)", () => {
    const allModes: PipelineMode[] = ["plan-only", "plan-work", "plan-work-review", "full"]
    for (const mode of allModes) {
      const stages = buildCustomPipeline(mode)
      const hasPlan = stages.some((s) => s.workflow === "plan")
      expect(hasPlan).toBe(true)
    }
  })

  it("modes with review include a review stage (triage question applies)", () => {
    const reviewModes: PipelineMode[] = ["plan-work-review", "full"]
    for (const mode of reviewModes) {
      const stages = buildCustomPipeline(mode)
      const hasReview = stages.some((s) => s.workflow === "review")
      expect(hasReview).toBe(true)
    }
  })

  it("modes without review skip the review stage (no triage question)", () => {
    const noReviewModes: PipelineMode[] = ["plan-only", "plan-work"]
    for (const mode of noReviewModes) {
      const stages = buildCustomPipeline(mode)
      const hasReview = stages.some((s) => s.workflow === "review")
      expect(hasReview).toBe(false)
    }
  })
})

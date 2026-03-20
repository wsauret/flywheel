import { describe, it, expect } from "bun:test"
import {
  buildCustomPipeline,
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

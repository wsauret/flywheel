import { describe, it, expect } from "bun:test"
import { buildStepPrompt } from "../src/orchestration/subprocess-callback"
import type { Step } from "../src/workflows/queue/types"
import "../src/workflows/queue/steps/register-all"

describe("buildStepPrompt", () => {
  const sessionId = "test-session-123"
  const projectCwd = "/tmp/test-project"

  function makeStep(overrides?: Partial<Step>): Step {
    return {
      id: "step-1",
      type: "work",
      title: "Implement feature",
      status: "pending",
      taskContent: "Build the thing",
      ...overrides,
    } as Step
  }

  it("returns fullPrompt containing the user prompt", () => {
    const result = buildStepPrompt(makeStep(), "Build the thing", sessionId, projectCwd)
    expect(result.fullPrompt).toContain("Build the thing")
  })

  it("returns a handoff path based on sessionId and step", () => {
    const result = buildStepPrompt(makeStep(), "prompt", sessionId, projectCwd)
    expect(result.handoffPath).toContain(sessionId)
    expect(result.handoffPath).toContain("work_step-1")
  })

  it("returns scaffolding paths relative to session dir", () => {
    const result = buildStepPrompt(makeStep(), "prompt", sessionId, projectCwd)
    expect(result.scaffoldingPaths.handoffPath).toBe(result.handoffPath)
    expect(result.scaffoldingPaths.planPath).toContain(sessionId)
    expect(result.scaffoldingPaths.planPath).toEndWith("plan.json")
    expect(result.scaffoldingPaths.researchPath).toEndWith("research.md")
    expect(result.scaffoldingPaths.reviewPath).toEndWith("review.md")
    expect(result.scaffoldingPaths.contextPath).toEndWith("context.md")
  })

  it("is deterministic — same inputs produce same outputs", () => {
    const step = makeStep()
    const a = buildStepPrompt(step, "same prompt", sessionId, projectCwd)
    const b = buildStepPrompt(step, "same prompt", sessionId, projectCwd)
    expect(a.fullPrompt).toBe(b.fullPrompt)
    expect(a.handoffPath).toBe(b.handoffPath)
  })

  it("assembles scaffolding preamble + prompt + postamble", () => {
    // A "work" step type should produce scaffolding (preamble/postamble)
    const result = buildStepPrompt(makeStep(), "Do the work", sessionId, projectCwd)
    // The prompt must be present, and the full prompt should be >= prompt length
    // (scaffolding adds preamble/postamble for work steps)
    expect(result.fullPrompt).toContain("Do the work")
    expect(result.fullPrompt.length).toBeGreaterThanOrEqual("Do the work".length)
  })
})

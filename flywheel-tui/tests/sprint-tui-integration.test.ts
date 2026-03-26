import { describe, it, expect } from "bun:test"
import {
  workflowHasReview,
  WORKFLOW_OPTIONS,
  type WorkflowName,
} from "../src/tui/components/start-command"
import {
  buildPipelineStages,
} from "../src/tui/components/shell-pipeline"
import { CONFIG_DEFAULTS, type FlywheelConfig } from "../src/config/loader"
import { EventBus } from "../src/events/event-bus"
import type { SprintIterationStarted, SprintStarted, SprintCompleted, SprintEscalated } from "../src/events/types"
import {
  isValidTransition,
  findTransitionPath,
  type SessionLifecycleState,
} from "../src/session/state-machine"
import {
  formatPipelineStage,
  formatSprintIteration,
  type PipelineStageInfo,
  type SprintIterationInfo,
} from "../src/tui/utils/format"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<FlywheelConfig> = {}): FlywheelConfig {
  return {
    ...CONFIG_DEFAULTS,
    interactive_consolidation: false,
    ...overrides,
  }
}

// ===========================================================================
// VAL-TUI-001: Sprint is an option in /start mode picker
// ===========================================================================

describe("VAL-TUI-001: Sprint is 5th option in /start workflow picker", () => {
  it("WORKFLOW_OPTIONS has 5 entries", () => {
    expect(WORKFLOW_OPTIONS).toHaveLength(5)
  })

  it("Sprint is the 5th option (index 4)", () => {
    const fifth = WORKFLOW_OPTIONS[4]
    expect(fifth.value).toBe("sprint")
  })

  it('Sprint option has label "Sprint"', () => {
    const sprint = WORKFLOW_OPTIONS.find((o) => o.value === "sprint")
    expect(sprint).toBeDefined()
    expect(sprint!.label).toBe("Sprint")
  })

  it('Sprint option has correct description', () => {
    const sprint = WORKFLOW_OPTIONS.find((o) => o.value === "sprint")
    expect(sprint).toBeDefined()
    expect(sprint!.description).toContain("Fast iteration")
  })

  it("WorkflowName union accepts 'sprint'", () => {
    // Type-level test: this wouldn't compile if sprint wasn't in WorkflowName
    const workflow: WorkflowName = "sprint"
    expect(workflow).toBe("sprint")
  })

  it("workflow options are ordered: plan-only, plan-work, plan-work-review, full, sprint", () => {
    const values = WORKFLOW_OPTIONS.map((o) => o.value)
    expect(values).toEqual(["plan-only", "plan-work", "plan-work-review", "full", "sprint"])
  })

  it("workflowHasReview returns false for sprint (sprint has no review step)", () => {
    expect(workflowHasReview("sprint")).toBe(false)
  })
})

// ===========================================================================
// VAL-TUI-002: Sprint queue template returns correct steps
// ===========================================================================

describe("VAL-TUI-002: Sprint queue template returns correct steps", () => {
  it("sprint template creates work + verify steps", async () => {
    const { buildQueue } = await import("../src/tui/components/shell-queue")
    const { CONFIG_DEFAULTS } = await import("../src/config/loader")
    const queue = buildQueue("sprint", { ...CONFIG_DEFAULTS, interactive_consolidation: false })
    expect(queue.steps).toHaveLength(2)
    expect(queue.steps[0].type).toBe("work")
    expect(queue.steps[1].type).toBe("verify")
  })

  it("sprint queue does not include plan, review, or ship steps", async () => {
    const { buildQueue } = await import("../src/tui/components/shell-queue")
    const { CONFIG_DEFAULTS } = await import("../src/config/loader")
    const queue = buildQueue("sprint", { ...CONFIG_DEFAULTS, interactive_consolidation: false })
    const types = queue.steps.map((s) => s.type)
    expect(types).not.toContain("plan")
    expect(types).not.toContain("review")
    expect(types).not.toContain("ship")
  })

  it("all other workflow templates still produce correct queues", async () => {
    const { buildQueue } = await import("../src/tui/components/shell-queue")
    const { CONFIG_DEFAULTS } = await import("../src/config/loader")
    const config = { ...CONFIG_DEFAULTS, interactive_consolidation: false }

    const planOnly = buildQueue("plan-only", config)
    expect(planOnly.steps[0].type).toBe("plan")

    const planWork = buildQueue("plan-work", config)
    expect(planWork.steps[0].type).toBe("plan")

    const planWorkReview = buildQueue("plan-work-review", config)
    expect(planWorkReview.steps[0].type).toBe("plan")
    expect(planWorkReview.steps[planWorkReview.steps.length - 1].type).toBe("review")

    const full = buildQueue("full", config)
    expect(full.steps[0].type).toBe("plan")
    expect(full.steps[full.steps.length - 1].type).toBe("ship")
  })
})

// ===========================================================================
// VAL-TUI-002 (supplement): buildPipelineStages does not add sprint to auto_chain
// ===========================================================================

describe("buildPipelineStages excludes sprint from auto_chain", () => {
  it("sprint returns null with auto_chain: true (no auto-chaining for sprint)", () => {
    const config = makeConfig({ auto_chain: true })
    const stages = buildPipelineStages("sprint", config)
    expect(stages).toBeNull()
  })

  it("sprint returns null with auto_chain: false", () => {
    const config = makeConfig({ auto_chain: false })
    const stages = buildPipelineStages("sprint", config)
    expect(stages).toBeNull()
  })

  it("sprint with auto_ship: true still returns null (sprint never auto-chains)", () => {
    const config = makeConfig({ auto_chain: true, auto_ship: true })
    const stages = buildPipelineStages("sprint", config)
    expect(stages).toBeNull()
  })

  it("plan and work still auto-chain correctly (sprint exclusion doesn't break others)", () => {
    const config = makeConfig({ auto_chain: true, auto_ship: false })
    expect(buildPipelineStages("plan", config)!.map((s) => s.workflow)).toEqual([
      "plan", "work", "review",
    ])
    expect(buildPipelineStages("work", config)!.map((s) => s.workflow)).toEqual([
      "work", "review",
    ])
  })
})

// ===========================================================================
// VAL-TUI-003: Telemetry bar shows iteration count during sprint
// ===========================================================================

describe("VAL-TUI-003: Telemetry bar sprint iteration display", () => {
  it("formatSprintIteration returns correct string for active sprint", () => {
    const result = formatSprintIteration({ iteration: 2, maxIterations: 5 })
    expect(result).toBe("Sprint 2/5")
  })

  it("formatSprintIteration returns correct string for first iteration", () => {
    const result = formatSprintIteration({ iteration: 1, maxIterations: 5 })
    expect(result).toBe("Sprint 1/5")
  })

  it("formatSprintIteration returns correct string for last iteration", () => {
    const result = formatSprintIteration({ iteration: 5, maxIterations: 5 })
    expect(result).toBe("Sprint 5/5")
  })

  it("formatSprintIteration returns empty string for null input", () => {
    expect(formatSprintIteration(null)).toBe("")
  })

  it("formatSprintIteration returns empty string for undefined input", () => {
    expect(formatSprintIteration(undefined)).toBe("")
  })

  it("formatSprintIteration returns empty string for zero iteration", () => {
    expect(formatSprintIteration({ iteration: 0, maxIterations: 5 })).toBe("")
  })

  it("formatSprintIteration returns empty string for zero maxIterations", () => {
    expect(formatSprintIteration({ iteration: 1, maxIterations: 0 })).toBe("")
  })

  it("SprintIterationInfo interface is exported from format utils", () => {
    // Type-level test: importing SprintIterationInfo without error confirms it's exported
    const info: SprintIterationInfo = { iteration: 3, maxIterations: 5 }
    expect(info.iteration).toBe(3)
    expect(info.maxIterations).toBe(5)
  })
})

// ===========================================================================
// VAL-TUI-004: Session state transitions work for sprint lifecycle
// ===========================================================================

describe("VAL-TUI-004: Session state transitions for sprint lifecycle", () => {
  describe("sprint happy path: new → work:active → completed", () => {
    it("new → plan:imported is valid (pipeline start)", () => {
      expect(isValidTransition("new", "plan:imported")).toBe(true)
    })

    it("plan:imported → plan:approved is valid", () => {
      expect(isValidTransition("plan:imported", "plan:approved")).toBe(true)
    })

    it("plan:approved → work:active is valid", () => {
      expect(isValidTransition("plan:approved", "work:active")).toBe(true)
    })

    it("work:active → completed is valid", () => {
      expect(isValidTransition("work:active", "completed")).toBe(true)
    })

    it("full sprint happy path is reachable from new to completed", () => {
      const path = findTransitionPath("new", "completed")
      expect(path).not.toBeNull()
      expect(path!).toContain("work:active")
      expect(path!).toContain("completed")
    })
  })

  describe("sprint pause/resume: work:active → work:paused → work:active", () => {
    it("work:active → work:paused is valid", () => {
      expect(isValidTransition("work:active", "work:paused")).toBe(true)
    })

    it("work:paused → work:active is valid (resume)", () => {
      expect(isValidTransition("work:paused", "work:active")).toBe(true)
    })
  })

  describe("sprint failure/interruption", () => {
    it("work:active → work:paused is valid (stop/interrupt)", () => {
      expect(isValidTransition("work:active", "work:paused")).toBe(true)
    })

    it("work:active → trashed is valid (discard)", () => {
      expect(isValidTransition("work:active", "trashed")).toBe(true)
    })
  })

  describe("sprint escalation: work:active → work:review or continued work:active", () => {
    it("work:active → work:review is valid (escalation with review)", () => {
      expect(isValidTransition("work:active", "work:review")).toBe(true)
    })

    it("work:review → completed is valid (after escalation completes)", () => {
      expect(isValidTransition("work:review", "completed")).toBe(true)
    })

    it("work:review → work:active is valid (re-enter work after review)", () => {
      expect(isValidTransition("work:review", "work:active")).toBe(true)
    })
  })

  describe("sprint budget exhaustion", () => {
    it("work:active → budget_exhausted is valid", () => {
      expect(isValidTransition("work:active", "budget_exhausted")).toBe(true)
    })

    it("budget_exhausted → work:active is valid (resume after budget increase)", () => {
      expect(isValidTransition("budget_exhausted", "work:active")).toBe(true)
    })
  })

  describe("safeUpdateState path from new to work:paused", () => {
    it("path exists from new to work:paused via intermediate states", () => {
      const path = findTransitionPath("new", "work:paused")
      expect(path).not.toBeNull()
      // Should go through plan:imported → plan:approved → work:active → work:paused
      expect(path!.length).toBeGreaterThan(1)
      expect(path![path!.length - 1]).toBe("work:paused")
    })

    it("path exists from new to work:active", () => {
      const path = findTransitionPath("new", "work:active")
      expect(path).not.toBeNull()
      expect(path![path!.length - 1]).toBe("work:active")
    })
  })
})

// ===========================================================================
// Sprint events carry correct data for telemetry bar consumption
// ===========================================================================

describe("Sprint events carry correct telemetry data", () => {
  it("sprint:started event has maxIterations field", () => {
    const bus = new EventBus()
    let captured: SprintStarted | null = null

    bus.subscribeToType("sprint:started", (e) => {
      captured = e
    })

    bus.emit({
      type: "sprint:started",
      workflowId: "sprint-1",
      taskDescription: "Add hello world",
      maxIterations: 5,
      timestamp: new Date().toISOString(),
    })

    expect(captured).not.toBeNull()
    expect(captured!.maxIterations).toBe(5)
    expect(captured!.taskDescription).toBe("Add hello world")
  })

  it("sprint:iteration-started event has iteration and maxIterations", () => {
    const bus = new EventBus()
    let captured: SprintIterationStarted | null = null

    bus.subscribeToType("sprint:iteration-started", (e) => {
      captured = e
    })

    bus.emit({
      type: "sprint:iteration-started",
      workflowId: "sprint-1",
      iteration: 2,
      maxIterations: 5,
      timestamp: new Date().toISOString(),
    })

    expect(captured).not.toBeNull()
    expect(captured!.iteration).toBe(2)
    expect(captured!.maxIterations).toBe(5)
  })

  it("sprint:completed event resets sprint info (completed: true)", () => {
    const bus = new EventBus()
    let captured: SprintCompleted | null = null

    bus.subscribeToType("sprint:completed", (e) => {
      captured = e
    })

    bus.emit({
      type: "sprint:completed",
      workflowId: "sprint-1",
      completed: true,
      iterationsUsed: 1,
      escalated: false,
      timestamp: new Date().toISOString(),
    })

    expect(captured).not.toBeNull()
    expect(captured!.completed).toBe(true)
    expect(captured!.iterationsUsed).toBe(1)
  })

  it("sprint:escalated event carries iteration count and reason", () => {
    const bus = new EventBus()
    let captured: SprintEscalated | null = null

    bus.subscribeToType("sprint:escalated", (e) => {
      captured = e
    })

    bus.emit({
      type: "sprint:escalated",
      workflowId: "sprint-1",
      iterationsUsed: 5,
      reason: "Hard cap reached",
      timestamp: new Date().toISOString(),
    })

    expect(captured).not.toBeNull()
    expect(captured!.iterationsUsed).toBe(5)
    expect(captured!.reason).toBe("Hard cap reached")
  })

  it("sprint iteration events can be mapped to SprintIterationInfo for telemetry bar", () => {
    const bus = new EventBus()
    let sprintInfo: SprintIterationInfo | null = null

    // Simulate the same wiring as flywheel-shell.tsx
    bus.subscribeToType("sprint:started", (e) => {
      sprintInfo = { iteration: 0, maxIterations: e.maxIterations }
    })
    bus.subscribeToType("sprint:iteration-started", (e) => {
      sprintInfo = { iteration: e.iteration, maxIterations: e.maxIterations }
    })
    bus.subscribeToType("sprint:completed", () => {
      sprintInfo = null
    })

    // Sprint starts
    bus.emit({
      type: "sprint:started",
      workflowId: "sprint-1",
      taskDescription: "test",
      maxIterations: 3,
      timestamp: new Date().toISOString(),
    })
    expect(sprintInfo).toEqual({ iteration: 0, maxIterations: 3 })
    // formatSprintIteration should return empty for iteration 0 (not yet started)
    expect(formatSprintIteration(sprintInfo)).toBe("")

    // Iteration 1 starts
    bus.emit({
      type: "sprint:iteration-started",
      workflowId: "sprint-1",
      iteration: 1,
      maxIterations: 3,
      timestamp: new Date().toISOString(),
    })
    expect(sprintInfo).toEqual({ iteration: 1, maxIterations: 3 })
    expect(formatSprintIteration(sprintInfo)).toBe("Sprint 1/3")

    // Iteration 2 starts
    bus.emit({
      type: "sprint:iteration-started",
      workflowId: "sprint-1",
      iteration: 2,
      maxIterations: 3,
      timestamp: new Date().toISOString(),
    })
    expect(sprintInfo).toEqual({ iteration: 2, maxIterations: 3 })
    expect(formatSprintIteration(sprintInfo)).toBe("Sprint 2/3")

    // Sprint completes — clear info
    bus.emit({
      type: "sprint:completed",
      workflowId: "sprint-1",
      completed: true,
      iterationsUsed: 2,
      escalated: false,
      timestamp: new Date().toISOString(),
    })
    expect(sprintInfo).toBeNull()
    expect(formatSprintIteration(sprintInfo)).toBe("")
  })
})

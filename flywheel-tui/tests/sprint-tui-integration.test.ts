import { describe, it, expect } from "bun:test"
import {
  workflowHasReview,
  WORKFLOW_OPTIONS,
  type WorkflowName,
} from "../src/tui/components/start-command"
import {
  buildShellStages,
} from "../src/tui/components/shell-pipeline"
import { CONFIG_DEFAULTS, type FlywheelConfig } from "../src/config/loader"
import { EventBus } from "../src/events/event-bus"
import {
  isValidTransition,
  findTransitionPath,
  type SessionLifecycleState,
} from "../src/session/state-machine"
import {
  formatSprintIteration,
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
// buildShellStages excludes sprint from auto_chain
// ===========================================================================

describe("buildShellStages excludes sprint from auto_chain", () => {
  it("sprint returns null with auto_chain: true", () => {
    const config = makeConfig({ auto_chain: true })
    const stages = buildShellStages("sprint", config)
    expect(stages).toBeNull()
  })

  it("sprint returns null with auto_chain: false", () => {
    const config = makeConfig({ auto_chain: false })
    const stages = buildShellStages("sprint", config)
    expect(stages).toBeNull()
  })

  it("sprint with auto_ship: true still returns null", () => {
    const config = makeConfig({ auto_chain: true, auto_ship: true })
    const stages = buildShellStages("sprint", config)
    expect(stages).toBeNull()
  })

  it("plan and work still auto-chain correctly", () => {
    const config = makeConfig({ auto_chain: true, auto_ship: false })
    expect(buildShellStages("plan", config)!.map((s) => s.workflow)).toEqual([
      "plan", "work", "review",
    ])
    expect(buildShellStages("work", config)!.map((s) => s.workflow)).toEqual([
      "work", "review",
    ])
  })
})

// ===========================================================================
// VAL-SPRINT-006: Telemetry bar shows iteration count
// ===========================================================================

describe("VAL-SPRINT-006: Telemetry bar sprint iteration display", () => {
  it("formatSprintIteration returns correct string for active sprint", () => {
    expect(formatSprintIteration({ iteration: 2, maxIterations: 5 })).toBe("Sprint 2/5")
  })

  it("formatSprintIteration returns correct string for first iteration", () => {
    expect(formatSprintIteration({ iteration: 1, maxIterations: 5 })).toBe("Sprint 1/5")
  })

  it("formatSprintIteration returns correct string for last iteration", () => {
    expect(formatSprintIteration({ iteration: 5, maxIterations: 5 })).toBe("Sprint 5/5")
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
    const info: SprintIterationInfo = { iteration: 3, maxIterations: 5 }
    expect(info.iteration).toBe(3)
    expect(info.maxIterations).toBe(5)
  })

  it("sprint iteration count derived from work step starts", () => {
    let sprintWorkStepCount = 0
    const maxIter = 5

    // First work step → iteration 1
    sprintWorkStepCount++
    let sprintInfo: SprintIterationInfo = { iteration: sprintWorkStepCount, maxIterations: maxIter }
    expect(formatSprintIteration(sprintInfo)).toBe("Sprint 1/5")

    // Second work step (retry) → iteration 2
    sprintWorkStepCount++
    sprintInfo = { iteration: sprintWorkStepCount, maxIterations: maxIter }
    expect(formatSprintIteration(sprintInfo)).toBe("Sprint 2/5")
  })
})

// ===========================================================================
// Session state transitions for sprint lifecycle
// ===========================================================================

describe("Session state transitions for sprint lifecycle", () => {
  it("new → plan:imported is valid", () => {
    expect(isValidTransition("new", "plan:imported")).toBe(true)
  })

  it("plan:approved → work:active is valid", () => {
    expect(isValidTransition("plan:approved", "work:active")).toBe(true)
  })

  it("work:active → completed is valid", () => {
    expect(isValidTransition("work:active", "completed")).toBe(true)
  })

  it("work:active → work:paused is valid", () => {
    expect(isValidTransition("work:active", "work:paused")).toBe(true)
  })

  it("work:paused → work:active is valid", () => {
    expect(isValidTransition("work:paused", "work:active")).toBe(true)
  })

  it("path exists from new to completed", () => {
    const path = findTransitionPath("new", "completed")
    expect(path).not.toBeNull()
    expect(path!).toContain("work:active")
    expect(path!).toContain("completed")
  })
})

// ===========================================================================
// VAL-SPRINT-011: Sprint uses standard queue step events
// ===========================================================================

describe("VAL-SPRINT-011: Sprint uses standard queue step events", () => {
  it("queue:step-started fires for work steps in sprint queue", () => {
    const bus = new EventBus()
    const events: string[] = []

    bus.subscribeToType("queue:step-started", (e) => {
      events.push(`${e.stepType}:${e.stepTitle}`)
    })

    bus.emit({
      type: "queue:step-started",
      workflowId: "sprint-1",
      stepId: "s1",
      stepType: "work",
      stepTitle: "Sprint work (iteration 1)",
      timestamp: new Date().toISOString(),
    })
    bus.emit({
      type: "queue:step-started",
      workflowId: "sprint-1",
      stepId: "s2",
      stepType: "verify",
      stepTitle: "Verify changes (iteration 1)",
      timestamp: new Date().toISOString(),
    })

    expect(events).toHaveLength(2)
    expect(events[0]).toContain("work")
    expect(events[1]).toContain("verify")
  })

  it("queue:step-completed fires for sprint verify steps", () => {
    const bus = new EventBus()
    let captured: { stepType: string; stepTitle: string } | null = null

    bus.subscribeToType("queue:step-completed", (e) => {
      captured = { stepType: e.stepType, stepTitle: e.stepTitle }
    })

    bus.emit({
      type: "queue:step-completed",
      workflowId: "sprint-1",
      stepId: "s2",
      stepType: "verify",
      stepTitle: "Verify changes (iteration 1)",
      timestamp: new Date().toISOString(),
    })

    expect(captured).not.toBeNull()
    expect(captured!.stepType).toBe("verify")
  })

  it("queue:step-failed fires for failed sprint steps", () => {
    const bus = new EventBus()
    let captured: { stepType: string; reason: string } | null = null

    bus.subscribeToType("queue:step-failed", (e) => {
      captured = { stepType: e.stepType, reason: e.reason }
    })

    bus.emit({
      type: "queue:step-failed",
      workflowId: "sprint-1",
      stepId: "s1",
      stepType: "work",
      stepTitle: "Sprint work (iteration 1)",
      reason: "Worker crashed",
      timestamp: new Date().toISOString(),
    })

    expect(captured).not.toBeNull()
    expect(captured!.stepType).toBe("work")
    expect(captured!.reason).toBe("Worker crashed")
  })

  it("queue:step-inserted fires when retry pair is inserted", () => {
    const bus = new EventBus()
    const inserted: string[] = []

    bus.subscribeToType("queue:step-inserted", (e) => {
      inserted.push(`${e.stepType}:${e.stepTitle}`)
    })

    bus.emit({
      type: "queue:step-inserted",
      workflowId: "sprint-1",
      stepId: "s3",
      stepType: "work",
      stepTitle: "Sprint work (iteration 2)",
      afterStepId: "s2",
      timestamp: new Date().toISOString(),
    })
    bus.emit({
      type: "queue:step-inserted",
      workflowId: "sprint-1",
      stepId: "s4",
      stepType: "verify",
      stepTitle: "Verify changes (iteration 2)",
      afterStepId: "s3",
      timestamp: new Date().toISOString(),
    })

    expect(inserted).toHaveLength(2)
    expect(inserted[0]).toContain("work")
    expect(inserted[1]).toContain("verify")
  })
})

// ===========================================================================
// VAL-SPRINT-010: sprint-loop.ts deleted, no imports reference it
// ===========================================================================

describe("VAL-SPRINT-010: sprint-loop.ts deleted", () => {
  it("src/sprint/sprint-loop.ts file does not exist", async () => {
    const fs = await import("fs")
    const path = await import("path")
    const filePath = path.resolve(__dirname, "../src/sprint/sprint-loop.ts")
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it("sprint/types.ts exists with shared types", async () => {
    const { default: fs } = await import("fs")
    const path = await import("path")
    const filePath = path.resolve(__dirname, "../src/sprint/types.ts")
    expect(fs.existsSync(filePath)).toBe(true)
  })

  it("verification-runner.ts is preserved", async () => {
    const { default: fs } = await import("fs")
    const path = await import("path")
    const filePath = path.resolve(__dirname, "../src/sprint/verification-runner.ts")
    expect(fs.existsSync(filePath)).toBe(true)
  })

  it("escalation-context.ts is preserved", async () => {
    const { default: fs } = await import("fs")
    const path = await import("path")
    const filePath = path.resolve(__dirname, "../src/sprint/escalation-context.ts")
    expect(fs.existsSync(filePath)).toBe(true)
  })

  it("sprint queue handler is preserved", async () => {
    const { default: fs } = await import("fs")
    const path = await import("path")
    const filePath = path.resolve(__dirname, "../src/queue/sprint.ts")
    expect(fs.existsSync(filePath)).toBe(true)
  })
})

// ===========================================================================
// Sprint queue detection and headless logging
// ===========================================================================

describe("Sprint queue detection", () => {
  it("sprint queue identified by verify step presence", async () => {
    const { buildQueue } = await import("../src/tui/components/shell-queue")
    const queue = buildQueue("sprint", { ...CONFIG_DEFAULTS, interactive_consolidation: false })
    const isSprintQueue = queue.steps.some(s => s.type === "verify")
    expect(isSprintQueue).toBe(true)
  })

  it("non-sprint queues do not have verify steps", async () => {
    const { buildQueue } = await import("../src/tui/components/shell-queue")
    const config = { ...CONFIG_DEFAULTS, interactive_consolidation: false }

    const planOnly = buildQueue("plan-only", config)
    expect(planOnly.steps.some(s => s.type === "verify")).toBe(false)

    const planWork = buildQueue("plan-work", config)
    expect(planWork.steps.some(s => s.type === "verify")).toBe(false)

    const full = buildQueue("full", config)
    expect(full.steps.some(s => s.type === "verify")).toBe(false)
  })
})

describe("Headless adapter logs sprint steps meaningfully", () => {
  it("headless adapter creates and logs queue:step-started for verify type", async () => {
    const { HeadlessAdapter } = await import("../src/tui/adapters/headless")
    const { EventBus } = await import("../src/events/event-bus")

    const logs: string[] = []
    const adapter = new HeadlessAdapter({
      logLevel: "normal",
      logger: (msg) => logs.push(msg),
      timestamps: false,
    })
    const bus = new EventBus()
    adapter.connect(bus)
    adapter.start()

    bus.emit({
      type: "queue:step-started",
      workflowId: "sprint-1",
      stepId: "s1",
      stepType: "verify",
      stepTitle: "Verify changes (iteration 1)",
      timestamp: new Date().toISOString(),
    })

    adapter.stop()

    const stepLog = logs.find(l => l.includes("verify"))
    expect(stepLog).toBeDefined()
    expect(stepLog).toContain("sprint verification")
  })

  it("headless adapter logs sprint work steps with sprint context", async () => {
    const { HeadlessAdapter } = await import("../src/tui/adapters/headless")
    const { EventBus } = await import("../src/events/event-bus")

    const logs: string[] = []
    const adapter = new HeadlessAdapter({
      logLevel: "normal",
      logger: (msg) => logs.push(msg),
      timestamps: false,
    })
    const bus = new EventBus()
    adapter.connect(bus)
    adapter.start()

    bus.emit({
      type: "queue:step-started",
      workflowId: "sprint-1",
      stepId: "s1",
      stepType: "work",
      stepTitle: "Sprint work (iteration 1)",
      timestamp: new Date().toISOString(),
    })

    adapter.stop()

    const stepLog = logs.find(l => l.includes("Sprint work"))
    expect(stepLog).toBeDefined()
    expect(stepLog).toContain("sprint iteration")
  })
})

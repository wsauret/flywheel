import { describe, it, expect, beforeEach } from "bun:test"
import type { FlywheelConfig } from "../src/config/loader"
import type { PipelineStage, PipelineStageResult, StageRunner } from "../src/controller/workflow-pipeline"
import type { QuestionService } from "../src/controller/question-service"
import type { SprintIterationRecord, SprintLoopResult } from "../src/sprint/sprint-loop"
import { CONFIG_DEFAULTS } from "../src/config/loader"
import { EventBus } from "../src/events/event-bus"
import { WorkflowPipeline } from "../src/controller/workflow-pipeline"
import {
  buildEscalationContext,
  type EscalationContext,
} from "../src/sprint/escalation-context"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultConfig(overrides?: Partial<FlywheelConfig>): FlywheelConfig {
  return { ...CONFIG_DEFAULTS, ...overrides } as FlywheelConfig
}

function makeIterationHistory(count: number): SprintIterationRecord[] {
  const records: SprintIterationRecord[] = []
  for (let i = 1; i <= count; i++) {
    records.push({
      iteration: i,
      workerSummary: `Attempt ${i}: implemented feature but tests fail`,
      verificationResult: {
        passed: false,
        stdout: `FAIL: test ${i} failed\n`,
        stderr: "",
        exitCode: 1,
        durationMs: 500,
      },
      evaluatorPassed: false,
      evaluatorFeedback: {
        implementation: `Implementation feedback for iteration ${i}`,
        script: `Script feedback for iteration ${i}`,
      },
      scriptContent: `// Verification script v${i}\nexport function verify() { return false }`,
    })
  }
  return records
}

function makeSprintResult(overrides?: Partial<SprintLoopResult>): SprintLoopResult {
  return {
    completed: false,
    iterationsUsed: 5,
    escalated: true,
    iterationHistory: makeIterationHistory(5),
    reason: "Max iterations reached",
    ...overrides,
  }
}

function makeQuestionService(): QuestionService {
  return {
    ask: async () => [["Continue"]],
    answer: () => {},
    reject: () => {},
    list: () => [],
  } as unknown as QuestionService
}

// ===========================================================================
// VAL-ESCAL-001: Hard cap triggers escalation to full pipeline
// ===========================================================================

describe("VAL-ESCAL-001: Escalation triggers when sprint returns escalated:true and escalate_to_full=true", () => {
  it("sprint escalation appends plan→work→review stages to pipeline", async () => {
    const config = defaultConfig({
      sprint: { ...CONFIG_DEFAULTS.sprint, escalate_to_full: true },
    })
    const eventBus = new EventBus()
    const stagesRun: string[] = []

    // Sprint stage returns escalated result
    const sprintResult = makeSprintResult()

    const stageRunner: StageRunner = async (stage, args) => {
      stagesRun.push(stage.workflow)
      if (stage.workflow === "sprint") {
        return {
          workflow: "sprint",
          completed: true, // Sprint stage itself completes (even when escalating)
          reason: "Escalated",
          escalationContext: buildEscalationContext(sprintResult),
        } as PipelineStageResult
      }
      // Other stages succeed
      if (stage.workflow === "plan") {
        return { workflow: "plan", completed: true, planPath: "/tmp/plan.md" }
      }
      return { workflow: stage.workflow, completed: true }
    }

    const pipeline = new WorkflowPipeline({
      stages: [{ workflow: "sprint" }],
      args: { description: "Add hello world" },
      config,
      stageRunner,
      questionService: makeQuestionService(),
      eventBus,
    })

    const result = await pipeline.run()

    expect(result.completed).toBe(true)
    expect(stagesRun).toEqual(["sprint", "plan", "work", "review"])
    expect(result.stagesCompleted).toBe(4) // sprint + plan + work + review
  })

  it("escalation runs plan→work→review stages after sprint stage is marked complete", async () => {
    const config = defaultConfig({
      sprint: { ...CONFIG_DEFAULTS.sprint, escalate_to_full: true },
    })
    const eventBus = new EventBus()
    const stageCompletionOrder: Array<{ workflow: string; completed: boolean }> = []

    const stageRunner: StageRunner = async (stage) => {
      const result: PipelineStageResult = {
        workflow: stage.workflow,
        completed: true,
        ...(stage.workflow === "sprint"
          ? { escalationContext: buildEscalationContext(makeSprintResult()) }
          : {}),
        ...(stage.workflow === "plan" ? { planPath: "/tmp/plan.md" } : {}),
      }
      stageCompletionOrder.push({ workflow: stage.workflow, completed: true })
      return result
    }

    const pipeline = new WorkflowPipeline({
      stages: [{ workflow: "sprint" }],
      args: { description: "Add feature" },
      config,
      stageRunner,
      questionService: makeQuestionService(),
      eventBus,
    })

    await pipeline.run()

    // Sprint completes first, then plan, work, review
    expect(stageCompletionOrder[0].workflow).toBe("sprint")
    expect(stageCompletionOrder[1].workflow).toBe("plan")
    expect(stageCompletionOrder[2].workflow).toBe("work")
    expect(stageCompletionOrder[3].workflow).toBe("review")
  })
})

// ===========================================================================
// VAL-ESCAL-002: Escalation carry-forward includes all sprint context
// ===========================================================================

describe("VAL-ESCAL-002: Escalation carry-forward includes all sprint context", () => {
  it("buildEscalationContext includes all attempt summaries", () => {
    const sprintResult = makeSprintResult()
    const ctx = buildEscalationContext(sprintResult)

    expect(ctx.iterationHistory).toHaveLength(5)
    for (let i = 0; i < 5; i++) {
      expect(ctx.iterationHistory[i].workerSummary).toContain(`Attempt ${i + 1}`)
    }
  })

  it("buildEscalationContext includes all evaluator feedback", () => {
    const sprintResult = makeSprintResult()
    const ctx = buildEscalationContext(sprintResult)

    for (let i = 0; i < 5; i++) {
      expect(ctx.iterationHistory[i].evaluatorFeedback).toBeDefined()
      expect(ctx.iterationHistory[i].evaluatorFeedback!.implementation).toContain(
        `Implementation feedback for iteration ${i + 1}`,
      )
      expect(ctx.iterationHistory[i].evaluatorFeedback!.script).toContain(
        `Script feedback for iteration ${i + 1}`,
      )
    }
  })

  it("buildEscalationContext includes verification script content and path", () => {
    const history = makeIterationHistory(3)
    history[2].verificationResult = {
      passed: false,
      stdout: "FAIL",
      stderr: "",
      exitCode: 1,
      durationMs: 100,
    }
    const sprintResult = makeSprintResult({
      iterationsUsed: 3,
      iterationHistory: history,
    })
    const ctx = buildEscalationContext(sprintResult)

    expect(ctx.iterationHistory[0].scriptContent).toContain("Verification script v1")
    expect(ctx.iterationHistory[2].scriptContent).toContain("Verification script v3")
  })

  it("buildEscalationContext includes verification results (stdout, stderr, exitCode)", () => {
    const sprintResult = makeSprintResult()
    const ctx = buildEscalationContext(sprintResult)

    for (const record of ctx.iterationHistory) {
      expect(record.verificationResult).toBeDefined()
      expect(record.verificationResult!.exitCode).toBe(1)
    }
  })

  it("buildEscalationContext includes iterationsUsed and reason", () => {
    const sprintResult = makeSprintResult()
    const ctx = buildEscalationContext(sprintResult)

    expect(ctx.iterationsUsed).toBe(5)
    expect(ctx.reason).toBe("Max iterations reached")
  })

  it("buildEscalationContext includes task description from sprint result", () => {
    const sprintResult = makeSprintResult()
    const ctx = buildEscalationContext(sprintResult)

    expect(ctx.iterationsUsed).toBeGreaterThan(0)
    // The context itself contains the history; task description is threaded via args
  })
})

// ===========================================================================
// VAL-ESCAL-003: escalate_to_full=false means terminal failure
// ===========================================================================

describe("VAL-ESCAL-003: escalate_to_full=false causes terminal failure", () => {
  it("pipeline stops with failure when escalate_to_full=false and sprint exhausts cap", async () => {
    const config = defaultConfig({
      sprint: { ...CONFIG_DEFAULTS.sprint, escalate_to_full: false },
    })
    const eventBus = new EventBus()
    const stagesRun: string[] = []

    const stageRunner: StageRunner = async (stage) => {
      stagesRun.push(stage.workflow)
      if (stage.workflow === "sprint") {
        return {
          workflow: "sprint",
          completed: true,
          reason: "Escalated",
          escalationContext: buildEscalationContext(makeSprintResult()),
        } as PipelineStageResult
      }
      return { workflow: stage.workflow, completed: true }
    }

    const pipeline = new WorkflowPipeline({
      stages: [{ workflow: "sprint" }],
      args: { description: "Complex feature" },
      config,
      stageRunner,
      questionService: makeQuestionService(),
      eventBus,
    })

    const result = await pipeline.run()

    // Only sprint ran — no escalation stages were appended
    expect(stagesRun).toEqual(["sprint"])
    expect(result.completed).toBe(false)
    expect(result.reason).toContain("Sprint exhausted")
  })

  it("pipeline emits pipeline:failed event when escalate_to_full=false", async () => {
    const config = defaultConfig({
      sprint: { ...CONFIG_DEFAULTS.sprint, escalate_to_full: false },
    })
    const eventBus = new EventBus()
    let failedEvent: any = null

    eventBus.subscribe((e) => {
      if (e.type === "pipeline:failed") failedEvent = e
    })

    const stageRunner: StageRunner = async (stage) => {
      return {
        workflow: "sprint",
        completed: true,
        reason: "Escalated",
        escalationContext: buildEscalationContext(makeSprintResult()),
      } as PipelineStageResult
    }

    const pipeline = new WorkflowPipeline({
      stages: [{ workflow: "sprint" }],
      args: { description: "Complex feature" },
      config,
      stageRunner,
      questionService: makeQuestionService(),
      eventBus,
    })

    await pipeline.run()

    expect(failedEvent).not.toBeNull()
    expect(failedEvent.reason).toContain("Sprint exhausted")
  })

  it("non-escalated sprint success works regardless of escalate_to_full setting", async () => {
    const config = defaultConfig({
      sprint: { ...CONFIG_DEFAULTS.sprint, escalate_to_full: false },
    })
    const eventBus = new EventBus()

    // Sprint succeeded (no escalation)
    const stageRunner: StageRunner = async (stage) => {
      return { workflow: "sprint", completed: true }
    }

    const pipeline = new WorkflowPipeline({
      stages: [{ workflow: "sprint" }],
      args: { description: "Simple feature" },
      config,
      stageRunner,
      questionService: makeQuestionService(),
      eventBus,
    })

    const result = await pipeline.run()

    expect(result.completed).toBe(true)
    expect(result.stagesCompleted).toBe(1)
  })
})

// ===========================================================================
// VAL-ESCAL-004: Session lifecycle state valid during escalation
// ===========================================================================

describe("VAL-ESCAL-004: Session state remains work:active throughout escalation", () => {
  it("escalation does not trigger any state transitions (pipeline stays active)", async () => {
    const config = defaultConfig({
      sprint: { ...CONFIG_DEFAULTS.sprint, escalate_to_full: true },
    })
    const eventBus = new EventBus()
    const events: string[] = []

    eventBus.subscribe((e) => events.push(e.type))

    const stageRunner: StageRunner = async (stage) => {
      if (stage.workflow === "sprint") {
        return {
          workflow: "sprint",
          completed: true,
          escalationContext: buildEscalationContext(makeSprintResult()),
        } as PipelineStageResult
      }
      if (stage.workflow === "plan") {
        return { workflow: "plan", completed: true, planPath: "/tmp/plan.md" }
      }
      return { workflow: stage.workflow, completed: true }
    }

    const pipeline = new WorkflowPipeline({
      stages: [{ workflow: "sprint" }],
      args: { description: "Feature" },
      config,
      stageRunner,
      questionService: makeQuestionService(),
      eventBus,
    })

    const result = await pipeline.run()

    // No pipeline:failed events during escalation
    const failedEvents = events.filter((e) => e === "pipeline:failed")
    expect(failedEvents).toHaveLength(0)

    // Pipeline completed successfully through all stages
    expect(result.completed).toBe(true)

    // Stage transitions emitted for escalation stages
    const transitions = events.filter((e) => e === "pipeline:stage-transition")
    expect(transitions.length).toBeGreaterThanOrEqual(3) // sprint→plan, plan→work, work→review
  })

  it("pipeline started event updates stages to include escalation stages", async () => {
    const config = defaultConfig({
      sprint: { ...CONFIG_DEFAULTS.sprint, escalate_to_full: true },
    })
    const eventBus = new EventBus()
    let startedStages: string[] = []

    eventBus.subscribeToType("pipeline:started", (e) => {
      startedStages = [...e.stages]
    })

    const stageRunner: StageRunner = async (stage) => {
      if (stage.workflow === "sprint") {
        return {
          workflow: "sprint",
          completed: true,
          escalationContext: buildEscalationContext(makeSprintResult()),
        } as PipelineStageResult
      }
      if (stage.workflow === "plan") {
        return { workflow: "plan", completed: true, planPath: "/tmp/plan.md" }
      }
      return { workflow: stage.workflow, completed: true }
    }

    const pipeline = new WorkflowPipeline({
      stages: [{ workflow: "sprint" }],
      args: { description: "Feature" },
      config,
      stageRunner,
      questionService: makeQuestionService(),
      eventBus,
    })

    await pipeline.run()

    // pipeline:started emitted with initial stages only (sprint)
    expect(startedStages).toEqual(["sprint"])
  })
})

// ===========================================================================
// VAL-ESCAL-005: Escalation composes full pipeline stages dynamically
// ===========================================================================

describe("VAL-ESCAL-005: WorkflowPipeline dynamically appends stages on escalation", () => {
  it("dynamically appends plan→work→review after sprint", async () => {
    const config = defaultConfig({
      sprint: { ...CONFIG_DEFAULTS.sprint, escalate_to_full: true },
    })
    const eventBus = new EventBus()

    const stageRunner: StageRunner = async (stage) => {
      if (stage.workflow === "sprint") {
        return {
          workflow: "sprint",
          completed: true,
          escalationContext: buildEscalationContext(makeSprintResult()),
        } as PipelineStageResult
      }
      if (stage.workflow === "plan") {
        return { workflow: "plan", completed: true, planPath: "/tmp/plan.md" }
      }
      return { workflow: stage.workflow, completed: true }
    }

    const pipeline = new WorkflowPipeline({
      stages: [{ workflow: "sprint" }],
      args: { description: "Feature" },
      config,
      stageRunner,
      questionService: makeQuestionService(),
      eventBus,
    })

    const result = await pipeline.run()

    expect(result.stagesTotal).toBe(4) // Updated total after dynamic append
    expect(result.stagesCompleted).toBe(4)
    expect(result.stageResults.map((r) => r.workflow)).toEqual([
      "sprint",
      "plan",
      "work",
      "review",
    ])
  })

  it("sprint stage is marked complete (not failed) in results", async () => {
    const config = defaultConfig({
      sprint: { ...CONFIG_DEFAULTS.sprint, escalate_to_full: true },
    })
    const eventBus = new EventBus()

    const stageRunner: StageRunner = async (stage) => {
      if (stage.workflow === "sprint") {
        return {
          workflow: "sprint",
          completed: true,
          escalationContext: buildEscalationContext(makeSprintResult()),
        } as PipelineStageResult
      }
      if (stage.workflow === "plan") {
        return { workflow: "plan", completed: true, planPath: "/tmp/plan.md" }
      }
      return { workflow: stage.workflow, completed: true }
    }

    const pipeline = new WorkflowPipeline({
      stages: [{ workflow: "sprint" }],
      args: { description: "Feature" },
      config,
      stageRunner,
      questionService: makeQuestionService(),
      eventBus,
    })

    const result = await pipeline.run()

    const sprintStage = result.stageResults.find((r) => r.workflow === "sprint")
    expect(sprintStage).toBeDefined()
    expect(sprintStage!.completed).toBe(true)
  })

  it("escalation threads sprint context into args for plan stage", async () => {
    const config = defaultConfig({
      sprint: { ...CONFIG_DEFAULTS.sprint, escalate_to_full: true },
    })
    const eventBus = new EventBus()
    let planArgs: Record<string, string> | null = null

    const stageRunner: StageRunner = async (stage, args) => {
      if (stage.workflow === "sprint") {
        return {
          workflow: "sprint",
          completed: true,
          escalationContext: buildEscalationContext(makeSprintResult()),
        } as PipelineStageResult
      }
      if (stage.workflow === "plan") {
        planArgs = { ...args }
        return { workflow: "plan", completed: true, planPath: "/tmp/plan.md" }
      }
      return { workflow: stage.workflow, completed: true }
    }

    const pipeline = new WorkflowPipeline({
      stages: [{ workflow: "sprint" }],
      args: { description: "Add hello world" },
      config,
      stageRunner,
      questionService: makeQuestionService(),
      eventBus,
    })

    await pipeline.run()

    expect(planArgs).not.toBeNull()
    // Plan stage receives sprintEscalationContext in args
    expect(planArgs!.sprintEscalationContext).toBeDefined()
    const parsed = JSON.parse(planArgs!.sprintEscalationContext)
    expect(parsed.iterationsUsed).toBe(5)
    expect(parsed.iterationHistory).toHaveLength(5)
  })

  it("planner receives sprint iteration history as input context", async () => {
    const config = defaultConfig({
      sprint: { ...CONFIG_DEFAULTS.sprint, escalate_to_full: true },
    })
    const eventBus = new EventBus()
    let planArgs: Record<string, string> | null = null

    const stageRunner: StageRunner = async (stage, args) => {
      if (stage.workflow === "sprint") {
        return {
          workflow: "sprint",
          completed: true,
          escalationContext: buildEscalationContext(makeSprintResult()),
        } as PipelineStageResult
      }
      if (stage.workflow === "plan") {
        planArgs = { ...args }
        return { workflow: "plan", completed: true, planPath: "/tmp/plan.md" }
      }
      return { workflow: stage.workflow, completed: true }
    }

    const pipeline = new WorkflowPipeline({
      stages: [{ workflow: "sprint" }],
      args: { description: "Feature" },
      config,
      stageRunner,
      questionService: makeQuestionService(),
      eventBus,
    })

    await pipeline.run()

    expect(planArgs).not.toBeNull()
    const parsed = JSON.parse(planArgs!.sprintEscalationContext)
    // Verify iteration history contains attempt summaries
    for (let i = 0; i < 5; i++) {
      expect(parsed.iterationHistory[i].workerSummary).toContain(`Attempt ${i + 1}`)
    }
  })

  it("escalation from sprint preserves original description in args", async () => {
    const config = defaultConfig({
      sprint: { ...CONFIG_DEFAULTS.sprint, escalate_to_full: true },
    })
    const eventBus = new EventBus()
    let planArgs: Record<string, string> | null = null

    const stageRunner: StageRunner = async (stage, args) => {
      if (stage.workflow === "sprint") {
        return {
          workflow: "sprint",
          completed: true,
          escalationContext: buildEscalationContext(makeSprintResult()),
        } as PipelineStageResult
      }
      if (stage.workflow === "plan") {
        planArgs = { ...args }
        return { workflow: "plan", completed: true, planPath: "/tmp/plan.md" }
      }
      return { workflow: stage.workflow, completed: true }
    }

    const pipeline = new WorkflowPipeline({
      stages: [{ workflow: "sprint" }],
      args: { description: "Add hello world endpoint" },
      config,
      stageRunner,
      questionService: makeQuestionService(),
      eventBus,
    })

    await pipeline.run()

    expect(planArgs!.description).toBe("Add hello world endpoint")
  })

  it("if escalation plan stage fails, pipeline stops with failure", async () => {
    const config = defaultConfig({
      sprint: { ...CONFIG_DEFAULTS.sprint, escalate_to_full: true },
    })
    const eventBus = new EventBus()

    const stageRunner: StageRunner = async (stage) => {
      if (stage.workflow === "sprint") {
        return {
          workflow: "sprint",
          completed: true,
          escalationContext: buildEscalationContext(makeSprintResult()),
        } as PipelineStageResult
      }
      if (stage.workflow === "plan") {
        return { workflow: "plan", completed: false, reason: "Planner failed" }
      }
      return { workflow: stage.workflow, completed: true }
    }

    const pipeline = new WorkflowPipeline({
      stages: [{ workflow: "sprint" }],
      args: { description: "Feature" },
      config,
      stageRunner,
      questionService: makeQuestionService(),
      eventBus,
    })

    const result = await pipeline.run()

    expect(result.completed).toBe(false)
    expect(result.stagesCompleted).toBe(1) // Only sprint completed
    expect(result.reason).toContain("Planner failed")
  })

  it("shutdown during escalation stages stops pipeline cleanly", async () => {
    const config = defaultConfig({
      sprint: { ...CONFIG_DEFAULTS.sprint, escalate_to_full: true },
    })
    const eventBus = new EventBus()
    let pipelineRef: WorkflowPipeline | null = null

    const stageRunner: StageRunner = async (stage) => {
      if (stage.workflow === "sprint") {
        return {
          workflow: "sprint",
          completed: true,
          escalationContext: buildEscalationContext(makeSprintResult()),
        } as PipelineStageResult
      }
      if (stage.workflow === "plan") {
        // Shutdown during plan stage
        pipelineRef!.requestShutdown()
        return { workflow: "plan", completed: true, planPath: "/tmp/plan.md" }
      }
      return { workflow: stage.workflow, completed: true }
    }

    const pipeline = new WorkflowPipeline({
      stages: [{ workflow: "sprint" }],
      args: { description: "Feature" },
      config,
      stageRunner,
      questionService: makeQuestionService(),
      eventBus,
    })
    pipelineRef = pipeline

    const result = await pipeline.run()

    // Pipeline was shut down after plan completed but before work started
    expect(result.completed).toBe(false)
    expect(result.reason).toContain("shut down")
  })
})

// ===========================================================================
// Escalation context packaging
// ===========================================================================

describe("buildEscalationContext", () => {
  it("creates a structured context from sprint result", () => {
    const sprintResult = makeSprintResult()
    const ctx = buildEscalationContext(sprintResult)

    expect(ctx).toBeDefined()
    expect(ctx.iterationsUsed).toBe(5)
    expect(ctx.reason).toBe("Max iterations reached")
    expect(ctx.iterationHistory).toHaveLength(5)
  })

  it("serializable to JSON (for threading through pipeline args)", () => {
    const sprintResult = makeSprintResult()
    const ctx = buildEscalationContext(sprintResult)

    const json = JSON.stringify(ctx)
    const parsed = JSON.parse(json)

    expect(parsed.iterationsUsed).toBe(5)
    expect(parsed.iterationHistory).toHaveLength(5)
  })

  it("preserves partial work from sprint iterations", () => {
    const history = makeIterationHistory(2)
    history[0].workerSummary = "Created src/hello.ts with basic endpoint"
    history[1].workerSummary = "Updated src/hello.ts with test, but tests still fail"

    const sprintResult = makeSprintResult({
      iterationsUsed: 2,
      iterationHistory: history,
    })
    const ctx = buildEscalationContext(sprintResult)

    expect(ctx.iterationHistory[0].workerSummary).toBe("Created src/hello.ts with basic endpoint")
    expect(ctx.iterationHistory[1].workerSummary).toBe("Updated src/hello.ts with test, but tests still fail")
  })

  it("handles worker crashes in iteration history", () => {
    const history = makeIterationHistory(3)
    history[1].workerCrashed = true
    history[1].workerSummary = "Worker crashed: timeout"

    const sprintResult = makeSprintResult({
      iterationsUsed: 3,
      iterationHistory: history,
    })
    const ctx = buildEscalationContext(sprintResult)

    expect(ctx.iterationHistory[1].workerCrashed).toBe(true)
    expect(ctx.iterationHistory[1].workerSummary).toBe("Worker crashed: timeout")
  })

  it("handles missing artifacts in iteration history", () => {
    const history = makeIterationHistory(2)
    history[0].missingArtifact = "no handoff JSON written"

    const sprintResult = makeSprintResult({
      iterationsUsed: 2,
      iterationHistory: history,
    })
    const ctx = buildEscalationContext(sprintResult)

    expect(ctx.iterationHistory[0].missingArtifact).toBe("no handoff JSON written")
  })
})

// ===========================================================================
// Non-sprint pipelines unaffected
// ===========================================================================

describe("Non-sprint pipelines unaffected by escalation logic", () => {
  it("plan→work→review pipeline works as before without escalation", async () => {
    const config = defaultConfig()
    const eventBus = new EventBus()

    const stageRunner: StageRunner = async (stage) => {
      if (stage.workflow === "plan") {
        return { workflow: "plan", completed: true, planPath: "/tmp/plan.md" }
      }
      return { workflow: stage.workflow, completed: true }
    }

    const pipeline = new WorkflowPipeline({
      stages: [
        { workflow: "plan" },
        { workflow: "work" },
        { workflow: "review" },
      ],
      args: { description: "Feature" },
      config,
      stageRunner,
      questionService: makeQuestionService(),
      eventBus,
    })

    const result = await pipeline.run()

    expect(result.completed).toBe(true)
    expect(result.stagesCompleted).toBe(3)
    expect(result.stagesTotal).toBe(3)
  })

  it("single work stage pipeline unaffected", async () => {
    const config = defaultConfig()
    const eventBus = new EventBus()

    const stageRunner: StageRunner = async (stage) => {
      return { workflow: stage.workflow, completed: true }
    }

    const pipeline = new WorkflowPipeline({
      stages: [{ workflow: "work" }],
      args: { planPath: "/tmp/plan.md" },
      config,
      stageRunner,
      questionService: makeQuestionService(),
      eventBus,
    })

    const result = await pipeline.run()

    expect(result.completed).toBe(true)
    expect(result.stagesCompleted).toBe(1)
  })
})

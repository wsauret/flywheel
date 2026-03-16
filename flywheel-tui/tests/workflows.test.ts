import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { WorkflowDefinitionSchema } from "../src/schemas/workflow";
import type { WorkflowDefinition } from "../src/schemas/workflow";
import { planWorkflow } from "../src/workflows/plan";
import { reviewWorkflow } from "../src/workflows/review";
import { shipWorkflow } from "../src/workflows/ship";
import { debugWorkflow } from "../src/workflows/debug";
import { researchWorkflow } from "../src/workflows/research";
import { workflowRegistry, buildWorkflowPrompt } from "../src/workflows/index";
import { StepExecutor } from "../src/workflows/step-executor";
import { WorkflowRunner } from "../src/workflows/workflow-runner";
import type { WorkflowRunResult } from "../src/workflows/workflow-runner";
import { EventBus, createFlywheelEmitter } from "../src/events/event-bus";
import type { FlywheelEvent } from "../src/events/types";
import type { ProcessSpawner } from "../src/worker/spawner";
import type { WorkerResult } from "../src/schemas/worker";
import type { IWorkflowUI } from "../src/tui/adapters/types";
import type { FlywheelConfig } from "../src/config/loader";
import { CONFIG_DEFAULTS } from "../src/config/loader";
import { parseArgs } from "../src/cli/args";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeWorkerResult(output = "step output"): WorkerResult {
  return {
    output,
    exitCode: 0,
    truncated: false,
    durationMs: 100,
  };
}

function makeMockSpawner(result?: WorkerResult): ProcessSpawner {
  return {
    spawn: mock(async () => result ?? makeWorkerResult()),
  };
}

function makeMockEngine() {
  return {
    metadata: {
      id: "test",
      name: "Test Engine",
      cliBinary: "test-cli",
      defaultModel: "test-model",
      installCommand: "npm install test",
      description: "Test engine",
    },
    buildCommand: mock(() => ({
      command: "echo",
      args: ["test"],
      stdinPrompt: false,
    })),
    listModels: mock(async () => []),
  };
}

function makeMockUI(): IWorkflowUI {
  return {
    adapterType: "mock" as const,
    connect: mock(() => {}),
    disconnect: mock(() => {}),
    start: mock(() => {}),
    stop: mock(() => {}),
    isRunning: mock(() => true),
    isConnected: mock(() => true),
  };
}

const testConfig: FlywheelConfig = {
  ...CONFIG_DEFAULTS,
};

// ---------------------------------------------------------------------------
// Workflow Definitions
// ---------------------------------------------------------------------------

describe("Workflow Definitions", () => {
  describe("planWorkflow", () => {
    it("has 4 steps", () => {
      expect(planWorkflow.steps).toHaveLength(4);
    });

    it("is named 'plan'", () => {
      expect(planWorkflow.name).toBe("plan");
    });

    it("has a description", () => {
      expect(planWorkflow.description.length).toBeGreaterThan(0);
    });

    it("conforms to WorkflowDefinitionSchema", () => {
      const result = WorkflowDefinitionSchema.safeParse(planWorkflow);
      expect(result.success).toBe(true);
    });

    it("each step has a description", () => {
      for (const step of planWorkflow.steps) {
        expect(step.description.length).toBeGreaterThan(0);
      }
    });

    it("steps cover research, draft, review, consolidate", () => {
      expect(planWorkflow.steps[0].description).toContain("Research");
      expect(planWorkflow.steps[1].description).toContain("Draft");
      expect(planWorkflow.steps[2].description).toContain("Review");
      expect(planWorkflow.steps[3].description).toContain("Consolidate");
    });
  });

  describe("reviewWorkflow", () => {
    it("has 3 steps", () => {
      expect(reviewWorkflow.steps).toHaveLength(3);
    });

    it("is named 'review'", () => {
      expect(reviewWorkflow.name).toBe("review");
    });

    it("conforms to WorkflowDefinitionSchema", () => {
      const result = WorkflowDefinitionSchema.safeParse(reviewWorkflow);
      expect(result.success).toBe(true);
    });

    it("steps cover diff, review, consolidate", () => {
      expect(reviewWorkflow.steps[0].description).toContain("diff");
      expect(reviewWorkflow.steps[1].description).toContain("review");
      expect(reviewWorkflow.steps[2].description).toContain("Consolidate");
    });
  });

  describe("shipWorkflow", () => {
    it("has 4 steps", () => {
      expect(shipWorkflow.steps).toHaveLength(4);
    });

    it("is named 'ship'", () => {
      expect(shipWorkflow.name).toBe("ship");
    });

    it("conforms to WorkflowDefinitionSchema", () => {
      const result = WorkflowDefinitionSchema.safeParse(shipWorkflow);
      expect(result.success).toBe(true);
    });

    it("steps cover stage, commit, PR, learnings", () => {
      expect(shipWorkflow.steps[0].description).toContain("stage");
      expect(shipWorkflow.steps[1].description).toContain("commit");
      expect(shipWorkflow.steps[2].description).toContain("pull request");
      expect(shipWorkflow.steps[3].description).toContain("learnings");
    });
  });

  describe("debugWorkflow", () => {
    it("has 3 steps", () => {
      expect(debugWorkflow.steps).toHaveLength(3);
    });

    it("is named 'debug'", () => {
      expect(debugWorkflow.name).toBe("debug");
    });

    it("conforms to WorkflowDefinitionSchema", () => {
      const result = WorkflowDefinitionSchema.safeParse(debugWorkflow);
      expect(result.success).toBe(true);
    });

    it("steps cover investigate, fix, verify", () => {
      expect(debugWorkflow.steps[0].description).toContain("Investigate");
      expect(debugWorkflow.steps[1].description).toContain("Fix");
      expect(debugWorkflow.steps[2].description).toContain("Verify");
    });
  });

  describe("researchWorkflow", () => {
    it("has 3 steps", () => {
      expect(researchWorkflow.steps).toHaveLength(3);
    });

    it("is named 'research'", () => {
      expect(researchWorkflow.name).toBe("research");
    });

    it("conforms to WorkflowDefinitionSchema", () => {
      const result = WorkflowDefinitionSchema.safeParse(researchWorkflow);
      expect(result.success).toBe(true);
    });

    it("steps cover locate, analyze, persist", () => {
      expect(researchWorkflow.steps[0].description).toContain("Locate");
      expect(researchWorkflow.steps[1].description).toContain("Analyze");
      expect(researchWorkflow.steps[2].description).toContain("Persist");
    });
  });

  describe("workflowRegistry", () => {
    it("contains all 5 non-work workflows", () => {
      expect(Object.keys(workflowRegistry)).toHaveLength(5);
      expect(workflowRegistry.plan).toBeDefined();
      expect(workflowRegistry.review).toBeDefined();
      expect(workflowRegistry.ship).toBeDefined();
      expect(workflowRegistry.debug).toBeDefined();
      expect(workflowRegistry.research).toBeDefined();
    });

    it("all registry entries conform to schema", () => {
      for (const [_name, workflow] of Object.entries(workflowRegistry)) {
        const result = WorkflowDefinitionSchema.safeParse(workflow);
        expect(result.success).toBe(true);
      }
    });

    it("does not contain 'work' (work uses dedicated WorkController)", () => {
      expect(workflowRegistry.work).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Prompt Builder
// ---------------------------------------------------------------------------

describe("buildWorkflowPrompt", () => {
  it("produces non-empty prompts for all plan steps", () => {
    for (let i = 0; i < planWorkflow.steps.length; i++) {
      const prompt = buildWorkflowPrompt(i, planWorkflow, {
        description: "Build auth system",
      });
      expect(typeof prompt).toBe("string");
      expect(prompt.length).toBeGreaterThan(0);
    }
  });

  it("produces non-empty prompts for all review steps", () => {
    for (let i = 0; i < reviewWorkflow.steps.length; i++) {
      const prompt = buildWorkflowPrompt(i, reviewWorkflow, {});
      expect(typeof prompt).toBe("string");
      expect(prompt.length).toBeGreaterThan(0);
    }
  });

  it("produces non-empty prompts for all ship steps", () => {
    for (let i = 0; i < shipWorkflow.steps.length; i++) {
      const prompt = buildWorkflowPrompt(i, shipWorkflow, {});
      expect(typeof prompt).toBe("string");
      expect(prompt.length).toBeGreaterThan(0);
    }
  });

  it("produces non-empty prompts for all debug steps", () => {
    for (let i = 0; i < debugWorkflow.steps.length; i++) {
      const prompt = buildWorkflowPrompt(i, debugWorkflow, {
        description: "Test failure in auth module",
      });
      expect(typeof prompt).toBe("string");
      expect(prompt.length).toBeGreaterThan(0);
    }
  });

  it("produces non-empty prompts for all research steps", () => {
    for (let i = 0; i < researchWorkflow.steps.length; i++) {
      const prompt = buildWorkflowPrompt(i, researchWorkflow, {
        topic: "Authentication patterns",
      });
      expect(typeof prompt).toBe("string");
      expect(prompt.length).toBeGreaterThan(0);
    }
  });

  it("includes description in plan prompts", () => {
    const prompt = buildWorkflowPrompt(0, planWorkflow, {
      description: "JWT authentication system",
    });
    expect(prompt).toContain("JWT authentication system");
  });

  it("includes topic in research prompts", () => {
    const prompt = buildWorkflowPrompt(0, researchWorkflow, {
      topic: "Event sourcing patterns",
    });
    expect(prompt).toContain("Event sourcing patterns");
  });

  it("passes previousResult through to prompt context", () => {
    const prompt = buildWorkflowPrompt(
      1,
      planWorkflow,
      { description: "test feature" },
      "Previous step found 3 relevant files",
    );
    expect(prompt).toContain("Previous step found 3 relevant files");
  });

  it("includes projectCwd when provided", () => {
    const prompt = buildWorkflowPrompt(
      0,
      planWorkflow,
      { description: "test" },
      undefined,
      "/home/user/project",
    );
    expect(prompt).toContain("/home/user/project");
  });

  it("falls back to generic prompt for out-of-range step index", () => {
    const prompt = buildWorkflowPrompt(99, planWorkflow, {
      description: "test",
    });
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// StepExecutor
// ---------------------------------------------------------------------------

describe("StepExecutor", () => {
  it("delegates to ProcessSpawner via PhaseExecutor", async () => {
    const spawner = makeMockSpawner();
    const engine = makeMockEngine();
    const eventBus = new EventBus();
    const emitter = createFlywheelEmitter(eventBus);

    const executor = new StepExecutor({
      spawner,
      emitter,
      engine,
      config: testConfig,
      workflowId: "test-workflow",
    });

    const result = await executor.executeStep({
      stepIndex: 0,
      prompt: "test prompt",
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("step output");
    expect(spawner.spawn).toHaveBeenCalled();
  });

  it("passes cwd to spawner", async () => {
    const spawner = makeMockSpawner();
    const engine = makeMockEngine();
    const eventBus = new EventBus();
    const emitter = createFlywheelEmitter(eventBus);

    const executor = new StepExecutor({
      spawner,
      emitter,
      engine,
      config: testConfig,
      workflowId: "test-workflow",
    });

    await executor.executeStep({
      stepIndex: 0,
      prompt: "test prompt",
      cwd: "/test/dir",
    });

    const spawnCall = (spawner.spawn as ReturnType<typeof mock>).mock.calls[0];
    expect(spawnCall[2]?.cwd).toBe("/test/dir");
  });

  it("emits worker events", async () => {
    const spawner = makeMockSpawner();
    const engine = makeMockEngine();
    const eventBus = new EventBus();
    const emitter = createFlywheelEmitter(eventBus);
    const events: FlywheelEvent[] = [];

    eventBus.subscribe((e) => events.push(e));

    const executor = new StepExecutor({
      spawner,
      emitter,
      engine,
      config: testConfig,
      workflowId: "test-workflow",
    });

    await executor.executeStep({
      stepIndex: 0,
      prompt: "test prompt",
    });

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("worker:spawned");
    expect(eventTypes).toContain("worker:completed");
  });
});

// ---------------------------------------------------------------------------
// WorkflowRunner
// ---------------------------------------------------------------------------

describe("WorkflowRunner", () => {
  it("executes steps sequentially and emits events", async () => {
    const spawner = makeMockSpawner();
    const engine = makeMockEngine();
    const eventBus = new EventBus();
    const emitter = createFlywheelEmitter(eventBus);
    const ui = makeMockUI();
    const events: FlywheelEvent[] = [];

    eventBus.subscribe((e) => events.push(e));

    const executor = new StepExecutor({
      spawner,
      emitter,
      engine,
      config: testConfig,
      workflowId: "test-runner",
    });

    const runner = new WorkflowRunner({
      workflow: reviewWorkflow, // 3 steps
      executor,
      emitter,
      ui,
      config: testConfig,
      promptBuilder: (i, wf) => `Prompt for step ${i}: ${wf.steps[i].description}`,
    });

    const result = await runner.run();

    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(3);
    expect(result.stepsTotal).toBe(3);

    // Check event sequence
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes[0]).toBe("workflow:started");

    // Each step: phase:started, worker:spawned, worker:completed, phase:completed
    expect(eventTypes).toContain("phase:started");
    expect(eventTypes).toContain("phase:completed");
    expect(eventTypes[eventTypes.length - 1]).toBe("workflow:completed");
  });

  it("returns partial result on step failure", async () => {
    const failSpawner: ProcessSpawner = {
      spawn: mock(async () => {
        throw new Error("Worker crashed");
      }),
    };
    const engine = makeMockEngine();
    const eventBus = new EventBus();
    const emitter = createFlywheelEmitter(eventBus);
    const ui = makeMockUI();

    const executor = new StepExecutor({
      spawner: failSpawner,
      emitter,
      engine,
      config: { ...testConfig, max_retries: 0 },
      workflowId: "test-fail",
    });

    const runner = new WorkflowRunner({
      workflow: reviewWorkflow,
      executor,
      emitter,
      ui,
      config: { ...testConfig, max_retries: 0 },
      promptBuilder: () => "test prompt",
    });

    const result = await runner.run();

    expect(result.completed).toBe(false);
    expect(result.stepsCompleted).toBe(0);
    expect(result.stepsTotal).toBe(3);
    expect(result.reason).toBeDefined();
  });

  it("handles shutdown gracefully", async () => {
    const spawner = makeMockSpawner();
    const engine = makeMockEngine();
    const eventBus = new EventBus();
    const emitter = createFlywheelEmitter(eventBus);
    const ui = makeMockUI();

    const executor = new StepExecutor({
      spawner,
      emitter,
      engine,
      config: testConfig,
      workflowId: "test-shutdown",
    });

    const runner = new WorkflowRunner({
      workflow: planWorkflow, // 4 steps
      executor,
      emitter,
      ui,
      config: testConfig,
      promptBuilder: () => "test prompt",
    });

    // Request shutdown before running
    runner.requestShutdown();

    const result = await runner.run();

    expect(result.completed).toBe(false);
    expect(result.stepsCompleted).toBe(0);
    expect(result.reason).toBe("Shutdown requested");
  });

  it("passes previous step output to promptBuilder", async () => {
    const spawner = makeMockSpawner(makeWorkerResult("step 0 output"));
    const engine = makeMockEngine();
    const eventBus = new EventBus();
    const emitter = createFlywheelEmitter(eventBus);
    const ui = makeMockUI();

    const executor = new StepExecutor({
      spawner,
      emitter,
      engine,
      config: testConfig,
      workflowId: "test-chain",
    });

    const capturedPrevResults: (string | undefined)[] = [];

    // Use a 2-step workflow to test chaining
    const twoStepWorkflow: WorkflowDefinition = {
      name: "test",
      description: "Two-step test",
      steps: [
        { description: "Step 1" },
        { description: "Step 2" },
      ],
    };

    const runner = new WorkflowRunner({
      workflow: twoStepWorkflow,
      executor,
      emitter,
      ui,
      config: testConfig,
      promptBuilder: (_i, _wf, prevResult) => {
        capturedPrevResults.push(prevResult);
        return "test prompt";
      },
    });

    await runner.run();

    expect(capturedPrevResults).toHaveLength(2);
    expect(capturedPrevResults[0]).toBeUndefined(); // First step has no previous
    expect(capturedPrevResults[1]).toBe("step 0 output"); // Second gets first's output
  });

  it("emits workflow:failed on step failure", async () => {
    const failSpawner: ProcessSpawner = {
      spawn: mock(async () => {
        throw new Error("Boom");
      }),
    };
    const engine = makeMockEngine();
    const eventBus = new EventBus();
    const emitter = createFlywheelEmitter(eventBus);
    const ui = makeMockUI();
    const events: FlywheelEvent[] = [];

    eventBus.subscribe((e) => events.push(e));

    const executor = new StepExecutor({
      spawner: failSpawner,
      emitter,
      engine,
      config: { ...testConfig, max_retries: 0 },
      workflowId: "test-fail-events",
    });

    const runner = new WorkflowRunner({
      workflow: debugWorkflow,
      executor,
      emitter,
      ui,
      config: { ...testConfig, max_retries: 0 },
      promptBuilder: () => "test prompt",
    });

    await runner.run();

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("workflow:started");
    expect(eventTypes).toContain("phase:started");
    expect(eventTypes).toContain("phase:failed");
    expect(eventTypes).toContain("workflow:failed");
  });

  it("emits workflow:interrupted on shutdown", async () => {
    const spawner = makeMockSpawner();
    const engine = makeMockEngine();
    const eventBus = new EventBus();
    const emitter = createFlywheelEmitter(eventBus);
    const ui = makeMockUI();
    const events: FlywheelEvent[] = [];

    eventBus.subscribe((e) => events.push(e));

    const executor = new StepExecutor({
      spawner,
      emitter,
      engine,
      config: testConfig,
      workflowId: "test-interrupt",
    });

    const runner = new WorkflowRunner({
      workflow: shipWorkflow,
      executor,
      emitter,
      ui,
      config: testConfig,
      promptBuilder: () => "test prompt",
    });

    runner.requestShutdown();
    await runner.run();

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("workflow:started");
    expect(eventTypes).toContain("workflow:interrupted");
  });
});

// ---------------------------------------------------------------------------
// CLI args — workflow subcommands
// ---------------------------------------------------------------------------

describe("CLI args — workflow subcommands", () => {
  it("parses 'plan' command with description", async () => {
    const result = await parseArgs(["plan", "Build JWT auth"]);
    expect(result).not.toBeNull();
    expect(result!.command).toBe("plan");
    if (result!.command === "plan") {
      expect(result!.description).toBe("Build JWT auth");
    }
  });

  it("parses 'review' command with no args", async () => {
    const result = await parseArgs(["review"]);
    expect(result).not.toBeNull();
    expect(result!.command).toBe("review");
  });

  it("parses 'ship' command with no args", async () => {
    const result = await parseArgs(["ship"]);
    expect(result).not.toBeNull();
    expect(result!.command).toBe("ship");
  });

  it("parses 'debug' command with description", async () => {
    const result = await parseArgs(["debug", "Auth test fails"]);
    expect(result).not.toBeNull();
    expect(result!.command).toBe("debug");
    if (result!.command === "debug") {
      expect(result!.description).toBe("Auth test fails");
    }
  });

  it("parses 'research' command with topic", async () => {
    const result = await parseArgs(["research", "Event sourcing"]);
    expect(result).not.toBeNull();
    expect(result!.command).toBe("research");
    if (result!.command === "research") {
      expect(result!.topic).toBe("Event sourcing");
    }
  });

  it("'work <path>' subcommand works", async () => {
    const result = await parseArgs(["work", "plan.md"]);
    expect(result).not.toBeNull();
    expect(result!.command).toBe("work");
  });

  it("existing TUI mode (no args) still works", async () => {
    const result = await parseArgs([]);
    expect(result).toEqual({ command: "tui" });
  });
});

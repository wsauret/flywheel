import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import type { DispatcherDecision, DispatcherInput } from "../src/schemas/dispatcher";
import type { DispatcherTransport } from "../src/dispatcher/transport";
import type { ProcessSpawner, SpawnOptions } from "../src/worker/spawner";
import type { WorkerResult } from "../src/schemas/worker";
import type { FlywheelEvent } from "../src/events/types";
import type { FlywheelConfig } from "../src/config/loader";
import { DispatcherDecisionSchema } from "../src/schemas/dispatcher";
import { EventBus, createFlywheelEmitter } from "../src/events/event-bus";
import { CONFIG_DEFAULTS } from "../src/config/loader";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TWO_PHASE_PLAN = `# Implementation Plan: Test

## Overview
A test plan.

### Phase 1: Setup project structure

Create the initial project structure and configuration.

- [ ] Create directory layout
- [ ] Initialize configuration files

### Phase 2: Implement core logic

Build the main application logic.

- [ ] Write data models
- [ ] Add validation layer
`;

const STATE_CONTENT_PHASE1_DONE = `---
plan: test.md
status: in_progress
schema_version: 3
---

# Execution State: test

## Progress
- [x] Phase 1: Setup project structure
- [ ] Phase 2: Implement core logic

## Key Decisions
- Used TDD approach

## Error Log
| Error | Attempt | Approach | Outcome |
|-------|---------|----------|---------|
`;

const STATE_CONTENT_ALL_PENDING = `---
plan: test.md
status: in_progress
schema_version: 3
---

# Execution State: test

## Progress
- [ ] Phase 1: Setup project structure
- [ ] Phase 2: Implement core logic

## Error Log
| Error | Attempt | Approach | Outcome |
|-------|---------|----------|---------|
`;

function validDecision(overrides?: Partial<DispatcherDecision>): DispatcherDecision {
  return {
    schema_version: 1,
    phase_index: 0,
    step_index: 0,
    prompt: "Execute the setup phase by creating directory layout",
    context_files: ["src/index.ts"],
    validation_criteria: {
      acceptance_criteria: ["Tests pass"],
      required_tests: true,
      custom_checks: [],
      required_outputs: [],
    },
    reasoning: "Standard setup phase execution",
    warnings: [],
    worker_config: {
      model_override: null,
      timeout_minutes: 30,
      retry_on_failure: true,
      max_retries: 3,
      iteration_budget: 5,
      tool_scoping: { read: true, bash: true, write: true, edit: true },
      parallel: false,
      parallel_variants: null,
    },
    ...overrides,
  };
}

function defaultConfig(overrides?: Partial<FlywheelConfig>): FlywheelConfig {
  return { ...CONFIG_DEFAULTS, ...overrides };
}

const baseWorkflowContext = {
  workflowId: "wf-test-001",
  name: "work",
  stepNumber: 1,
  totalSteps: 2,
  stepDescription: "Setup",
};

const baseConfigContext = {
  maxEvalCycles: 3,
  worktreePath: "/tmp/wt",
  projectCwd: "/tmp/proj",
  workerModel: "opus",
  dispatcherModel: "opus",
};

const baseSessionBudget = {
  invocations_remaining: 100,
  token_budget_remaining: null as number | null,
  wall_clock_deadline: null as string | null,
};

const baseAvailableContext = {
  conventions: [] as { name: string; path: string; summary: string }[],
  standards: [] as { name: string; path: string; summary: string }[],
  learnings: [] as { name: string; path: string; summary: string }[],
};

/** Base assembler input with all required fields */
function baseAssemblerInput(overrides?: Partial<import("../src/dispatcher/assemble").AssemblerInput>): import("../src/dispatcher/assemble").AssemblerInput {
  return {
    planContent: TWO_PHASE_PLAN,
    stateContent: STATE_CONTENT_ALL_PENDING,
    workflowContext: baseWorkflowContext,
    configContext: baseConfigContext,
    sessionBudget: baseSessionBudget,
    availableContext: baseAvailableContext,
    ...overrides,
  };
}

/** Base DispatcherInput with all required fields */
function baseDispatcherInput(overrides?: Partial<DispatcherInput>): DispatcherInput {
  return {
    plan: { phases: [{ name: "Phase 1", steps: [{ description: "step 1" }] }] },
    state: { completed_phases: [], current_phase_index: 0 },
    context: { files: [] },
    plan_truncated: false,
    history_truncated: false,
    workflow_id: "wf-test-001",
    workflow: { name: "work", step_number: 1, total_steps: 2, step_description: "Setup" },
    last_worker_result: null,
    config: { max_eval_cycles: 3, worktree_path: "/tmp/wt", project_cwd: "/tmp/proj", worker_model: "opus", dispatcher_model: "opus" },
    session_budget: { invocations_remaining: 100, token_budget_remaining: null, wall_clock_deadline: null },
    available_context: { conventions: [], standards: [], learnings: [] },
    ...overrides,
  };
}

/** Base PhasePromptOptions for dispatcher orchestrator tests */
const basePhasePromptOptions = {
  workflowContext: baseWorkflowContext,
  configContext: baseConfigContext,
  sessionBudget: baseSessionBudget,
  availableContext: baseAvailableContext,
};

// ---------------------------------------------------------------------------
// a) DispatcherInput assembler tests
// ---------------------------------------------------------------------------

describe("DispatcherInput assembler", () => {
  // Lazy import to allow tests to be written before implementation
  let assembleDispatcherInput: typeof import("../src/dispatcher/assemble").assembleDispatcherInput;

  beforeEach(async () => {
    const mod = await import("../src/dispatcher/assemble");
    assembleDispatcherInput = mod.assembleDispatcherInput;
  });

  it("assembles DispatcherInput from plan phases, state, and context", () => {
    const result = assembleDispatcherInput(baseAssemblerInput({
      planContent: TWO_PHASE_PLAN,
      stateContent: STATE_CONTENT_PHASE1_DONE,
    }));

    expect(result.input.plan.phases).toHaveLength(2);
    expect(result.input.plan.phases[0].name).toBe("Setup project structure");
    expect(result.input.state.completed_phases).toEqual([0]);
    expect(result.input.state.current_phase_index).toBe(1);
    expect(result.planTruncated).toBe(false);
    expect(result.historyTruncated).toBe(false);
  });

  it("respects 100KB budget", () => {
    // Create moderately large plan content
    const bigStep = "A".repeat(300);
    const bigPhases = Array.from({ length: 10 }, (_, i) =>
      `### Phase ${i + 1}: Phase title ${i}\n\n- [ ] ${bigStep}\n- [ ] ${bigStep}\n`
    ).join("\n");
    const bigPlan = `# Big Plan\n\n## Overview\nTest\n\n${bigPhases}`;

    const result = assembleDispatcherInput(baseAssemblerInput({
      planContent: bigPlan,
      stateContent: STATE_CONTENT_ALL_PENDING,
    }));

    // Plan phases pass through without per-field truncation
    expect(result.input.plan.phases.length).toBeGreaterThan(0);
    // Total serialized size should be under 100KB
    const serialized = JSON.stringify(result.input);
    expect(serialized.length).toBeLessThanOrEqual(102400);
  });

  it("passes plan through without per-field truncation", () => {
    // Plan content that would have exceeded the old 2KB per-field budget
    // but fits easily within the 100KB single cap
    const bigStep = "X".repeat(500);
    const bigPhases = Array.from({ length: 15 }, (_, i) =>
      `### Phase ${i + 1}: Phase title ${i}\n\n- [ ] ${bigStep}\n`
    ).join("\n");
    const bigPlan = `# Big Plan\n\n## Overview\nTest\n\n${bigPhases}`;

    const result = assembleDispatcherInput(baseAssemblerInput({
      planContent: bigPlan,
      stateContent: STATE_CONTENT_ALL_PENDING,
    }));

    // No per-field truncation — plan passes through as-is
    expect(result.planTruncated).toBe(false);
    expect(result.input.plan_truncated).toBe(false);
    expect(result.input.plan.phases).toHaveLength(15);
  });

  it("handles missing context file (empty files array)", () => {
    const result = assembleDispatcherInput(baseAssemblerInput({
      contextContent: undefined,
    }));

    expect(result.input.context.files).toEqual([]);
  });

  it("handles missing state file (all phases pending)", () => {
    const result = assembleDispatcherInput(baseAssemblerInput({
      stateContent: "",
    }));

    expect(result.input.state.completed_phases).toEqual([]);
    expect(result.input.state.current_phase_index).toBe(0);
  });

  it("includes context files when provided", () => {
    const result = assembleDispatcherInput(baseAssemblerInput({
      stateContent: STATE_CONTENT_PHASE1_DONE,
      contextContent: "# Context\n- src/index.ts\n- tests/main.test.ts\n",
    }));

    expect(result.input.context.files).toEqual(["src/index.ts", "tests/main.test.ts"]);
  });

  it("drops unparseable string lastWorkerResult (null result)", () => {
    const bigResult = "B".repeat(2000);
    const result = assembleDispatcherInput(baseAssemblerInput({
      stateContent: STATE_CONTENT_PHASE1_DONE,
      lastWorkerResult: bigResult,
    }));

    // Raw string can't be parsed as LastWorkerResult — should be null
    expect(result.input.last_worker_result).toBeNull();
    // Total stays within budget
    const serialized = JSON.stringify(result.input);
    expect(serialized.length).toBeLessThanOrEqual(102400);
  });

  it("populates last_worker_result from structured LastWorkerResult input", () => {
    const result = assembleDispatcherInput(baseAssemblerInput({
      stateContent: STATE_CONTENT_PHASE1_DONE,
      lastWorkerResult: {
        step: 0,
        status: "completed",
        output_summary: "Created directory structure",
        artifacts_produced: ["src/index.ts"],
        tests_passed: true,
        duration_seconds: 45,
      },
    }));

    expect(result.input.last_worker_result).toBeDefined();
    expect(result.input.last_worker_result!.step).toBe(0);
    expect(result.input.last_worker_result!.status).toBe("completed");
    expect(result.input.last_worker_result!.output_summary).toBe("Created directory structure");
    expect(result.input.last_worker_result!.artifacts_produced).toEqual(["src/index.ts"]);
    expect(result.input.last_worker_result!.tests_passed).toBe(true);
    expect(result.input.last_worker_result!.duration_seconds).toBe(45);
  });

  it("parses JSON string lastWorkerResult into structured last_worker_result", () => {
    const structured = {
      step: 1,
      status: "completed",
      output_summary: "Implemented validation layer",
      artifacts_produced: ["src/validate.ts"],
      tests_passed: null,
      duration_seconds: 120,
    };
    const result = assembleDispatcherInput(baseAssemblerInput({
      stateContent: STATE_CONTENT_PHASE1_DONE,
      lastWorkerResult: JSON.stringify(structured),
    }));

    expect(result.input.last_worker_result).toBeDefined();
    expect(result.input.last_worker_result!.step).toBe(1);
    expect(result.input.last_worker_result!.status).toBe("completed");
  });

  it("populates required fields: workflowContext, configContext, sessionBudget, availableContext", () => {
    const result = assembleDispatcherInput({
      planContent: TWO_PHASE_PLAN,
      stateContent: STATE_CONTENT_ALL_PENDING,
      workflowContext: {
        workflowId: "wf-123",
        name: "work",
        stepNumber: 1,
        totalSteps: 2,
        stepDescription: "Setup project structure",
      },
      configContext: {
        maxEvalCycles: 3,
        worktreePath: "/tmp/wt",
        projectCwd: "/projects/app",
        workerModel: "opus",
        dispatcherModel: "sonnet",
      },
      sessionBudget: {
        invocations_remaining: 10,
        token_budget_remaining: 500000,
        wall_clock_deadline: "2026-03-20T20:00:00Z",
      },
      availableContext: {
        conventions: [{ name: "style", path: ".flywheel/conv/style.md", summary: "Code style" }],
        standards: [],
        learnings: [],
      },
    });

    // workflow_id
    expect(result.input.workflow_id).toBe("wf-123");
    // workflow info
    expect(result.input.workflow).toBeDefined();
    expect(result.input.workflow!.name).toBe("work");
    expect(result.input.workflow!.step_number).toBe(1);
    expect(result.input.workflow!.total_steps).toBe(2);
    expect(result.input.workflow!.step_description).toBe("Setup project structure");
    // config
    expect(result.input.config).toBeDefined();
    expect(result.input.config!.max_eval_cycles).toBe(3);
    expect(result.input.config!.project_cwd).toBe("/projects/app");
    expect(result.input.config!.worker_model).toBe("opus");
    expect(result.input.config!.dispatcher_model).toBe("sonnet");
    // session_budget
    expect(result.input.session_budget).toBeDefined();
    expect(result.input.session_budget!.invocations_remaining).toBe(10);
    // available_context
    expect(result.input.available_context).toBeDefined();
    expect(result.input.available_context!.conventions).toHaveLength(1);
    expect(result.input.available_context!.conventions[0].name).toBe("style");
  });

  it("populates all required fields from assembler input", () => {
    const result = assembleDispatcherInput(baseAssemblerInput());

    expect(result.input.workflow_id).toBe("wf-test-001");
    expect(result.input.workflow).toBeDefined();
    expect(result.input.last_worker_result).toBeNull();
    expect(result.input.config).toBeDefined();
    expect(result.input.session_budget).toBeDefined();
    expect(result.input.available_context).toBeDefined();
  });

  it("maximally-populated input stays within 100KB budget", () => {
    // Build a maximally-populated input with realistic data
    const bigStep = "A".repeat(200);
    const bigPhases = Array.from({ length: 8 }, (_, i) =>
      `### Phase ${i + 1}: Phase title ${i}\n\n- [ ] ${bigStep}\n- [ ] ${bigStep}\n`
    ).join("\n");
    const bigPlan = `# Big Plan\n\n## Overview\nTest\n\n${bigPhases}`;

    const result = assembleDispatcherInput({
      planContent: bigPlan,
      stateContent: STATE_CONTENT_ALL_PENDING,
      lastWorkerResult: {
        step: 0,
        status: "completed",
        output_summary: "S".repeat(500),
        artifacts_produced: Array.from({ length: 10 }, (_, i) => `src/file-${i}.ts`),
        tests_passed: true,
        duration_seconds: 300,
      },
      workflowContext: {
        workflowId: "wf-abc123456789",
        name: "work",
        stepNumber: 3,
        totalSteps: 8,
        stepDescription: "Implement the data validation and processing layer",
      },
      configContext: {
        maxEvalCycles: 3,
        worktreePath: "/tmp/flywheel/worktree-abc123",
        projectCwd: "/Users/dev/projects/my-application",
        workerModel: "opus",
        dispatcherModel: "sonnet",
      },
      sessionBudget: {
        invocations_remaining: 5,
        token_budget_remaining: 250000,
        wall_clock_deadline: "2026-03-20T23:59:59Z",
      },
      availableContext: {
        conventions: Array.from({ length: 10 }, (_, i) => ({
          name: `convention-${i}`,
          path: `.flywheel/conventions/conv-${i}.md`,
          summary: `Convention ${i} description that is moderately long to test budget`,
        })),
        standards: Array.from({ length: 10 }, (_, i) => ({
          name: `standard-${i}`,
          path: `.flywheel/standards/std-${i}.md`,
          summary: `Standard ${i} description`,
        })),
        learnings: Array.from({ length: 10 }, (_, i) => ({
          name: `learning-${i}`,
          path: `.flywheel/learnings/learn-${i}.md`,
          summary: `Learning ${i} about something`,
        })),
      },
    });

    const serialized = JSON.stringify(result.input);
    const bytes = Buffer.byteLength(serialized, "utf8");
    // Maximally-populated should fit within 100KB budget
    expect(bytes).toBeLessThanOrEqual(102400);
    // Should have all fields populated
    expect(result.input.workflow_id).toBeDefined();
    expect(result.input.workflow).toBeDefined();
    expect(result.input.last_worker_result).toBeDefined();
    expect(result.input.config).toBeDefined();
    expect(result.input.session_budget).toBeDefined();
    expect(result.input.available_context).toBeDefined();
  });

  it("safety valve truncates available_context when total exceeds 100KB", () => {
    // Create a scenario that will exceed 100KB:
    // Huge available_context summaries (20 entries x 3 arrays x ~2KB each = ~120KB)
    const bigStep = "Z".repeat(200);
    const bigPhases = Array.from({ length: 5 }, (_, i) =>
      `### Phase ${i + 1}: Phase title ${i}\n\n- [ ] ${bigStep}\n`
    ).join("\n");
    const bigPlan = `# Big Plan\n\n## Overview\nTest\n\n${bigPhases}`;

    const result = assembleDispatcherInput(baseAssemblerInput({
      planContent: bigPlan,
      stateContent: STATE_CONTENT_ALL_PENDING,
      availableContext: {
        conventions: Array.from({ length: 20 }, (_, i) => ({
          name: `convention-${i}`,
          path: `.flywheel/conventions/convention-${i}.md`,
          summary: "C".repeat(2000),
        })),
        standards: Array.from({ length: 20 }, (_, i) => ({
          name: `standard-${i}`,
          path: `.flywheel/standards/standard-${i}.md`,
          summary: "S".repeat(2000),
        })),
        learnings: Array.from({ length: 20 }, (_, i) => ({
          name: `learning-${i}`,
          path: `.flywheel/learnings/learning-${i}.md`,
          summary: "L".repeat(2000),
        })),
      },
    }));

    // Safety valve should have truncated available_context to 10 entries each
    expect(result.input.available_context.conventions).toHaveLength(10);
    expect(result.input.available_context.standards).toHaveLength(10);
    expect(result.input.available_context.learnings).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// b) SdkTransport tests
// ---------------------------------------------------------------------------

describe("SdkTransport", () => {
  let SdkTransport: typeof import("../src/dispatcher/sdk-transport").SdkTransport;
  let _setClientFactoryForTesting: typeof import("../src/dispatcher/sdk-transport")._setClientFactoryForTesting;
  let sdkAvailable: boolean;

  beforeEach(async () => {
    try {
      const mod = await import("../src/dispatcher/sdk-transport");
      SdkTransport = mod.SdkTransport;
      _setClientFactoryForTesting = mod._setClientFactoryForTesting;
      sdkAvailable = mod.SDK_AVAILABLE;
    } catch {
      sdkAvailable = false;
    }
  });

  it("exports SDK_AVAILABLE flag", async () => {
    const mod = await import("../src/dispatcher/sdk-transport");
    expect(typeof mod.SDK_AVAILABLE).toBe("boolean");
  });

  it("parses response via DispatcherDecisionSchema", async () => {
    if (!sdkAvailable) return; // Skip if SDK not available

    // Test the schema parsing directly
    const rawJson = JSON.stringify(validDecision());
    const parsed = DispatcherDecisionSchema.safeParse(JSON.parse(rawJson));
    expect(parsed.success).toBe(true);
  });

  it("strips removed parallel field (no longer in schema)", () => {
    const withParallel = { ...validDecision(), parallel: true };
    const parsed = DispatcherDecisionSchema.safeParse(withParallel);
    // parallel is stripped by .strip() — not rejected
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as any).parallel).toBeUndefined();
    }
  });

  it("sends system prompt as separate `system` field, not concatenated into user content", async () => {
    let capturedPromptOpts: { path: { id: string }; body: { system?: string; parts: Array<{ type: string; text: string }> } } | undefined;

    const mockClient = {
      session: {
        create: async () => ({ data: { id: "mock-session-123" } }),
        prompt: async (opts: any) => {
          capturedPromptOpts = opts;
          return { data: { text: JSON.stringify(validDecision()) } };
        },
      },
    };

    _setClientFactoryForTesting(() => mockClient);

    try {
      const transport = new SdkTransport();
      const input = baseDispatcherInput();
      await transport.invoke(input);

      expect(capturedPromptOpts).toBeDefined();

      // system field should be present and contain the system prompt
      expect(capturedPromptOpts!.body.system).toBeDefined();
      expect(typeof capturedPromptOpts!.body.system).toBe("string");
      expect(capturedPromptOpts!.body.system!).toContain("prompt engineering specialist");

      // parts should contain exactly one text part with the user content
      expect(capturedPromptOpts!.body.parts).toHaveLength(1);
      expect(capturedPromptOpts!.body.parts[0].type).toBe("text");

      // User content should contain the input JSON but NOT the system prompt
      const userText = capturedPromptOpts!.body.parts[0].text;
      expect(userText).toContain(JSON.stringify(input));
      expect(userText).not.toContain("prompt engineering specialist");

      // No concatenation separator should exist in user content
      expect(userText).not.toContain("\n\n---\n\n");
    } finally {
      // Restore original factory so other tests aren't affected
      _setClientFactoryForTesting(null);
    }
  });

  it("includes truncation notes in user content, not in system field", async () => {
    let capturedPromptOpts: any;

    const mockClient = {
      session: {
        create: async () => ({ data: { id: "mock-session-456" } }),
        prompt: async (opts: any) => {
          capturedPromptOpts = opts;
          return { data: { text: JSON.stringify(validDecision()) } };
        },
      },
    };

    _setClientFactoryForTesting(() => mockClient);

    try {
      const transport = new SdkTransport();
      const input = baseDispatcherInput({ plan_truncated: true, history_truncated: true });
      await transport.invoke(input);

      // System prompt should NOT contain truncation warnings
      expect(capturedPromptOpts.body.system).not.toContain("Truncation");

      // User content should contain truncation warnings
      const userText = capturedPromptOpts.body.parts[0].text;
      expect(userText).toContain("Truncation");
      expect(userText).toContain("truncated");
    } finally {
      _setClientFactoryForTesting(null);
    }
  });

  it("system prompt is identical across invocations (cache-stable)", async () => {
    const capturedSystems: string[] = [];

    const mockClient = {
      session: {
        create: async () => ({ data: { id: "mock-session-789" } }),
        prompt: async (opts: any) => {
          capturedSystems.push(opts.body.system);
          return { data: { text: JSON.stringify(validDecision()) } };
        },
      },
    };

    _setClientFactoryForTesting(() => mockClient);

    try {
      const transport = new SdkTransport();
      await transport.invoke(baseDispatcherInput({ plan_truncated: false }));
      await transport.invoke(baseDispatcherInput({ plan_truncated: true, workflow_id: "different-wf" }));

      expect(capturedSystems).toHaveLength(2);
      expect(capturedSystems[0]).toBe(capturedSystems[1]);
    } finally {
      _setClientFactoryForTesting(null);
    }
  });
});

// ---------------------------------------------------------------------------
// c) SubprocessTransport tests
// ---------------------------------------------------------------------------

describe("SubprocessTransport", () => {
  let SubprocessTransport: typeof import("../src/dispatcher/subprocess-transport").SubprocessTransport;

  beforeEach(async () => {
    const mod = await import("../src/dispatcher/subprocess-transport");
    SubprocessTransport = mod.SubprocessTransport;
  });

  it("spawns process and parses DispatcherDecision from stdout", async () => {
    const decision = validDecision();
    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        return { result: Promise.resolve({
          output: JSON.stringify(decision),
          exitCode: 0,
          truncated: false,
          durationMs: 1000,
        }) };
      },
    };

    const transport = new SubprocessTransport({ spawner: mockSpawner });
    const input = baseDispatcherInput();

    const result = await transport.invoke(input);
    expect(result.prompt).toBe(decision.prompt);
    expect(result.phase_index).toBe(decision.phase_index);
  });

  it("falls back on parse error after 1 retry", async () => {
    let callCount = 0;
    const decision = validDecision();

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        callCount++;
        if (callCount === 1) {
          return { result: Promise.resolve({
            output: "not valid json {{{",
            exitCode: 0,
            truncated: false,
            durationMs: 500,
          }) };
        }
        return { result: Promise.resolve({
          output: JSON.stringify(decision),
          exitCode: 0,
          truncated: false,
          durationMs: 500,
        }) };
      },
    };

    const transport = new SubprocessTransport({ spawner: mockSpawner });
    const input = baseDispatcherInput();

    const result = await transport.invoke(input);
    expect(callCount).toBe(2);
    expect(result.prompt).toBe(decision.prompt);
  });

  it("returns null (throws) on second parse failure", async () => {
    const mockSpawner: ProcessSpawner = {
      async spawn() {
        return { result: Promise.resolve({
          output: "still not valid json",
          exitCode: 0,
          truncated: false,
          durationMs: 500,
        }) };
      },
    };

    const transport = new SubprocessTransport({ spawner: mockSpawner });
    const input = baseDispatcherInput();

    await expect(transport.invoke(input)).rejects.toThrow();
  });

  it("respects 60s timeout", async () => {
    let receivedTimeout: number | undefined;

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        receivedTimeout = options?.timeoutMs;
        return { result: Promise.resolve({
          output: JSON.stringify(validDecision()),
          exitCode: 0,
          truncated: false,
          durationMs: 100,
        }) };
      },
    };

    const transport = new SubprocessTransport({ spawner: mockSpawner });
    const input = baseDispatcherInput();

    await transport.invoke(input);
    expect(receivedTimeout).toBe(60_000);
  });

  it("applies env filter via createEnvFilter()", async () => {
    let receivedEnv: Record<string, string> | undefined;

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        receivedEnv = options?.env;
        return { result: Promise.resolve({
          output: JSON.stringify(validDecision()),
          exitCode: 0,
          truncated: false,
          durationMs: 100,
        }) };
      },
    };

    const transport = new SubprocessTransport({ spawner: mockSpawner });
    const input = baseDispatcherInput();

    await transport.invoke(input);
    // Env should be filtered (no API keys)
    expect(receivedEnv).toBeDefined();
    if (receivedEnv) {
      const keys = Object.keys(receivedEnv);
      for (const key of keys) {
        expect(key).not.toMatch(/_API_KEY$/);
        expect(key).not.toMatch(/_SECRET_KEY$/);
        expect(key).not.toMatch(/_SECRET$/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// d) Auto-detect tests
// ---------------------------------------------------------------------------

describe("Auto-detect transport", () => {
  let autoDetectTransport: typeof import("../src/dispatcher/auto-detect").autoDetectTransport;

  beforeEach(async () => {
    const mod = await import("../src/dispatcher/auto-detect");
    autoDetectTransport = mod.autoDetectTransport;
  });

  it("returns a resolved transport with a label", async () => {
    const mockSpawner: ProcessSpawner = {
      async spawn() {
        return { result: Promise.resolve({ output: "", exitCode: 0, truncated: false, durationMs: 0 }) };
      },
    };

    const result = await autoDetectTransport({ spawner: mockSpawner });
    expect(result.transport).toBeDefined();
    expect(result.label).toBeDefined();
    expect(typeof result.label).toBe("string");
  });

  it("falls back to CLI when SDK is unavailable or fails", async () => {
    const mockSpawner: ProcessSpawner = {
      async spawn() {
        return { result: Promise.resolve({ output: "", exitCode: 0, truncated: false, durationMs: 0 }) };
      },
    };

    const result = await autoDetectTransport({ spawner: mockSpawner });
    // At minimum, a transport is returned (SDK or CLI)
    expect(result.transport).toBeDefined();
    expect(["sdk", "cli"]).toContain(result.label);
  });
});

// ---------------------------------------------------------------------------
// e) Dispatcher orchestrator tests
// ---------------------------------------------------------------------------

describe("DispatcherOrchestrator", () => {
  let DispatcherOrchestrator: typeof import("../src/controller/dispatcher-orchestrator").DispatcherOrchestrator;
  let bus: EventBus;
  let events: FlywheelEvent[];

  beforeEach(async () => {
    const mod = await import("../src/controller/dispatcher-orchestrator");
    DispatcherOrchestrator = mod.DispatcherOrchestrator;
    bus = new EventBus();
    events = [];
    bus.subscribe((e) => events.push(e));
  });

  it("calls dispatcher and returns full decision", async () => {
    const decision = validDecision({ prompt: "Dynamic prompt from dispatcher" });
    const mockTransport: DispatcherTransport = {
      async invoke() {
        return decision;
      },
    };

    const orchestrator = new DispatcherOrchestrator({
      transport: mockTransport,
      emitter: createFlywheelEmitter(bus),
      config: defaultConfig(),
      workflowId: "test-wf",
    });

    const result = await orchestrator.getPhaseDecision(
      {
        index: 0,
        title: "Setup project structure",
        description: "Create structure",
        steps: ["Create directory layout"],
        status: "pending",
      },
      TWO_PHASE_PLAN,
      STATE_CONTENT_ALL_PENDING,
      undefined,
      undefined,
      basePhasePromptOptions,
    );

    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("Dynamic prompt from dispatcher");
  });

  it("on dispatcher failure, returns null and emits fallback event", async () => {
    const mockTransport: DispatcherTransport = {
      async invoke() {
        throw new Error("Dispatcher exploded");
      },
    };

    const orchestrator = new DispatcherOrchestrator({
      transport: mockTransport,
      emitter: createFlywheelEmitter(bus),
      config: defaultConfig(),
      workflowId: "test-wf",
    });

    const result = await orchestrator.getPhaseDecision(
      {
        index: 0,
        title: "Setup project structure",
        description: "Create structure",
        steps: ["Create directory layout"],
        status: "pending",
      },
      TWO_PHASE_PLAN,
      STATE_CONTENT_ALL_PENDING,
      undefined,
      undefined,
      basePhasePromptOptions,
    );

    // Returns null — the execution loop will use its own prompt builder
    expect(result).toBeNull();

    // Should emit dispatcher:failed event
    const failedEvents = events.filter((e) => e.type === "dispatcher:failed");
    expect(failedEvents).toHaveLength(1);
  });

  it("emits dispatcher:invoked before calling and dispatcher:completed on success", async () => {
    const decision = validDecision();
    const mockTransport: DispatcherTransport = {
      async invoke() { return decision; },
    };

    const orchestrator = new DispatcherOrchestrator({
      transport: mockTransport,
      emitter: createFlywheelEmitter(bus),
      config: defaultConfig(),
      workflowId: "test-wf",
    });

    await orchestrator.getPhaseDecision(
      {
        index: 0,
        title: "Setup",
        description: "Create",
        steps: [],
        status: "pending",
      },
      TWO_PHASE_PLAN,
      STATE_CONTENT_ALL_PENDING,
      undefined,
      undefined,
      basePhasePromptOptions,
    );

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("dispatcher:invoked");
    expect(eventTypes).toContain("dispatcher:completed");

    // invoked should come before completed
    const invokedIdx = eventTypes.indexOf("dispatcher:invoked");
    const completedIdx = eventTypes.indexOf("dispatcher:completed");
    expect(invokedIdx).toBeLessThan(completedIdx);
  });

  // -------------------------------------------------------------------------
  // getPhaseDecision() — returns full DispatcherDecision
  // -------------------------------------------------------------------------

  it("getPhaseDecision() returns full DispatcherDecision object (not just string)", async () => {
    const decision = validDecision({ prompt: "Full decision prompt" });
    const mockTransport: DispatcherTransport = {
      async invoke() { return decision; },
    };

    const orchestrator = new DispatcherOrchestrator({
      transport: mockTransport,
      emitter: createFlywheelEmitter(bus),
      config: defaultConfig(),
      workflowId: "test-wf",
    });

    const result = await orchestrator.getPhaseDecision(
      {
        index: 0,
        title: "Setup",
        description: "Create structure",
        steps: ["Create directory"],
        status: "pending",
      },
      TWO_PHASE_PLAN,
      STATE_CONTENT_ALL_PENDING,
      undefined,
      undefined,
      basePhasePromptOptions,
    );

    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("Full decision prompt");
    expect(result!.schema_version).toBe(1);
    expect(result!.worker_config).toBeDefined();
    expect(result!.worker_config.timeout_minutes).toBe(30);
    expect(result!.worker_config.max_retries).toBe(3);
    expect(result!.reasoning).toBe("Standard setup phase execution");
  });

  it("getPhaseDecision() returns null on dispatcher failure", async () => {
    const mockTransport: DispatcherTransport = {
      async invoke() { throw new Error("Dispatcher exploded"); },
    };

    const orchestrator = new DispatcherOrchestrator({
      transport: mockTransport,
      emitter: createFlywheelEmitter(bus),
      config: defaultConfig(),
      workflowId: "test-wf",
    });

    const result = await orchestrator.getPhaseDecision(
      {
        index: 0,
        title: "Setup",
        description: "Create structure",
        steps: ["Create directory"],
        status: "pending",
      },
      TWO_PHASE_PLAN,
      STATE_CONTENT_ALL_PENDING,
      undefined,
      undefined,
      basePhasePromptOptions,
    );

    expect(result).toBeNull();

    const failedEvents = events.filter((e) => e.type === "dispatcher:failed");
    expect(failedEvents).toHaveLength(1);
  });

  it("getPhaseDecision() emits dispatcherInvoked and dispatcherCompleted events", async () => {
    const decision = validDecision();
    const mockTransport: DispatcherTransport = {
      async invoke() { return decision; },
    };

    const orchestrator = new DispatcherOrchestrator({
      transport: mockTransport,
      emitter: createFlywheelEmitter(bus),
      config: defaultConfig(),
      workflowId: "test-wf",
    });

    await orchestrator.getPhaseDecision(
      {
        index: 0,
        title: "Setup",
        description: "Create",
        steps: [],
        status: "pending",
      },
      TWO_PHASE_PLAN,
      STATE_CONTENT_ALL_PENDING,
      undefined,
      undefined,
      basePhasePromptOptions,
    );

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("dispatcher:invoked");
    expect(eventTypes).toContain("dispatcher:completed");
  });
});

// ---------------------------------------------------------------------------
// System prompt tests
// ---------------------------------------------------------------------------

describe("Dispatcher system prompt", () => {
  let buildDispatcherSystemPrompt: typeof import("../src/dispatcher/system-prompt").buildDispatcherSystemPrompt;

  beforeEach(async () => {
    const mod = await import("../src/dispatcher/system-prompt");
    buildDispatcherSystemPrompt = mod.buildDispatcherSystemPrompt;
  });

  it("includes role description", () => {
    const prompt = buildDispatcherSystemPrompt();
    expect(prompt).toContain("prompt engineering specialist");
  });

  it("instructs JSON-only output", () => {
    const prompt = buildDispatcherSystemPrompt();
    expect(prompt).toContain("JSON");
  });

  it("mentions default timeout_minutes", () => {
    const prompt = buildDispatcherSystemPrompt();
    expect(prompt).toContain("30");
  });

  // --- New field documentation tests ---

  it("documents reasoning field in output schema", () => {
    const prompt = buildDispatcherSystemPrompt();
    expect(prompt).toContain("reasoning");
  });

  it("documents worker_config field in output schema", () => {
    const prompt = buildDispatcherSystemPrompt();
    expect(prompt).toContain("worker_config");
  });

  it("documents warnings field in output schema", () => {
    const prompt = buildDispatcherSystemPrompt();
    expect(prompt).toContain("warnings");
  });

  it("documents schema_version in output schema", () => {
    const prompt = buildDispatcherSystemPrompt();
    expect(prompt).toContain("schema_version");
  });

  it("documents structured validation_criteria output", () => {
    const prompt = buildDispatcherSystemPrompt();
    expect(prompt).toContain("acceptance_criteria");
    expect(prompt).toContain("required_tests");
    expect(prompt).toContain("custom_checks");
    expect(prompt).toContain("required_outputs");
  });

  it("documents new input fields: workflow_id, workflow, last_worker_result, config, session_budget, available_context", () => {
    const prompt = buildDispatcherSystemPrompt();
    expect(prompt).toContain("workflow_id");
    expect(prompt).toContain("workflow.name");
    expect(prompt).toContain("last_worker_result");
    expect(prompt).toContain("config.max_eval_cycles");
    expect(prompt).toContain("session_budget");
    expect(prompt).toContain("available_context");
  });

  it("does not mention removed parallel field at top level", () => {
    const prompt = buildDispatcherSystemPrompt();
    // The old prompt had `"parallel": false // Must always be false (sequential only)`
    // and a rule about parallel being false. These should be gone.
    expect(prompt).not.toContain("Must always be false");
    expect(prompt).not.toContain("Sequential execution only");
  });

  it("is deterministic — no params, identical across calls (cache-stable)", () => {
    const a = buildDispatcherSystemPrompt();
    const b = buildDispatcherSystemPrompt();
    expect(a).toBe(b);
  });

  it("does not contain truncation warnings (those belong in user segment)", () => {
    const prompt = buildDispatcherSystemPrompt();
    expect(prompt).not.toContain("Truncation Warnings");
    expect(prompt).not.toContain("has been truncated");
  });

  it("instructs when to populate reasoning", () => {
    const prompt = buildDispatcherSystemPrompt();
    // Should contain guidance about when/why to use reasoning
    expect(prompt.toLowerCase()).toContain("reasoning");
    expect(prompt).toContain("prompt strategy");
  });

  it("instructs when to add warnings", () => {
    const prompt = buildDispatcherSystemPrompt();
    // Should contain guidance about when to use warnings
    expect(prompt).toContain("risks");
  });

  it("instructs when to override worker_config", () => {
    const prompt = buildDispatcherSystemPrompt();
    // Should contain guidance about when to use worker_config
    expect(prompt).toContain("model_override");
    expect(prompt).toContain("tool_scoping");
  });

  it("instructs dispatcher to include Understand-Act-Verify in worker prompts", () => {
    const prompt = buildDispatcherSystemPrompt();
    expect(prompt).toContain("Understand-Act-Verify");
  });

  it("instructs dispatcher to include iteration budget when worker_config.iteration_budget is set", () => {
    const prompt = buildDispatcherSystemPrompt();
    expect(prompt).toContain("iteration_budget");
    expect(prompt).toContain("iteration budget");
  });

  // --- context_to_inline and 3-level context model tests ---

  it("documents context_to_inline in output schema", () => {
    const prompt = buildDispatcherSystemPrompt();
    expect(prompt).toContain("context_to_inline");
  });

  it("explains 3-level context model (metadata, targeted, on-demand)", () => {
    const prompt = buildDispatcherSystemPrompt();
    // Should reference all three levels
    expect(prompt).toContain("metadata");
    expect(prompt).toContain("context_to_inline");
    expect(prompt).toContain("on demand");
  });

  it("differentiates context_to_inline (Level 2) from context_files (Level 3)", () => {
    const prompt = buildDispatcherSystemPrompt();
    // Should explain context_to_inline is controller-injected before spawn
    expect(prompt).toContain("context_to_inline");
    expect(prompt).toContain("context_files");
    // Should clarify the distinction
    expect(prompt).toContain("controller-injected");
    expect(prompt).toContain("worker reads on demand");
  });

  it("instructs to order context_to_inline by importance — most critical first", () => {
    const prompt = buildDispatcherSystemPrompt();
    expect(prompt).toContain("most critical first");
  });

  it("does not mention relevant_learnings", () => {
    const prompt = buildDispatcherSystemPrompt();
    expect(prompt).not.toContain("relevant_learnings");
  });
});

// ---------------------------------------------------------------------------
// buildTruncationNotes tests
// ---------------------------------------------------------------------------

describe("buildTruncationNotes", () => {
  let buildTruncationNotes: typeof import("../src/dispatcher/system-prompt").buildTruncationNotes;

  beforeEach(async () => {
    const mod = await import("../src/dispatcher/system-prompt");
    buildTruncationNotes = mod.buildTruncationNotes;
  });

  it("returns empty string when nothing is truncated", () => {
    const notes = buildTruncationNotes({ plan_truncated: false, history_truncated: false });
    expect(notes).toBe("");
  });

  it("includes plan truncation warning when plan is truncated", () => {
    const notes = buildTruncationNotes({ plan_truncated: true, history_truncated: false });
    expect(notes).toContain("plan");
    expect(notes.toLowerCase()).toContain("truncated");
  });

  it("includes history truncation warning when history is truncated", () => {
    const notes = buildTruncationNotes({ plan_truncated: false, history_truncated: true });
    expect(notes).toContain("history");
    expect(notes.toLowerCase()).toContain("truncated");
  });

  it("includes both warnings when both are truncated", () => {
    const notes = buildTruncationNotes({ plan_truncated: true, history_truncated: true });
    expect(notes).toContain("plan");
    expect(notes).toContain("history");
  });

  it("ends with newline separator when non-empty (for concatenation)", () => {
    const notes = buildTruncationNotes({ plan_truncated: true, history_truncated: false });
    expect(notes.endsWith("\n\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cache-stable prompt structure tests (system vs user segment separation)
// ---------------------------------------------------------------------------

describe("Cache-stable prompt structure", () => {
  let SubprocessTransport: typeof import("../src/dispatcher/subprocess-transport").SubprocessTransport;
  let buildDispatcherSystemPrompt: typeof import("../src/dispatcher/system-prompt").buildDispatcherSystemPrompt;
  let buildTruncationNotes: typeof import("../src/dispatcher/system-prompt").buildTruncationNotes;

  beforeEach(async () => {
    const mod = await import("../src/dispatcher/subprocess-transport");
    SubprocessTransport = mod.SubprocessTransport;
    const promptMod = await import("../src/dispatcher/system-prompt");
    buildDispatcherSystemPrompt = promptMod.buildDispatcherSystemPrompt;
    buildTruncationNotes = promptMod.buildTruncationNotes;
  });

  it("SubprocessTransport sends system prompt and user content as structurally distinct segments", async () => {
    let capturedStdin = "";
    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        capturedStdin = options?.stdin ?? "";
        return { result: Promise.resolve({
          output: JSON.stringify(validDecision()),
          exitCode: 0,
          truncated: false,
          durationMs: 100,
        }) };
      },
    };

    const transport = new SubprocessTransport({ spawner: mockSpawner });
    await transport.invoke(baseDispatcherInput());

    // Should contain a --- separator between system and user content
    expect(capturedStdin).toContain("\n\n---\n\n");

    // Split on the separator
    const parts = capturedStdin.split("\n\n---\n\n");
    expect(parts.length).toBe(2);

    // System part should be the stable system prompt
    const systemPart = parts[0];
    expect(systemPart).toBe(buildDispatcherSystemPrompt());

    // User part should contain the input JSON
    const userPart = parts[1];
    expect(userPart).toContain("Here is the dispatcher input:");
    expect(userPart).toContain("Respond with valid JSON only.");
  });

  it("system prompt is identical across multiple invocations (no per-step data)", async () => {
    const capturedStdins: string[] = [];
    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        capturedStdins.push(options?.stdin ?? "");
        return { result: Promise.resolve({
          output: JSON.stringify(validDecision()),
          exitCode: 0,
          truncated: false,
          durationMs: 100,
        }) };
      },
    };

    const transport = new SubprocessTransport({ spawner: mockSpawner });

    // First invocation: no truncation
    await transport.invoke(baseDispatcherInput({ plan_truncated: false, history_truncated: false }));
    // Second invocation: both truncated (different per-step data)
    await transport.invoke(baseDispatcherInput({ plan_truncated: true, history_truncated: true }));

    expect(capturedStdins).toHaveLength(2);

    // Extract system prompt from each (before the --- separator)
    const system1 = capturedStdins[0].split("\n\n---\n\n")[0];
    const system2 = capturedStdins[1].split("\n\n---\n\n")[0];

    // System prompts must be identical — no per-step data leaked in
    expect(system1).toBe(system2);
  });

  it("per-step DispatcherInput JSON is in user segment only", async () => {
    let capturedStdin = "";
    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        capturedStdin = options?.stdin ?? "";
        return { result: Promise.resolve({
          output: JSON.stringify(validDecision()),
          exitCode: 0,
          truncated: false,
          durationMs: 100,
        }) };
      },
    };

    const transport = new SubprocessTransport({ spawner: mockSpawner });
    const input = baseDispatcherInput({ workflow_id: "wf-unique-marker-123" });
    await transport.invoke(input);

    const parts = capturedStdin.split("\n\n---\n\n");
    const systemPart = parts[0];
    const userPart = parts[1];

    // The unique workflow_id should NOT appear in the system part
    expect(systemPart).not.toContain("wf-unique-marker-123");
    // But should appear in the user part (as part of the JSON)
    expect(userPart).toContain("wf-unique-marker-123");
  });

  it("truncation warnings appear in user segment, not system segment", async () => {
    let capturedStdin = "";
    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        capturedStdin = options?.stdin ?? "";
        return { result: Promise.resolve({
          output: JSON.stringify(validDecision()),
          exitCode: 0,
          truncated: false,
          durationMs: 100,
        }) };
      },
    };

    const transport = new SubprocessTransport({ spawner: mockSpawner });
    await transport.invoke(baseDispatcherInput({ plan_truncated: true, history_truncated: true }));

    const parts = capturedStdin.split("\n\n---\n\n");
    const systemPart = parts[0];
    const userPart = parts[1];

    // System segment must NOT contain truncation warnings
    expect(systemPart).not.toContain("Truncation");
    expect(systemPart).not.toContain("has been truncated");

    // User segment should contain truncation notes
    expect(userPart).toContain("truncated");
  });

  it("uses compact JSON.stringify (no pretty-printing) for input payload", async () => {
    let capturedStdin = "";
    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        capturedStdin = options?.stdin ?? "";
        return { result: Promise.resolve({
          output: JSON.stringify(validDecision()),
          exitCode: 0,
          truncated: false,
          durationMs: 100,
        }) };
      },
    };

    const transport = new SubprocessTransport({ spawner: mockSpawner });
    const input = baseDispatcherInput();
    await transport.invoke(input);

    const parts = capturedStdin.split("\n\n---\n\n");
    const userPart = parts[1];

    // Should contain compact JSON (no newlines within the JSON object)
    const compactJson = JSON.stringify(input);
    expect(userPart).toContain(compactJson);

    // Should NOT contain pretty-printed JSON
    const prettyJson = JSON.stringify(input, null, 2);
    if (prettyJson !== compactJson) {
      expect(userPart).not.toContain(prettyJson);
    }
  });
});

// ---------------------------------------------------------------------------
// f) enrichPromptWithContext tests
// ---------------------------------------------------------------------------

describe("enrichPromptWithContext", () => {
  let enrichPromptWithContext: typeof import("../src/controller/dispatcher-orchestrator").enrichPromptWithContext;
  let INLINE_CONTENT_BUDGET: number;
  let tmpDir: string;

  beforeEach(async () => {
    const mod = await import("../src/controller/dispatcher-orchestrator");
    enrichPromptWithContext = mod.enrichPromptWithContext;
    INLINE_CONTENT_BUDGET = mod.INLINE_CONTENT_BUDGET;
    tmpDir = await mkdtemp(join(tmpdir(), "enrich-ctx-"));
  });

  afterAll(async () => {
    // Clean up any remaining temp dirs (best-effort)
    try {
      // Each test creates its own tmpDir — afterAll can't clean all of them,
      // but OS tmp cleanup handles it. Individual cleanup in tests is optional.
    } catch {}
  });

  it("returns prompt unchanged when contextToInline is empty", async () => {
    const prompt = "Execute phase 1";
    const result = await enrichPromptWithContext(prompt, [], tmpDir);
    expect(result).toBe(prompt);
  });

  it("prepends file content with header and file path sub-headers", async () => {
    const filePath = join(tmpDir, "conventions.md");
    await writeFile(filePath, "Always use TypeScript strict mode.");

    const prompt = "Execute phase 1";
    const result = await enrichPromptWithContext(prompt, [filePath], tmpDir);

    expect(result).toContain("## Relevant Context (from project standards and learnings)");
    expect(result).toContain(`### ${filePath}`);
    expect(result).toContain("Always use TypeScript strict mode.");
    // Original prompt is at the end
    expect(result).toContain("---\n\nExecute phase 1");
    // Verify ordering: context comes before prompt
    const contextIdx = result.indexOf("## Relevant Context");
    const promptIdx = result.indexOf("Execute phase 1");
    expect(contextIdx).toBeLessThan(promptIdx);
  });

  it("inlines multiple files in order with separate sub-headers", async () => {
    const file1 = join(tmpDir, "style.md");
    const file2 = join(tmpDir, "testing.md");
    await writeFile(file1, "Use 2-space indentation.");
    await writeFile(file2, "Always write unit tests.");

    const prompt = "Original prompt";
    const result = await enrichPromptWithContext(prompt, [file1, file2], tmpDir);

    expect(result).toContain(`### ${file1}`);
    expect(result).toContain(`### ${file2}`);
    expect(result).toContain("Use 2-space indentation.");
    expect(result).toContain("Always write unit tests.");
    // file1 should appear before file2
    const idx1 = result.indexOf(`### ${file1}`);
    const idx2 = result.indexOf(`### ${file2}`);
    expect(idx1).toBeLessThan(idx2);
  });

  it("caps total inlined content at INLINE_CONTENT_BUDGET (8KB)", async () => {
    // Create a file that's under 8KB
    const file1 = join(tmpDir, "big1.md");
    await writeFile(file1, "A".repeat(6000));

    // Create a second file that would push over 8KB
    const file2 = join(tmpDir, "big2.md");
    await writeFile(file2, "B".repeat(3000));

    const prompt = "Original prompt";
    const result = await enrichPromptWithContext(prompt, [file1, file2], tmpDir);

    // First file should be included
    expect(result).toContain(`### ${file1}`);
    // Second file should NOT be included (budget exceeded)
    expect(result).not.toContain(`### ${file2}`);
    // Original prompt still present
    expect(result).toContain("Original prompt");
  });

  it("skips non-existent files gracefully", async () => {
    const validFile = join(tmpDir, "exists.md");
    await writeFile(validFile, "Valid content.");
    const missingFile = join(tmpDir, "does-not-exist.md");

    const prompt = "Original prompt";
    const result = await enrichPromptWithContext(prompt, [missingFile, validFile], tmpDir);

    // Missing file skipped, valid file included
    expect(result).not.toContain(`### ${missingFile}`);
    expect(result).toContain(`### ${validFile}`);
    expect(result).toContain("Valid content.");
  });

  it("rejects paths outside projectCwd via isPathWithinBoundary()", async () => {
    // Create a file outside the project boundary
    const outsideDir = await mkdtemp(join(tmpdir(), "outside-"));
    const outsideFile = join(outsideDir, "secret.md");
    await writeFile(outsideFile, "Secret content");

    const validFile = join(tmpDir, "safe.md");
    await writeFile(validFile, "Safe content.");

    const prompt = "Original prompt";
    const result = await enrichPromptWithContext(prompt, [outsideFile, validFile], tmpDir);

    // Outside file should be rejected
    expect(result).not.toContain("Secret content");
    expect(result).not.toContain(`### ${outsideFile}`);
    // Safe file should be included
    expect(result).toContain(`### ${validFile}`);
    expect(result).toContain("Safe content.");

    // Cleanup outside dir
    await rm(outsideDir, { recursive: true, force: true });
  });

  it("returns prompt unchanged when all paths are invalid", async () => {
    const missingFile = join(tmpDir, "nonexistent.md");

    const prompt = "Original prompt";
    const result = await enrichPromptWithContext(prompt, [missingFile], tmpDir);

    // No context could be inlined, so prompt should be unchanged
    expect(result).toBe(prompt);
  });

  it("INLINE_CONTENT_BUDGET is 8192", () => {
    expect(INLINE_CONTENT_BUDGET).toBe(8192);
  });

  it("truncates first file if it alone exceeds budget", async () => {
    const bigFile = join(tmpDir, "huge.md");
    // Write content much larger than 8KB
    await writeFile(bigFile, "X".repeat(20000));

    const prompt = "Original prompt";
    const result = await enrichPromptWithContext(prompt, [bigFile], tmpDir);

    // Should still include something from the file (truncated)
    expect(result).toContain(`### ${bigFile}`);
    expect(result).toContain("[truncated]");
    // Original prompt should still be present
    expect(result).toContain("Original prompt");
    // The included content should be at most ~8KB of X's
    const headerAndContext = result.split("---\n\n")[0];
    // Content bytes should be around the budget (with some overhead for headers)
    const xCount = (headerAndContext.match(/X/g) || []).length;
    expect(xCount).toBeLessThanOrEqual(INLINE_CONTENT_BUDGET);
    expect(xCount).toBeGreaterThan(0);
  });

  it("reads files with subdirectory paths within projectCwd", async () => {
    const subDir = join(tmpDir, "sub", "dir");
    await mkdir(subDir, { recursive: true });
    const filePath = join(subDir, "nested.md");
    await writeFile(filePath, "Nested content.");

    const prompt = "Original prompt";
    const result = await enrichPromptWithContext(prompt, [filePath], tmpDir);

    expect(result).toContain(`### ${filePath}`);
    expect(result).toContain("Nested content.");
  });
});

// ---------------------------------------------------------------------------
// g) enrichPromptWithContext integration via getPhaseDecision()
// ---------------------------------------------------------------------------

describe("DispatcherOrchestrator enrichment wiring", () => {
  let DispatcherOrchestrator: typeof import("../src/controller/dispatcher-orchestrator").DispatcherOrchestrator;
  let bus: EventBus;
  let events: FlywheelEvent[];
  let tmpDir: string;

  beforeEach(async () => {
    const mod = await import("../src/controller/dispatcher-orchestrator");
    DispatcherOrchestrator = mod.DispatcherOrchestrator;
    bus = new EventBus();
    events = [];
    bus.subscribe((e) => events.push(e));
    tmpDir = await mkdtemp(join(tmpdir(), "enrich-orch-"));
  });

  it("enriches prompt when decision has context_to_inline with valid files", async () => {
    const filePath = join(tmpDir, "conventions.md");
    await writeFile(filePath, "Use strict mode always.");

    const decision = validDecision({
      prompt: "Execute the setup phase",
      context_to_inline: [filePath],
    });
    const mockTransport: DispatcherTransport = {
      async invoke() { return decision; },
    };

    const orchestrator = new DispatcherOrchestrator({
      transport: mockTransport,
      emitter: createFlywheelEmitter(bus),
      config: defaultConfig(),
      workflowId: "test-wf",
    });

    const result = await orchestrator.getPhaseDecision(
      {
        index: 0,
        title: "Setup",
        description: "Create structure",
        steps: ["Create directory"],
        status: "pending",
      },
      TWO_PHASE_PLAN,
      STATE_CONTENT_ALL_PENDING,
      undefined,
      undefined,
      {
        ...basePhasePromptOptions,
        configContext: { ...baseConfigContext, projectCwd: tmpDir },
      },
    );

    expect(result).not.toBeNull();
    // Prompt should be enriched with context header
    expect(result!.prompt).toContain("## Relevant Context");
    expect(result!.prompt).toContain("Use strict mode always.");
    // Original prompt should still be present at the end
    expect(result!.prompt).toContain("Execute the setup phase");
  });

  it("does not enrich prompt when context_to_inline is absent", async () => {
    const decision = validDecision({
      prompt: "Execute the setup phase",
      // No context_to_inline field
    });
    const mockTransport: DispatcherTransport = {
      async invoke() { return decision; },
    };

    const orchestrator = new DispatcherOrchestrator({
      transport: mockTransport,
      emitter: createFlywheelEmitter(bus),
      config: defaultConfig(),
      workflowId: "test-wf",
    });

    const result = await orchestrator.getPhaseDecision(
      {
        index: 0,
        title: "Setup",
        description: "Create structure",
        steps: ["Create directory"],
        status: "pending",
      },
      TWO_PHASE_PLAN,
      STATE_CONTENT_ALL_PENDING,
      undefined,
      undefined,
      basePhasePromptOptions,
    );

    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("Execute the setup phase");
  });

  it("does not enrich prompt when context_to_inline is empty array", async () => {
    const decision = validDecision({
      prompt: "Execute the setup phase",
      context_to_inline: [],
    });
    const mockTransport: DispatcherTransport = {
      async invoke() { return decision; },
    };

    const orchestrator = new DispatcherOrchestrator({
      transport: mockTransport,
      emitter: createFlywheelEmitter(bus),
      config: defaultConfig(),
      workflowId: "test-wf",
    });

    const result = await orchestrator.getPhaseDecision(
      {
        index: 0,
        title: "Setup",
        description: "Create structure",
        steps: ["Create directory"],
        status: "pending",
      },
      TWO_PHASE_PLAN,
      STATE_CONTENT_ALL_PENDING,
      undefined,
      undefined,
      basePhasePromptOptions,
    );

    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("Execute the setup phase");
  });
});

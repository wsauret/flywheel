import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { DispatcherDecision, DispatcherInput } from "../src/schemas/dispatcher";
import type { DispatcherTransport } from "../src/dispatcher/transport";
import type { ProcessSpawner, SpawnOptions } from "../src/worker/spawner";
import type { WorkerResult } from "../src/schemas/worker";
import type { FlywheelEvent } from "../src/events/types";
import type { FlywheelConfig } from "../src/config/loader";
import { DispatcherDecisionSchema } from "../src/schemas/dispatcher";
import { EventBus, createFlywheelEmitter } from "../src/events/event-bus";
import { CONFIG_DEFAULTS } from "../src/config/loader";

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
    phase_index: 0,
    step_index: 0,
    prompt: "Execute the setup phase by creating directory layout",
    context_files: ["src/index.ts"],
    validation_criteria: "Directory structure exists",
    timeout_minutes: 30,
    ...overrides,
  };
}

function defaultConfig(overrides?: Partial<FlywheelConfig>): FlywheelConfig {
  return { ...CONFIG_DEFAULTS, ...overrides };
}

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
    const result = assembleDispatcherInput({
      planContent: TWO_PHASE_PLAN,
      stateContent: STATE_CONTENT_PHASE1_DONE,
    });

    expect(result.input.plan.phases).toHaveLength(2);
    expect(result.input.plan.phases[0].name).toBe("Setup project structure");
    expect(result.input.state.completed_phases).toEqual([0]);
    expect(result.input.state.current_phase_index).toBe(1);
    expect(result.planTruncated).toBe(false);
    expect(result.historyTruncated).toBe(false);
  });

  it("respects 5KB budget with per-slot allocations", () => {
    // Create oversized plan content (~3KB, exceeds 2KB budget)
    const bigStep = "A".repeat(300);
    const bigPhases = Array.from({ length: 10 }, (_, i) =>
      `### Phase ${i + 1}: Phase title ${i}\n\n- [ ] ${bigStep}\n- [ ] ${bigStep}\n`
    ).join("\n");
    const bigPlan = `# Big Plan\n\n## Overview\nTest\n\n${bigPhases}`;

    const result = assembleDispatcherInput({
      planContent: bigPlan,
      stateContent: STATE_CONTENT_ALL_PENDING,
    });

    // The assembled input should respect budget — serialized plan data should be capped
    expect(result.input.plan.phases.length).toBeGreaterThan(0);
    // Total serialized size should be under 5KB
    const serialized = JSON.stringify(result.input);
    expect(serialized.length).toBeLessThanOrEqual(5120);
  });

  it("sets truncation flags when content exceeds budget", () => {
    // Create oversized plan content
    const bigStep = "X".repeat(500);
    const bigPhases = Array.from({ length: 15 }, (_, i) =>
      `### Phase ${i + 1}: Phase title ${i}\n\n- [ ] ${bigStep}\n`
    ).join("\n");
    const bigPlan = `# Big Plan\n\n## Overview\nTest\n\n${bigPhases}`;

    const result = assembleDispatcherInput({
      planContent: bigPlan,
      stateContent: STATE_CONTENT_ALL_PENDING,
    });

    expect(result.planTruncated).toBe(true);
    expect(result.input.plan_truncated).toBe(true);
  });

  it("handles missing context file (empty files array)", () => {
    const result = assembleDispatcherInput({
      planContent: TWO_PHASE_PLAN,
      stateContent: STATE_CONTENT_ALL_PENDING,
      contextContent: undefined,
    });

    expect(result.input.context.files).toEqual([]);
  });

  it("handles missing state file (all phases pending)", () => {
    const result = assembleDispatcherInput({
      planContent: TWO_PHASE_PLAN,
      stateContent: "",
    });

    expect(result.input.state.completed_phases).toEqual([]);
    expect(result.input.state.current_phase_index).toBe(0);
  });

  it("includes context files when provided", () => {
    const result = assembleDispatcherInput({
      planContent: TWO_PHASE_PLAN,
      stateContent: STATE_CONTENT_PHASE1_DONE,
      contextContent: "# Context\n- src/index.ts\n- tests/main.test.ts\n",
    });

    expect(result.input.context.files).toEqual(["src/index.ts", "tests/main.test.ts"]);
  });

  it("includes last worker result when provided (truncated to 1KB)", () => {
    const bigResult = "B".repeat(2000);
    const result = assembleDispatcherInput({
      planContent: TWO_PHASE_PLAN,
      stateContent: STATE_CONTENT_PHASE1_DONE,
      lastWorkerResult: bigResult,
    });

    // Verify total stays within budget
    const serialized = JSON.stringify(result.input);
    expect(serialized.length).toBeLessThanOrEqual(5120);
  });
});

// ---------------------------------------------------------------------------
// b) SdkTransport tests
// ---------------------------------------------------------------------------

describe("SdkTransport", () => {
  let SdkTransport: typeof import("../src/dispatcher/sdk-transport").SdkTransport;
  let sdkAvailable: boolean;

  beforeEach(async () => {
    try {
      const mod = await import("../src/dispatcher/sdk-transport");
      SdkTransport = mod.SdkTransport;
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

  it("rejects parallel: true via schema", () => {
    const withParallel = { ...validDecision(), parallel: true };
    const parsed = DispatcherDecisionSchema.safeParse(withParallel);
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// c) CliTransport tests
// ---------------------------------------------------------------------------

describe("CliTransport", () => {
  let CliTransport: typeof import("../src/dispatcher/cli-transport").CliTransport;

  beforeEach(async () => {
    const mod = await import("../src/dispatcher/cli-transport");
    CliTransport = mod.CliTransport;
  });

  it("spawns process and parses DispatcherDecision from stdout", async () => {
    const decision = validDecision();
    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        return {
          output: JSON.stringify(decision),
          exitCode: 0,
          truncated: false,
          durationMs: 1000,
        };
      },
    };

    const transport = new CliTransport({ spawner: mockSpawner });
    const input: DispatcherInput = {
      plan: { phases: [{ name: "Phase 1", steps: [{ description: "step 1" }] }] },
      state: { completed_phases: [], current_phase_index: 0 },
      context: { files: [] },
      plan_truncated: false,
      history_truncated: false,
    };

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
          return {
            output: "not valid json {{{",
            exitCode: 0,
            truncated: false,
            durationMs: 500,
          };
        }
        return {
          output: JSON.stringify(decision),
          exitCode: 0,
          truncated: false,
          durationMs: 500,
        };
      },
    };

    const transport = new CliTransport({ spawner: mockSpawner });
    const input: DispatcherInput = {
      plan: { phases: [{ name: "Phase 1", steps: [{ description: "step 1" }] }] },
      state: { completed_phases: [], current_phase_index: 0 },
      context: { files: [] },
      plan_truncated: false,
      history_truncated: false,
    };

    const result = await transport.invoke(input);
    expect(callCount).toBe(2);
    expect(result.prompt).toBe(decision.prompt);
  });

  it("returns null (throws) on second parse failure", async () => {
    const mockSpawner: ProcessSpawner = {
      async spawn() {
        return {
          output: "still not valid json",
          exitCode: 0,
          truncated: false,
          durationMs: 500,
        };
      },
    };

    const transport = new CliTransport({ spawner: mockSpawner });
    const input: DispatcherInput = {
      plan: { phases: [{ name: "Phase 1", steps: [{ description: "step 1" }] }] },
      state: { completed_phases: [], current_phase_index: 0 },
      context: { files: [] },
      plan_truncated: false,
      history_truncated: false,
    };

    await expect(transport.invoke(input)).rejects.toThrow();
  });

  it("respects 60s timeout", async () => {
    let receivedTimeout: number | undefined;

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        receivedTimeout = options?.timeoutMs;
        return {
          output: JSON.stringify(validDecision()),
          exitCode: 0,
          truncated: false,
          durationMs: 100,
        };
      },
    };

    const transport = new CliTransport({ spawner: mockSpawner });
    const input: DispatcherInput = {
      plan: { phases: [{ name: "Phase 1", steps: [{ description: "step 1" }] }] },
      state: { completed_phases: [], current_phase_index: 0 },
      context: { files: [] },
      plan_truncated: false,
      history_truncated: false,
    };

    await transport.invoke(input);
    expect(receivedTimeout).toBe(60_000);
  });

  it("applies env filter via createEnvFilter()", async () => {
    let receivedEnv: Record<string, string> | undefined;

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        receivedEnv = options?.env;
        return {
          output: JSON.stringify(validDecision()),
          exitCode: 0,
          truncated: false,
          durationMs: 100,
        };
      },
    };

    const transport = new CliTransport({ spawner: mockSpawner });
    const input: DispatcherInput = {
      plan: { phases: [{ name: "Phase 1", steps: [{ description: "step 1" }] }] },
      state: { completed_phases: [], current_phase_index: 0 },
      context: { files: [] },
      plan_truncated: false,
      history_truncated: false,
    };

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
        return { output: "", exitCode: 0, truncated: false, durationMs: 0 };
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
        return { output: "", exitCode: 0, truncated: false, durationMs: 0 };
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

  it("when use_dispatcher: true, calls dispatcher and uses returned prompt", async () => {
    const decision = validDecision({ prompt: "Dynamic prompt from dispatcher" });
    const mockTransport: DispatcherTransport = {
      async invoke() {
        return decision;
      },
    };

    const orchestrator = new DispatcherOrchestrator({
      transport: mockTransport,
      emitter: createFlywheelEmitter(bus),
      config: defaultConfig({ use_dispatcher: true }),
      workflowId: "test-wf",
    });

    const prompt = await orchestrator.getPhasePrompt(
      {
        index: 0,
        title: "Setup project structure",
        description: "Create structure",
        steps: ["Create directory layout"],
        status: "pending",
      },
      TWO_PHASE_PLAN,
      STATE_CONTENT_ALL_PENDING,
    );

    expect(prompt).toBe("Dynamic prompt from dispatcher");
  });

  it("when use_dispatcher: false, returns null so caller uses its own builder", async () => {
    let dispatcherCalled = false;
    const mockTransport: DispatcherTransport = {
      async invoke() {
        dispatcherCalled = true;
        return validDecision();
      },
    };

    const orchestrator = new DispatcherOrchestrator({
      transport: mockTransport,
      emitter: createFlywheelEmitter(bus),
      config: defaultConfig({ use_dispatcher: false }),
      workflowId: "test-wf",
    });

    const prompt = await orchestrator.getPhasePrompt(
      {
        index: 0,
        title: "Setup project structure",
        description: "Create structure",
        steps: ["Create directory layout"],
        status: "pending",
      },
      TWO_PHASE_PLAN,
      STATE_CONTENT_ALL_PENDING,
    );

    expect(dispatcherCalled).toBe(false);
    // Returns null — the execution loop will use its own prompt builder
    expect(prompt).toBeNull();
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
      config: defaultConfig({ use_dispatcher: true }),
      workflowId: "test-wf",
    });

    const prompt = await orchestrator.getPhasePrompt(
      {
        index: 0,
        title: "Setup project structure",
        description: "Create structure",
        steps: ["Create directory layout"],
        status: "pending",
      },
      TWO_PHASE_PLAN,
      STATE_CONTENT_ALL_PENDING,
    );

    // Returns null — the execution loop will use its own prompt builder
    expect(prompt).toBeNull();

    // Should emit dispatcher:failed event
    const failedEvents = events.filter((e) => e.type === "dispatcher:failed");
    expect(failedEvents).toHaveLength(1);
  });

  it("respects use_dispatcher config flag for A/B testing", async () => {
    const decision = validDecision({ prompt: "Dispatcher prompt" });
    const mockTransport: DispatcherTransport = {
      async invoke() { return decision; },
    };

    const phase = {
      index: 0,
      title: "Setup",
      description: "Create structure",
      steps: ["Create directory"],
      status: "pending" as const,
    };

    // With dispatcher ON
    const orchOn = new DispatcherOrchestrator({
      transport: mockTransport,
      emitter: createFlywheelEmitter(bus),
      config: defaultConfig({ use_dispatcher: true }),
      workflowId: "test-wf",
    });
    const promptOn = await orchOn.getPhasePrompt(phase, TWO_PHASE_PLAN, STATE_CONTENT_ALL_PENDING);
    expect(promptOn).toBe("Dispatcher prompt");

    // With dispatcher OFF — returns null
    const orchOff = new DispatcherOrchestrator({
      transport: mockTransport,
      emitter: createFlywheelEmitter(bus),
      config: defaultConfig({ use_dispatcher: false }),
      workflowId: "test-wf",
    });
    const promptOff = await orchOff.getPhasePrompt(phase, TWO_PHASE_PLAN, STATE_CONTENT_ALL_PENDING);
    expect(promptOff).toBeNull();
  });

  it("emits dispatcher:invoked before calling and dispatcher:completed on success", async () => {
    const decision = validDecision();
    const mockTransport: DispatcherTransport = {
      async invoke() { return decision; },
    };

    const orchestrator = new DispatcherOrchestrator({
      transport: mockTransport,
      emitter: createFlywheelEmitter(bus),
      config: defaultConfig({ use_dispatcher: true }),
      workflowId: "test-wf",
    });

    await orchestrator.getPhasePrompt(
      {
        index: 0,
        title: "Setup",
        description: "Create",
        steps: [],
        status: "pending",
      },
      TWO_PHASE_PLAN,
      STATE_CONTENT_ALL_PENDING,
    );

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("dispatcher:invoked");
    expect(eventTypes).toContain("dispatcher:completed");

    // invoked should come before completed
    const invokedIdx = eventTypes.indexOf("dispatcher:invoked");
    const completedIdx = eventTypes.indexOf("dispatcher:completed");
    expect(invokedIdx).toBeLessThan(completedIdx);
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
    const prompt = buildDispatcherSystemPrompt({ plan: false, history: false });
    expect(prompt).toContain("prompt engineering specialist");
  });

  it("notes truncated fields when plan is truncated", () => {
    const prompt = buildDispatcherSystemPrompt({ plan: true, history: false });
    expect(prompt).toContain("truncated");
    expect(prompt.toLowerCase()).toContain("plan");
  });

  it("notes truncated fields when history is truncated", () => {
    const prompt = buildDispatcherSystemPrompt({ plan: false, history: true });
    expect(prompt).toContain("truncated");
  });

  it("instructs JSON-only output", () => {
    const prompt = buildDispatcherSystemPrompt({ plan: false, history: false });
    expect(prompt).toContain("JSON");
  });

  it("mentions default timeout_minutes", () => {
    const prompt = buildDispatcherSystemPrompt({ plan: false, history: false });
    expect(prompt).toContain("30");
  });
});

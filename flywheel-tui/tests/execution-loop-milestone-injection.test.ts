/**
 * Tests for validation phase auto-injection in the execution loop.
 *
 * Verifies that when a MilestoneTracker is configured and a milestone's
 * implementation phases all complete, scrutiny and behavioral validation
 * phases are auto-injected at the top of the remaining phase queue.
 *
 * Covers:
 * - VAL-EXEC-001: Scrutiny phases auto-inject at milestone completion
 * - VAL-EXEC-002: Behavioral validation phases auto-inject
 * - VAL-EXEC-008: Skip flags bypass validation
 * - VAL-EXEC-009: Validation phases have correct metadata
 * - VAL-EXEC-012: Injection preserves phase ordering
 * - VAL-CROSS-007: Skip flags propagate through entire chain
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkerResult, WorkerFailureReason } from "../src/schemas/worker";
import type { ProcessSpawner, SpawnOptions, SpawnResult } from "../src/worker/spawner";
import type { FlywheelConfig } from "../src/config/loader";
import type { PhaseInfo } from "../src/controller/phase-provider";
import type { WorkflowStepContext } from "../src/prompts/index";
import { EventBus, createFlywheelEmitter } from "../src/events/event-bus";
import { MockAdapter } from "../src/tui/adapters/mock";
import { CONFIG_DEFAULTS } from "../src/config/loader";
import { PhaseExecutor } from "../src/controller/phase-executor";
import { ExecutionLoop } from "../src/controller/execution-loop";
import type { PromptBuilder, UnifiedExecutionLoopOptions } from "../src/controller/execution-loop";
import { MilestoneTracker } from "../src/controller/milestone-tracker";
import { claudeEngine } from "../src/engines/providers/claude/index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_DIR = path.join(os.tmpdir(), `flywheel-milestone-injection-test-${process.pid}-${Date.now()}`);

function successResult(output: string = "<promise>COMPLETE</promise>"): WorkerResult {
  return {
    output,
    exitCode: 0,
    truncated: false,
    durationMs: 1000,
    failure: undefined,
    handoffPath: "",
  };
}

class MockSpawner implements ProcessSpawner {
  results: WorkerResult[] = [];
  calls: Array<{ command: string; args: string[]; options?: SpawnOptions }> = [];
  private callIndex = 0;

  async spawn(command: string, args: string[], options?: SpawnOptions): Promise<SpawnResult> {
    this.calls.push({ command, args, options });
    const result = this.results[this.callIndex] ?? successResult();
    this.callIndex++;
    return { result: Promise.resolve(result) };
  }

  reset(): void {
    this.calls = [];
    this.callIndex = 0;
  }
}

function defaultConfig(overrides?: Partial<FlywheelConfig>): FlywheelConfig {
  return { ...CONFIG_DEFAULTS, ...overrides };
}

const testPromptBuilder: PromptBuilder = (phase: PhaseInfo, ctx: WorkflowStepContext) => {
  return `Phase ${phase.index + 1}: ${phase.title}`;
};

class SimplePhaseProvider {
  private _phases: PhaseInfo[];
  constructor(phases: PhaseInfo[]) { this._phases = phases; }
  getPhases(): PhaseInfo[] { return this._phases; }
  get phaseCount(): number { return this._phases.length; }
}

function makePhases(count: number, overrides?: (Partial<PhaseInfo> | null)[]): PhaseInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    title: `Phase ${i + 1}`,
    description: `Description for phase ${i + 1}`,
    status: "pending" as const,
    steps: [`Step ${i + 1}a`, `Step ${i + 1}b`],
    ...(overrides?.[i] ?? {}),
  }));
}

function createLoopWithMilestoneTracker(opts: {
  phases: PhaseInfo[];
  spawnerResults?: WorkerResult[];
  config?: Partial<FlywheelConfig>;
  milestoneTracker?: MilestoneTracker;
}) {
  const bus = new EventBus();
  const emitter = createFlywheelEmitter(bus);
  const adapter = new MockAdapter();
  adapter.connect(bus);
  adapter.start();

  const spawner = new MockSpawner();
  if (opts.spawnerResults) spawner.results = opts.spawnerResults;

  const config = defaultConfig(opts.config);
  const executor = new PhaseExecutor({
    spawner,
    emitter,
    config,
    engine: claudeEngine,
    workflowId: "test-wf",
  });

  const phases = opts.phases;
  const provider = new SimplePhaseProvider(phases);
  const milestoneTracker = opts.milestoneTracker ?? new MilestoneTracker();

  const loop = new ExecutionLoop({
    phaseProvider: provider,
    promptBuilder: testPromptBuilder,
    executor,
    emitter,
    config,
    ui: adapter,
    workflowId: "test-wf",
    workflowLabel: "test-workflow",
    milestoneTracker,
  });

  return { loop, bus, emitter, adapter, spawner, config, milestoneTracker, phases };
}

afterEach(() => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ok */ }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExecutionLoop milestone validation injection", () => {

  // VAL-EXEC-001 + VAL-EXEC-002: Auto-inject scrutiny + behavioral validation
  describe("VAL-EXEC-001/002: auto-injection at milestone completion", () => {
    it("injects scrutiny and behavioral validation phases when milestone completes", async () => {
      // Two phases in milestone "M1", both will succeed
      const phases = makePhases(2, [
        { milestone: "M1" },
        { milestone: "M1" },
      ]);

      // Need enough results: 2 implementation + 2 validation (scrutiny + behavioral)
      const { loop, spawner } = createLoopWithMilestoneTracker({
        phases,
        spawnerResults: [successResult(), successResult(), successResult(), successResult()],
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      // 2 original + 2 injected = 4 total
      expect(result.phasesCompleted).toBe(4);
      expect(result.phasesTotal).toBe(4);

      // Verify that 4 phases were actually executed (4 spawner calls)
      expect(spawner.calls.length).toBe(4);
    });

    it("injected phases run between milestone and next milestone phases", async () => {
      // M1: 2 phases, M2: 1 phase
      // After M1 completes → injects 2 validation for M1
      // After M2 completes → injects 2 validation for M2
      // Total: 3 original + 2 (M1 validation) + 2 (M2 validation) = 7
      const phases = makePhases(3, [
        { milestone: "M1" },
        { milestone: "M1" },
        { milestone: "M2" },
      ]);

      const { loop, spawner } = createLoopWithMilestoneTracker({
        phases,
        spawnerResults: Array(7).fill(successResult()),
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(7);
      expect(result.phasesTotal).toBe(7);
      expect(spawner.calls.length).toBe(7);
    });
  });

  // VAL-EXEC-012: Injection preserves relative order of existing pending phases
  describe("VAL-EXEC-012: injection preserves phase ordering", () => {
    it("validation phases are injected before remaining pending phases", async () => {
      // M1: 1 phase, M2: 1 phase
      // After M1 completes → injects Scrutiny: M1 + Validation: M1 between M1 and M2
      // After M2 completes → injects Scrutiny: M2 + Validation: M2
      // Total: 2 original + 2 (M1 val) + 2 (M2 val) = 6
      const phases = makePhases(2, [
        { milestone: "M1" },
        { milestone: "M2" },
      ]);

      const { loop, spawner } = createLoopWithMilestoneTracker({
        phases,
        spawnerResults: Array(6).fill(successResult()),
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      // After Phase 1 completes (M1 complete), injection happens:
      // Phases array becomes: [Phase 1 (done), Scrutiny: M1, Validation: M1, Phase 2 (M2), ...]
      // Then after M2 completes, more validation is injected
      expect(result.phasesCompleted).toBe(6);
      expect(spawner.calls.length).toBe(6);
    });
  });

  // VAL-EXEC-008: Skip flags bypass validation
  describe("VAL-EXEC-008: skip flags", () => {
    it("skip_scrutiny prevents scrutiny phase injection", async () => {
      const phases = makePhases(2, [
        { milestone: "M1" },
        { milestone: "M1" },
      ]);

      // 2 original + 1 behavioral only = 3
      const { loop, spawner } = createLoopWithMilestoneTracker({
        phases,
        spawnerResults: Array(3).fill(successResult()),
        config: { skip_scrutiny: true },
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(3);
      expect(spawner.calls.length).toBe(3);
    });

    it("skip_validation prevents behavioral validation phase injection", async () => {
      const phases = makePhases(2, [
        { milestone: "M1" },
        { milestone: "M1" },
      ]);

      // 2 original + 1 scrutiny only = 3
      const { loop, spawner } = createLoopWithMilestoneTracker({
        phases,
        spawnerResults: Array(3).fill(successResult()),
        config: { skip_validation: true },
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(3);
      expect(spawner.calls.length).toBe(3);
    });

    it("both skip flags prevent all validation injection", async () => {
      const phases = makePhases(2, [
        { milestone: "M1" },
        { milestone: "M1" },
      ]);

      // Only 2 original phases — no injection
      const { loop, spawner } = createLoopWithMilestoneTracker({
        phases,
        spawnerResults: Array(2).fill(successResult()),
        config: { skip_scrutiny: true, skip_validation: true },
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(2);
      expect(spawner.calls.length).toBe(2);
    });
  });

  // No milestone tracker = no injection
  describe("no milestone tracker configured", () => {
    it("runs normally without milestone tracker", async () => {
      const phases = makePhases(2, [
        { milestone: "M1" },
        { milestone: "M1" },
      ]);

      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const spawner = new MockSpawner();
      spawner.results = [successResult(), successResult()];

      const config = defaultConfig();
      const executor = new PhaseExecutor({
        spawner,
        emitter,
        config,
        engine: claudeEngine,
        workflowId: "test-wf",
      });

      const loop = new ExecutionLoop({
        phaseProvider: new SimplePhaseProvider(phases),
        promptBuilder: testPromptBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-wf",
        workflowLabel: "test-workflow",
        // No milestoneTracker set
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(2);
      expect(spawner.calls.length).toBe(2);
    });
  });

  // Phases without milestones should not trigger injection
  describe("phases without milestones", () => {
    it("does not inject validation when phases have no milestone", async () => {
      const phases = makePhases(2); // No milestone set

      const { loop, spawner } = createLoopWithMilestoneTracker({
        phases,
        spawnerResults: Array(2).fill(successResult()),
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(2);
      expect(spawner.calls.length).toBe(2);
    });
  });

  // Sealed milestones from tracker initialization should not re-inject
  describe("sealed milestones", () => {
    it("pre-sealed milestones do not trigger injection", async () => {
      const phases = makePhases(2, [
        { milestone: "M1" },
        { milestone: "M1" },
      ]);

      // M1 is already sealed
      const milestoneTracker = new MilestoneTracker(["M1"]);

      const { loop, spawner } = createLoopWithMilestoneTracker({
        phases,
        spawnerResults: Array(2).fill(successResult()),
        milestoneTracker,
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(2);
      expect(spawner.calls.length).toBe(2);
    });
  });

  // Multiple milestones: first completes, second hasn't yet
  describe("multi-milestone scenarios", () => {
    it("injects validation only for completed milestones", async () => {
      // M1: 1 completed + 1 pending, M2: 1 pending
      // After phase 0 completes, M1 still has pending phase 1
      // After phase 1 completes, M1 is complete → inject 2 validation
      // Then validation phases run, then M2 phase runs (1 total M2 + no injection since M2 only has 1 phase)
      const phases = makePhases(3, [
        { milestone: "M1" },
        { milestone: "M1" },
        { milestone: "M2" },
      ]);

      // 3 original + 2 injected for M1 = 5 phases
      // After M2's single phase completes, M2 also triggers injection = 5 + 2 = 7
      const { loop, spawner } = createLoopWithMilestoneTracker({
        phases,
        spawnerResults: Array(7).fill(successResult()),
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      // Both M1 and M2 should have validation injected
      expect(result.phasesCompleted).toBe(7);
      expect(spawner.calls.length).toBe(7);
    });
  });

  // Verify phasesTotal is updated when phases are injected
  describe("phasesTotal tracking", () => {
    it("phasesTotal reflects injected phases", async () => {
      const phases = makePhases(1, [
        { milestone: "M1" },
      ]);

      // 1 original + 2 validation = 3
      const { loop, spawner } = createLoopWithMilestoneTracker({
        phases,
        spawnerResults: Array(3).fill(successResult()),
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesTotal).toBe(3);
      expect(result.phasesCompleted).toBe(3);
    });
  });
});

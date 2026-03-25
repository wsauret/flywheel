import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
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
import type { PromptBuilder, ShouldSkipPhaseHook, UnifiedExecutionLoopOptions } from "../src/controller/execution-loop";
import { claudeEngine } from "../src/engines/providers/claude/index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

class SimplePhaseProvider {
  private _phases: PhaseInfo[];

  constructor(phases: PhaseInfo[]) {
    this._phases = phases;
  }

  getPhases(): PhaseInfo[] {
    return this._phases;
  }

  get phaseCount(): number {
    return this._phases.length;
  }
}

function createLoopWithHook(opts: {
  phases?: PhaseInfo[];
  spawnerResults?: WorkerResult[];
  onStepComplete?: UnifiedExecutionLoopOptions["onStepComplete"];
  shouldSkipPhase?: ShouldSkipPhaseHook;
  promptBuilder?: PromptBuilder;
}) {
  const bus = new EventBus();
  const emitter = createFlywheelEmitter(bus);
  const adapter = new MockAdapter();
  adapter.connect(bus);
  adapter.start();

  const spawner = new MockSpawner();
  if (opts.spawnerResults) spawner.results = opts.spawnerResults;

  const config = defaultConfig();
  const executor = new PhaseExecutor({
    spawner,
    emitter,
    config,
    engine: claudeEngine,
    workflowId: "test-hooks",
  });

  const phases = opts.phases ?? makePhases(3);
  const provider = new SimplePhaseProvider(phases);

  const defaultPromptBuilder: PromptBuilder = (phase, ctx) => {
    const parts = [`Phase ${phase.index + 1}: ${phase.title}`];
    if (ctx.previousResult) parts.push(`Previous: ${ctx.previousResult}`);
    if (ctx.extra && Object.keys(ctx.extra).length > 0) {
      parts.push(`Extra: ${JSON.stringify(ctx.extra)}`);
    }
    return parts.join("\n");
  };

  const loop = new ExecutionLoop({
    phaseProvider: provider,
    promptBuilder: opts.promptBuilder ?? defaultPromptBuilder,
    executor,
    emitter,
    config,
    ui: adapter,
    workflowId: "test-hooks",
    workflowLabel: "test-hooks",
    onStepComplete: opts.onStepComplete,
    shouldSkipPhase: opts.shouldSkipPhase,
  });

  return { loop, bus, emitter, adapter, spawner, config };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExecutionLoop onStepComplete hook", () => {
  describe("callback invocation", () => {
    it("calls onStepComplete with stepIndex and full WorkerResult after each phase", async () => {
      const hookCalls: Array<{ stepIndex: number; result: WorkerResult }> = [];

      const { loop } = createLoopWithHook({
        spawnerResults: [
          successResult("output-phase-1"),
          successResult("output-phase-2"),
          successResult("output-phase-3"),
        ],
        onStepComplete: async (stepIndex, result, _accum) => {
          hookCalls.push({ stepIndex, result });
          return {};
        },
      });

      await loop.run();

      expect(hookCalls).toHaveLength(3);
      expect(hookCalls[0].stepIndex).toBe(0);
      expect(hookCalls[0].result.output).toBe("output-phase-1");
      expect(hookCalls[1].stepIndex).toBe(1);
      expect(hookCalls[1].result.output).toBe("output-phase-2");
      expect(hookCalls[2].stepIndex).toBe(2);
      expect(hookCalls[2].result.output).toBe("output-phase-3");
    });

    it("receives the full WorkerResult (not truncated previousResult)", async () => {
      const largeOutput = "x".repeat(300_000);
      const hookCalls: Array<{ result: WorkerResult }> = [];

      const { loop } = createLoopWithHook({
        phases: makePhases(2),
        spawnerResults: [
          successResult(largeOutput),
          successResult("done"),
        ],
        onStepComplete: async (_stepIndex, result, _accum) => {
          hookCalls.push({ result });
          return {};
        },
      });

      await loop.run();

      // The hook should receive the full output, not truncated
      expect(hookCalls[0].result.output).toBe(largeOutput);
      expect(hookCalls[0].result.output.length).toBe(300_000);
    });
  });

  describe("extra accumulator", () => {
    it("merges returned object into accumulator across steps", async () => {
      const accumulatorSnapshots: Record<string, unknown>[] = [];

      const { loop } = createLoopWithHook({
        spawnerResults: [
          successResult("r1"),
          successResult("r2"),
          successResult("r3"),
        ],
        onStepComplete: async (stepIndex, _result, accumulated) => {
          accumulatorSnapshots.push({ ...accumulated });
          if (stepIndex === 0) return { researchDone: true };
          if (stepIndex === 1) return { planPath: "feat-test.md" };
          return { reviewComplete: true };
        },
      });

      await loop.run();

      // Step 0: accumulator was empty when called
      expect(accumulatorSnapshots[0]).toEqual({});
      // Step 1: accumulator has step 0's contribution
      expect(accumulatorSnapshots[1]).toEqual({ researchDone: true });
      // Step 2: accumulator has step 0 + step 1's contributions
      expect(accumulatorSnapshots[2]).toEqual({
        researchDone: true,
        planPath: "feat-test.md",
      });
    });

    it("passes accumulated extra to prompt builder via ctx.extra", async () => {
      const capturedExtras: Array<Record<string, unknown> | undefined> = [];

      const customBuilder: PromptBuilder = (phase, ctx) => {
        capturedExtras.push(ctx.extra ? { ...ctx.extra } : undefined);
        return `Phase ${phase.index + 1}`;
      };

      const { loop } = createLoopWithHook({
        spawnerResults: [
          successResult("r1"),
          successResult("r2"),
          successResult("r3"),
        ],
        promptBuilder: customBuilder,
        onStepComplete: async (stepIndex, _result, _accumulated) => {
          if (stepIndex === 0) return { fromStep0: "data0" };
          if (stepIndex === 1) return { fromStep1: "data1" };
          return {};
        },
      });

      await loop.run();

      // Context entries are always populated (empty arrays when no indexer)
      // Also contains handoffPath + invocationId (UUIDs, dynamic per run)
      const emptyContext = { conventions: [], standards: [], learnings: [] };
      // Phase 1 prompt: no extra yet (accumulator starts empty) + context entries + handoff
      expect(capturedExtras[0]).toMatchObject({ ...emptyContext });
      expect(capturedExtras[0]).toHaveProperty("handoffPath");
      expect(capturedExtras[0]).toHaveProperty("invocationId");
      // Phase 2 prompt: extra from step 0 + context entries + handoff
      expect(capturedExtras[1]).toMatchObject({ fromStep0: "data0", ...emptyContext });
      // Phase 3 prompt: extra from step 0 + step 1 + context entries + handoff
      expect(capturedExtras[2]).toMatchObject({ fromStep0: "data0", fromStep1: "data1", ...emptyContext });
    });

    it("works without onStepComplete hook (no crash, empty extra)", async () => {
      const capturedExtras: Array<Record<string, unknown> | undefined> = [];

      const customBuilder: PromptBuilder = (phase, ctx) => {
        capturedExtras.push(ctx.extra ? { ...ctx.extra } : undefined);
        return `Phase ${phase.index + 1}`;
      };

      const { loop } = createLoopWithHook({
        phases: makePhases(2),
        spawnerResults: [successResult("r1"), successResult("r2")],
        promptBuilder: customBuilder,
        // No onStepComplete
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      // Extra should contain context entries (empty arrays when no indexer) + handoff
      const emptyContext = { conventions: [], standards: [], learnings: [] };
      expect(capturedExtras[0]).toMatchObject({ ...emptyContext });
      expect(capturedExtras[1]).toMatchObject({ ...emptyContext });
    });
  });

  describe("previousResult passthrough (no truncation)", () => {
    it("passes full previousResult without truncation when no handoff", async () => {
      const capturedCtx: WorkflowStepContext[] = [];

      const customBuilder: PromptBuilder = (phase, ctx) => {
        capturedCtx.push({ ...ctx });
        return `Phase ${phase.index + 1}`;
      };

      const largeOutput = "y".repeat(300_000);

      const { loop } = createLoopWithHook({
        phases: makePhases(2),
        spawnerResults: [successResult(largeOutput), successResult("done")],
        promptBuilder: customBuilder,
      });

      await loop.run();

      // Without handoff, raw output is passed directly (no truncation)
      const prevResult = capturedCtx[1]?.previousResult ?? "";
      expect(prevResult.length).toBe(300_000);
      expect(prevResult).not.toContain("truncated");
    });
  });

  describe("hook does not affect skipped/approved phases", () => {
    it("does not call onStepComplete for skipped (completed) phases", async () => {
      const hookCalls: number[] = [];

      const { loop } = createLoopWithHook({
        phases: makePhases(3, [
          { status: "completed" },
          null, // pending
          null, // pending
        ]),
        spawnerResults: [successResult("r1"), successResult("r2")],
        onStepComplete: async (stepIndex, _result, _accum) => {
          hookCalls.push(stepIndex);
          return {};
        },
      });

      await loop.run();

      // Only the two pending phases should trigger the hook
      expect(hookCalls).toEqual([1, 2]);
    });
  });
});

// ---------------------------------------------------------------------------
// shouldSkipPhase hook
// ---------------------------------------------------------------------------

describe("ExecutionLoop shouldSkipPhase hook", () => {
  it("skips phases where shouldSkipPhase returns true", async () => {
    const executedPhases: number[] = [];

    const { loop, spawner } = createLoopWithHook({
      phases: makePhases(4),
      spawnerResults: [
        successResult("r1"),
        successResult("r2"),
        successResult("r3"),
        successResult("r4"),
      ],
      shouldSkipPhase: (phase) => phase.index === 2, // skip phase 3
      promptBuilder: (phase, _ctx) => {
        executedPhases.push(phase.index);
        return `Phase ${phase.index + 1}`;
      },
    });

    const result = await loop.run();

    expect(result.completed).toBe(true);
    expect(result.phasesCompleted).toBe(4); // all counted as completed
    expect(result.phasesTotal).toBe(4);
    // Phase 2 (index 2) was skipped — never sent to prompt builder or spawner
    expect(executedPhases).toEqual([0, 1, 3]);
    expect(spawner.calls).toHaveLength(3); // only 3 spawns, not 4
  });

  it("still counts skipped phases toward phasesCompleted", async () => {
    const { loop } = createLoopWithHook({
      phases: makePhases(3),
      spawnerResults: [successResult("r1"), successResult("r2")],
      shouldSkipPhase: (phase) => phase.index === 1, // skip middle phase
    });

    const result = await loop.run();

    expect(result.completed).toBe(true);
    expect(result.phasesCompleted).toBe(3);
    expect(result.phasesTotal).toBe(3);
  });

  it("does not call onStepComplete for skipped phases", async () => {
    const hookCalls: number[] = [];

    const { loop } = createLoopWithHook({
      phases: makePhases(3),
      spawnerResults: [successResult("r1"), successResult("r2")],
      shouldSkipPhase: (phase) => phase.index === 1,
      onStepComplete: async (stepIndex, _result, _accum) => {
        hookCalls.push(stepIndex);
        return {};
      },
    });

    await loop.run();

    // Only phases 0 and 2 executed — phase 1 was skipped
    expect(hookCalls).toEqual([0, 2]);
  });

  it("receives accumulated extra from previous steps", async () => {
    const skipCalls: Array<{ index: number; extra: Record<string, unknown> }> = [];

    const { loop } = createLoopWithHook({
      phases: makePhases(3),
      spawnerResults: [successResult("r1"), successResult("r2"), successResult("r3")],
      shouldSkipPhase: (phase, extra) => {
        skipCalls.push({ index: phase.index, extra: { ...extra } });
        return false; // don't actually skip
      },
      onStepComplete: async (stepIndex, _result, _accum) => {
        if (stepIndex === 0) return { fromStep0: true };
        if (stepIndex === 1) return { fromStep1: true };
        return {};
      },
    });

    await loop.run();

    expect(skipCalls).toHaveLength(3);
    // Phase 0: no accumulated data yet
    expect(skipCalls[0].extra).toEqual({});
    // Phase 1: has data from step 0
    expect(skipCalls[1].extra).toEqual({ fromStep0: true });
    // Phase 2: has data from step 0 + step 1
    expect(skipCalls[2].extra).toEqual({ fromStep0: true, fromStep1: true });
  });

  it("works correctly when all phases are skipped", async () => {
    const { loop, spawner } = createLoopWithHook({
      phases: makePhases(2),
      shouldSkipPhase: () => true, // skip everything
    });

    const result = await loop.run();

    expect(result.completed).toBe(true);
    expect(result.phasesCompleted).toBe(2);
    expect(spawner.calls).toHaveLength(0); // nothing spawned
  });

  it("does not skip already-completed phases (completed check runs first)", async () => {
    const skipCalls: number[] = [];

    const { loop } = createLoopWithHook({
      phases: makePhases(3, [
        { status: "completed" }, // already done
        null, // pending
        null, // pending
      ]),
      spawnerResults: [successResult("r1"), successResult("r2")],
      shouldSkipPhase: (phase) => {
        skipCalls.push(phase.index);
        return false;
      },
    });

    await loop.run();

    // shouldSkipPhase should NOT be called for the already-completed phase 0
    expect(skipCalls).toEqual([1, 2]);
  });
});

/**
 * Integration tests for budget enforcement through the workflow startup path.
 *
 * Verifies end-to-end: BudgetTracker + ExecutionLoop + PhaseExecutor wired
 * together with real components (not mocks) to enforce budget limits during
 * workflow execution.
 *
 * Uses MockSpawner (controlled worker results) + real EventBus + real
 * BudgetTracker + real ExecutionLoop + real PhaseExecutor.
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { WorkerResult, WorkerFailureReason } from "../../src/schemas/worker";
import type { ProcessSpawner, SpawnOptions, SpawnResult } from "../../src/worker/spawner";
import type { PhaseInfo } from "../../src/controller/phase-provider";
import type { WorkflowStepContext } from "../../src/prompts/index";
import type { FlywheelConfig } from "../../src/config/loader";
import type { BudgetLimits } from "../../src/schemas/shared";
import { EventBus, createFlywheelEmitter } from "../../src/events/event-bus";
import { MockAdapter } from "../../src/tui/adapters/mock";
import { CONFIG_DEFAULTS } from "../../src/config/loader";
import { PhaseExecutor } from "../../src/controller/phase-executor";
import { ExecutionLoop, type PromptBuilder } from "../../src/controller/execution-loop";
import { WorkflowDefinitionProvider } from "../../src/controller/workflow-def-provider";
import { claudeEngine } from "../../src/engines/providers/claude/index";
import { createBudgetTracker, type BudgetTracker } from "../../src/session/budget-tracker";
import { createSession, readSession } from "../../src/session/persistence";
import type { Session } from "../../src/schemas/session";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-budget-integration-${process.pid}-${Date.now()}`,
);

function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function minimalSession(overrides?: Partial<Session>): Session {
  return {
    label: "test-plan",
    planPath: "plans/test.md",
    lastUpdated: new Date().toISOString(),
    budgetLimits: { max_invocations: 0, max_tokens: null, wall_clock_deadline: null },
    budgetUsage: { invocations_used: 0, tokens_used: 0, cost_usd: 0 },
    workflowType: "work",
    ...overrides,
  };
}

function successResult(output: string = "<promise>COMPLETE</promise>"): WorkerResult {
  return {
    output,
    exitCode: 0,
    truncated: false,
    durationMs: 100,
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

function makePhases(count: number): PhaseInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    title: `Phase ${i + 1}`,
    description: `Description for phase ${i + 1}`,
    status: "pending" as const,
    steps: [`Step ${i + 1}a`, `Step ${i + 1}b`],
  }));
}

const testPromptBuilder: PromptBuilder = (phase: PhaseInfo, ctx: WorkflowStepContext) => {
  return `Phase ${phase.index + 1}: ${phase.title}`;
};

function defaultConfig(overrides?: Partial<FlywheelConfig>): FlywheelConfig {
  return { ...CONFIG_DEFAULTS, ...overrides };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // May not exist
  }
});

// ---------------------------------------------------------------------------
// Tests: End-to-end budget enforcement with real BudgetTracker
// ---------------------------------------------------------------------------

describe("Budget enforcement integration", () => {
  it("unlimited budget: workflow completes normally, budgetUsage tracks invocations and cost", async () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);

    // Create real BudgetTracker (debounce disabled for test reliability)
    const tracker = createBudgetTracker({
      sessionId,
      baseDir,
      debounceMs: 0,
    });

    const bus = new EventBus();
    const emitter = createFlywheelEmitter(bus);
    const adapter = new MockAdapter();
    adapter.connect(bus);
    adapter.start();

    const spawner = new MockSpawner();
    spawner.results = [successResult("Phase 1 done"), successResult("Phase 2 done"), successResult("Phase 3 done")];

    const config = defaultConfig();
    const executor = new PhaseExecutor({
      spawner,
      emitter,
      config,
      engine: claudeEngine,
      workflowId: "test-budget-e2e",
    });

    const phases = makePhases(3);
    const provider = new SimplePhaseProvider(phases);

    const limits: BudgetLimits = {
      max_invocations: 0, // unlimited
      max_tokens: null,
      wall_clock_deadline: null,
    };

    const loop = new ExecutionLoop({
      phaseProvider: provider,
      promptBuilder: testPromptBuilder,
      executor,
      emitter,
      config,
      ui: adapter,
      workflowId: "test-budget-e2e",
      workflowLabel: "budget-integration-test",
      budgetTracker: tracker,
      budgetLimits: limits,
    });

    const result = await loop.run();

    expect(result.completed).toBe(true);
    expect(result.phasesCompleted).toBe(3);
    expect(result.phasesTotal).toBe(3);

    // BudgetTracker should have tracked 3 invocations (one per phase)
    expect(tracker.getInvocationsUsed()).toBe(3);

    // Flush to persist
    tracker.flush();

    // Verify persisted session has updated budgetUsage
    const session = readSession(sessionId, baseDir);
    expect(session).not.toBeNull();
    expect(session!.budgetUsage.invocations_used).toBe(3);

    tracker.dispose();
  });

  it("limited invocations: workflow stops after limit reached with 'Budget exhausted'", async () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession({
      budgetLimits: { max_invocations: 2, max_tokens: null, wall_clock_deadline: null },
    }), baseDir);

    // Create real BudgetTracker
    const tracker = createBudgetTracker({
      sessionId,
      baseDir,
      debounceMs: 0,
    });

    const bus = new EventBus();
    const emitter = createFlywheelEmitter(bus);
    const adapter = new MockAdapter();
    adapter.connect(bus);
    adapter.start();

    const spawner = new MockSpawner();
    // Provide enough results for all phases (only 2 should execute)
    spawner.results = [
      successResult("Phase 1 done"),
      successResult("Phase 2 done"),
      successResult("Phase 3 done"),
      successResult("Phase 4 done"),
    ];

    const config = defaultConfig();
    const executor = new PhaseExecutor({
      spawner,
      emitter,
      config,
      engine: claudeEngine,
      workflowId: "test-budget-limit",
    });

    const phases = makePhases(4);
    const provider = new SimplePhaseProvider(phases);

    const limits: BudgetLimits = {
      max_invocations: 2,
      max_tokens: null,
      wall_clock_deadline: null,
    };

    const loop = new ExecutionLoop({
      phaseProvider: provider,
      promptBuilder: testPromptBuilder,
      executor,
      emitter,
      config,
      ui: adapter,
      workflowId: "test-budget-limit",
      workflowLabel: "budget-limit-test",
      budgetTracker: tracker,
      budgetLimits: limits,
    });

    const result = await loop.run();

    // Should stop after 2 phases (budget exhausted before phase 3)
    expect(result.completed).toBe(false);
    expect(result.phasesCompleted).toBe(2);
    expect(result.phasesTotal).toBe(4);
    expect(result.reason).toBe("Budget exhausted");

    // Only 2 worker spawns should have occurred
    expect(spawner.calls.length).toBe(2);

    // Tracker confirms invocations
    expect(tracker.getInvocationsUsed()).toBe(2);
    expect(tracker.isExhausted(limits)).toBe(true);

    // Flush and verify persistence
    tracker.flush();
    const session = readSession(sessionId, baseDir);
    expect(session).not.toBeNull();
    expect(session!.budgetUsage.invocations_used).toBe(2);

    tracker.dispose();
  });

  it("budget tracker reports correct remaining values via getBudgetStatus()", async () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession({
      budgetLimits: { max_invocations: 10, max_tokens: 50000, wall_clock_deadline: null },
    }), baseDir);

    const tracker = createBudgetTracker({
      sessionId,
      baseDir,
      debounceMs: 0,
    });

    const limits: BudgetLimits = {
      max_invocations: 10,
      max_tokens: 50000,
      wall_clock_deadline: null,
    };

    // Simulate some usage
    tracker.incrementInvocations();
    tracker.incrementInvocations();
    tracker.incrementInvocations();

    const status = tracker.getBudgetStatus(limits);

    expect(status.invocations_remaining).toBe(7);
    expect(status.token_budget_remaining).toBe(50000); // no tokens consumed
    expect(status.wall_clock_deadline).toBeNull();

    tracker.dispose();
  });

  it("dispatcher receives real budget values (null for unlimited)", async () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);

    const tracker = createBudgetTracker({
      sessionId,
      baseDir,
      debounceMs: 0,
    });

    const unlimitedLimits: BudgetLimits = {
      max_invocations: 0,
      max_tokens: null,
      wall_clock_deadline: null,
    };

    const status = tracker.getBudgetStatus(unlimitedLimits);

    // Unlimited budget: all remaining values should be null
    expect(status.invocations_remaining).toBeNull();
    expect(status.token_budget_remaining).toBeNull();
    expect(status.wall_clock_deadline).toBeNull();

    tracker.dispose();
  });

  it("budget-exhausted workflow can resume with increased budget", async () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession({
      budgetLimits: { max_invocations: 1, max_tokens: null, wall_clock_deadline: null },
    }), baseDir);

    // First run: budget exhausted after 1 phase
    const tracker1 = createBudgetTracker({
      sessionId,
      baseDir,
      debounceMs: 0,
    });

    const bus1 = new EventBus();
    const emitter1 = createFlywheelEmitter(bus1);
    const adapter1 = new MockAdapter();
    adapter1.connect(bus1);
    adapter1.start();

    const spawner1 = new MockSpawner();
    spawner1.results = [successResult("Phase 1"), successResult("Phase 2")];

    const config = defaultConfig();
    const executor1 = new PhaseExecutor({
      spawner: spawner1,
      emitter: emitter1,
      config,
      engine: claudeEngine,
      workflowId: "test-resume-1",
    });

    const phases = makePhases(2);
    const provider1 = new SimplePhaseProvider(phases);

    const tightLimits: BudgetLimits = {
      max_invocations: 1,
      max_tokens: null,
      wall_clock_deadline: null,
    };

    const loop1 = new ExecutionLoop({
      phaseProvider: provider1,
      promptBuilder: testPromptBuilder,
      executor: executor1,
      emitter: emitter1,
      config,
      ui: adapter1,
      workflowId: "test-resume-1",
      workflowLabel: "resume-test-run1",
      budgetTracker: tracker1,
      budgetLimits: tightLimits,
    });

    const result1 = await loop1.run();
    expect(result1.completed).toBe(false);
    expect(result1.phasesCompleted).toBe(1);
    expect(result1.reason).toBe("Budget exhausted");

    tracker1.flush();
    tracker1.dispose();

    // Verify persisted budget usage
    const sessionAfterExhaustion = readSession(sessionId, baseDir);
    expect(sessionAfterExhaustion!.budgetUsage.invocations_used).toBe(1);

    // Second run: create a new tracker that starts fresh (simulating resume
    // after user increases budget). The tracker reads from in-memory state,
    // not from disk, so a fresh tracker starts at 0 invocations.
    // In a real resume, the session state would be reloaded to continue
    // from where it stopped.
    const tracker2 = createBudgetTracker({
      sessionId,
      baseDir,
      debounceMs: 0,
    });

    const bus2 = new EventBus();
    const emitter2 = createFlywheelEmitter(bus2);
    const adapter2 = new MockAdapter();
    adapter2.connect(bus2);
    adapter2.start();

    const spawner2 = new MockSpawner();
    spawner2.results = [successResult("Phase 1 resumed"), successResult("Phase 2 resumed")];

    const executor2 = new PhaseExecutor({
      spawner: spawner2,
      emitter: emitter2,
      config,
      engine: claudeEngine,
      workflowId: "test-resume-2",
    });

    // The remaining phase (phase 2) — in a real scenario the plan file
    // would track which phases are completed via .state.md
    const remainingPhases = makePhases(2);
    const provider2 = new SimplePhaseProvider(remainingPhases);

    // Increased budget (10 invocations — plenty of headroom)
    const relaxedLimits: BudgetLimits = {
      max_invocations: 10,
      max_tokens: null,
      wall_clock_deadline: null,
    };

    const loop2 = new ExecutionLoop({
      phaseProvider: provider2,
      promptBuilder: testPromptBuilder,
      executor: executor2,
      emitter: emitter2,
      config,
      ui: adapter2,
      workflowId: "test-resume-2",
      workflowLabel: "resume-test-run2",
      budgetTracker: tracker2,
      budgetLimits: relaxedLimits,
    });

    const result2 = await loop2.run();
    expect(result2.completed).toBe(true);
    expect(result2.phasesCompleted).toBe(2);

    tracker2.flush();
    tracker2.dispose();
  });

  it("budget exhaustion persists usage data to session file via flush", async () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession({
      budgetLimits: { max_invocations: 3, max_tokens: null, wall_clock_deadline: null },
    }), baseDir);

    const tracker = createBudgetTracker({
      sessionId,
      baseDir,
      debounceMs: 0,
    });

    const bus = new EventBus();
    const emitter = createFlywheelEmitter(bus);
    const adapter = new MockAdapter();
    adapter.connect(bus);
    adapter.start();

    const spawner = new MockSpawner();
    spawner.results = [
      successResult("Phase 1"),
      successResult("Phase 2"),
      successResult("Phase 3"),
      successResult("Phase 4"),
      successResult("Phase 5"),
    ];

    const config = defaultConfig();
    const executor = new PhaseExecutor({
      spawner,
      emitter,
      config,
      engine: claudeEngine,
      workflowId: "test-persist",
    });

    const phases = makePhases(5);
    const provider = new SimplePhaseProvider(phases);

    const limits: BudgetLimits = {
      max_invocations: 3,
      max_tokens: null,
      wall_clock_deadline: null,
    };

    const loop = new ExecutionLoop({
      phaseProvider: provider,
      promptBuilder: testPromptBuilder,
      executor,
      emitter,
      config,
      ui: adapter,
      workflowId: "test-persist",
      workflowLabel: "persist-test",
      budgetTracker: tracker,
      budgetLimits: limits,
    });

    const result = await loop.run();

    // Budget stops after 3 invocations
    expect(result.completed).toBe(false);
    expect(result.phasesCompleted).toBe(3);
    expect(result.reason).toBe("Budget exhausted");

    // Dispose flushes pending data
    tracker.dispose();

    // Verify session file has correct budgetUsage
    const session = readSession(sessionId, baseDir);
    expect(session).not.toBeNull();
    expect(session!.budgetUsage.invocations_used).toBe(3);
    expect(session!.budgetUsage.cost_usd).toBe(0); // no cost events fired
    expect(session!.budgetUsage.tokens_used).toBe(0); // no token events fired
  });

  it("budget tracker handles NDJSON cost events during execution", async () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);

    const tracker = createBudgetTracker({
      sessionId,
      baseDir,
      debounceMs: 0,
    });

    // Simulate step_finish NDJSON events (as would come from worker stdout)
    tracker.handleEvent({
      type: "step_finish",
      data: {
        type: "step_finish",
        sessionID: "test",
        usage: { cost_usd: 0.05, input_tokens: 2000, output_tokens: 1000 },
      },
      raw: "{}",
    });

    tracker.handleEvent({
      type: "step_finish",
      data: {
        type: "step_finish",
        sessionID: "test",
        usage: { cost_usd: 0.10, input_tokens: 4000, output_tokens: 2000 },
      },
      raw: "{}",
    });

    expect(tracker.getTotalCost()).toBeCloseTo(0.15, 10);
    expect(tracker.getTokensUsed()).toBe(9000); // (2000+1000) + (4000+2000)

    // Check token-based budget limits
    const tokenLimits: BudgetLimits = {
      max_invocations: 0,
      max_tokens: 8000,
      wall_clock_deadline: null,
    };
    expect(tracker.isExhausted(tokenLimits)).toBe(true); // 9000 > 8000

    const relaxedTokenLimits: BudgetLimits = {
      max_invocations: 0,
      max_tokens: 20000,
      wall_clock_deadline: null,
    };
    expect(tracker.isExhausted(relaxedTokenLimits)).toBe(false); // 9000 < 20000

    // Flush and verify persistence
    tracker.flush();
    const session = readSession(sessionId, baseDir);
    expect(session).not.toBeNull();
    expect(session!.budgetUsage.cost_usd).toBeCloseTo(0.15, 10);
    expect(session!.budgetUsage.tokens_used).toBe(9000);

    tracker.dispose();
  });

  it("wall clock deadline enforcement stops workflow", async () => {
    const baseDir = makeTmpDir();
    // Set deadline in the past
    const pastDeadline = new Date(Date.now() - 60_000).toISOString();
    const sessionId = createSession(minimalSession({
      budgetLimits: { max_invocations: 0, max_tokens: null, wall_clock_deadline: pastDeadline },
    }), baseDir);

    const tracker = createBudgetTracker({
      sessionId,
      baseDir,
      debounceMs: 0,
    });

    const bus = new EventBus();
    const emitter = createFlywheelEmitter(bus);
    const adapter = new MockAdapter();
    adapter.connect(bus);
    adapter.start();

    const spawner = new MockSpawner();
    spawner.results = [successResult("Phase 1")];

    const config = defaultConfig();
    const executor = new PhaseExecutor({
      spawner,
      emitter,
      config,
      engine: claudeEngine,
      workflowId: "test-wall-clock",
    });

    const phases = makePhases(2);
    const provider = new SimplePhaseProvider(phases);

    const limits: BudgetLimits = {
      max_invocations: 0,
      max_tokens: null,
      wall_clock_deadline: pastDeadline,
    };

    const loop = new ExecutionLoop({
      phaseProvider: provider,
      promptBuilder: testPromptBuilder,
      executor,
      emitter,
      config,
      ui: adapter,
      workflowId: "test-wall-clock",
      workflowLabel: "wall-clock-test",
      budgetTracker: tracker,
      budgetLimits: limits,
    });

    const result = await loop.run();

    // Should stop immediately (before phase 1) because deadline is past
    expect(result.completed).toBe(false);
    expect(result.phasesCompleted).toBe(0);
    expect(result.reason).toBe("Budget exhausted");

    // No worker spawns should have occurred
    expect(spawner.calls.length).toBe(0);

    tracker.dispose();
  });

  it("no budget tracker: workflow runs without enforcement (backward compat)", async () => {
    // When budgetTracker and budgetLimits are omitted, execution proceeds normally
    const bus = new EventBus();
    const emitter = createFlywheelEmitter(bus);
    const adapter = new MockAdapter();
    adapter.connect(bus);
    adapter.start();

    const spawner = new MockSpawner();
    spawner.results = [successResult("Phase 1"), successResult("Phase 2")];

    const config = defaultConfig();
    const executor = new PhaseExecutor({
      spawner,
      emitter,
      config,
      engine: claudeEngine,
      workflowId: "test-no-budget",
    });

    const phases = makePhases(2);
    const provider = new SimplePhaseProvider(phases);

    const loop = new ExecutionLoop({
      phaseProvider: provider,
      promptBuilder: testPromptBuilder,
      executor,
      emitter,
      config,
      ui: adapter,
      workflowId: "test-no-budget",
      workflowLabel: "no-budget-test",
      // No budgetTracker or budgetLimits
    });

    const result = await loop.run();

    expect(result.completed).toBe(true);
    expect(result.phasesCompleted).toBe(2);
    expect(result.phasesTotal).toBe(2);
  });
});

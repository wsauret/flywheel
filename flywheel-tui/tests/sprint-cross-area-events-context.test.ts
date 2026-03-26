/**
 * Sprint Cross-Area Integration Tests — Events & Context
 *
 * Tests the integration boundaries between sprint subsystems:
 * - VAL-CROSS-004: Sprint events update TUI adapters
 * - VAL-CROSS-006: ContextIndexer feeds sprint worker
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { EventBus, createFlywheelEmitter } from "../src/events/event-bus";
import type { FlywheelEvent, SprintStarted, SprintIterationStarted,
  SprintVerificationStarted, SprintIterationCompleted,
  SprintEscalated, SprintCompleted } from "../src/events/types";
import { HeadlessAdapter } from "../src/tui/adapters/headless";
import { MockAdapter } from "../src/tui/adapters/mock";
import { OpenTUIAdapter } from "../src/tui/adapters/opentui";
import type { UIActions } from "../src/tui/routes/work/context/ui-state/types";
import type { WorkState, AnyBlock } from "../src/tui/routes/work/state/types";
import {
  createTestOptions,
  makeWorkerResult,
  makeHandoff,
  passingVerification,
  promptCapturingExecutor,
  defaultConfig,
} from "./fixtures/sprint-test-helpers";
import { createSprintLoop } from "../src/sprint/sprint-loop";
import type { ContextIndexer, ContextQuery } from "../src/memory/indexer";
import type { AvailableContext, ContextEntry } from "../src/schemas/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date().toISOString();

function makeSprintEvents(workflowId: string): FlywheelEvent[] {
  return [
    {
      type: "sprint:started",
      workflowId,
      taskDescription: "Test task for event propagation",
      maxIterations: 5,
      timestamp: NOW,
    } satisfies SprintStarted,
    {
      type: "sprint:iteration-started",
      workflowId,
      iteration: 1,
      maxIterations: 5,
      timestamp: NOW,
    } satisfies SprintIterationStarted,
    {
      type: "sprint:verification-started",
      workflowId,
      iteration: 1,
      scriptPath: ".flywheel/verify/test.ts",
      timestamp: NOW,
    } satisfies SprintVerificationStarted,
    {
      type: "sprint:iteration-completed",
      workflowId,
      iteration: 1,
      passed: true,
      reason: "All checks passed",
      timestamp: NOW,
    } satisfies SprintIterationCompleted,
    {
      type: "sprint:escalated",
      workflowId,
      iterationsUsed: 3,
      reason: "Hard cap reached",
      timestamp: NOW,
    } satisfies SprintEscalated,
    {
      type: "sprint:completed",
      workflowId,
      completed: true,
      iterationsUsed: 3,
      escalated: false,
      reason: "Success",
      timestamp: NOW,
    } satisfies SprintCompleted,
  ];
}

// ---------------------------------------------------------------------------
// VAL-CROSS-004: Sprint events update TUI adapters
// ---------------------------------------------------------------------------

describe("VAL-CROSS-004: Sprint events propagate to Headless adapter", () => {
  it("all 6 sprint event types are logged at appropriate levels", () => {
    const logs: string[] = [];
    const adapter = new HeadlessAdapter({
      logLevel: "verbose",
      timestamps: false,
      logger: (msg) => logs.push(msg),
    });

    const eventBus = new EventBus();
    adapter.connect(eventBus);
    adapter.start();

    const events = makeSprintEvents("test-wf-1");
    for (const event of events) {
      eventBus.emit(event);
    }

    adapter.stop();

    // sprint:started — always logged (minimal+)
    expect(logs.some((l) => l.includes("Sprint started"))).toBe(true);
    expect(logs.some((l) => l.includes("max 5 iterations"))).toBe(true);

    // sprint:iteration-started — normal+ (verbose covers it)
    expect(logs.some((l) => l.includes("Sprint iteration 1/5"))).toBe(true);

    // sprint:verification-started — verbose only
    expect(logs.some((l) => l.includes("Running verification"))).toBe(true);
    expect(logs.some((l) => l.includes(".flywheel/verify/test.ts"))).toBe(true);

    // sprint:iteration-completed — normal+
    expect(logs.some((l) => l.includes("Iteration 1 passed"))).toBe(true);

    // sprint:escalated — always logged
    expect(logs.some((l) => l.includes("Sprint ESCALATED"))).toBe(true);
    expect(logs.some((l) => l.includes("3 iterations"))).toBe(true);

    // sprint:completed — always logged
    expect(logs.some((l) => l.includes("Sprint completed"))).toBe(true);
    expect(logs.some((l) => l.includes("3 iterations"))).toBe(true);
  });

  it("minimal log level only shows started, escalated, and completed", () => {
    const logs: string[] = [];
    const adapter = new HeadlessAdapter({
      logLevel: "minimal",
      timestamps: false,
      logger: (msg) => logs.push(msg),
    });

    const eventBus = new EventBus();
    adapter.connect(eventBus);
    adapter.start();

    const events = makeSprintEvents("test-wf-2");
    for (const event of events) {
      eventBus.emit(event);
    }

    adapter.stop();

    // Always logged
    expect(logs.some((l) => l.includes("Sprint started"))).toBe(true);
    expect(logs.some((l) => l.includes("Sprint ESCALATED"))).toBe(true);
    expect(logs.some((l) => l.includes("Sprint completed"))).toBe(true);

    // NOT logged at minimal level
    expect(logs.some((l) => l.includes("Sprint iteration 1/5"))).toBe(false);
    expect(logs.some((l) => l.includes("Running verification"))).toBe(false);
    expect(logs.some((l) => l.includes("Iteration 1 passed"))).toBe(false);
  });

  it("normal log level shows iteration events but not verification", () => {
    const logs: string[] = [];
    const adapter = new HeadlessAdapter({
      logLevel: "normal",
      timestamps: false,
      logger: (msg) => logs.push(msg),
    });

    const eventBus = new EventBus();
    adapter.connect(eventBus);
    adapter.start();

    const events = makeSprintEvents("test-wf-3");
    for (const event of events) {
      eventBus.emit(event);
    }

    adapter.stop();

    // Logged at normal
    expect(logs.some((l) => l.includes("Sprint iteration 1/5"))).toBe(true);
    expect(logs.some((l) => l.includes("Iteration 1 passed"))).toBe(true);

    // NOT logged at normal (verbose only)
    expect(logs.some((l) => l.includes("Running verification"))).toBe(false);
  });
});

describe("VAL-CROSS-004: Sprint events propagate to OpenTUI adapter", () => {
  function createMockActions(): UIActions & { capturedBlocks: AnyBlock[][] } {
    const capturedBlocks: AnyBlock[][] = [];
    return {
      capturedBlocks,
      getState: () => ({} as WorkState),
      subscribe: () => () => {},
      addPhase: () => {},
      startPhase: () => {},
      completePhase: () => {},
      failPhase: () => {},
      skipPhase: () => {},
      addStage: () => {},
      startStage: () => {},
      completeStage: () => {},
      failStage: () => {},
      addPhaseToStage: () => {},
      startPhaseInStage: () => {},
      completePhaseInStage: () => {},
      failPhaseInStage: () => {},
      startWorkflow: () => {},
      continueStage: () => {},
      stopWorkflow: () => {},
      setError: () => {},
      clearError: () => {},
      appendOutput: () => {},
      setOutputBlocks: (blocks: AnyBlock[]) => {
        capturedBlocks.push([...blocks]);
      },
      appendOutputBlocks: () => {},
      setApprovalPending: () => {},
      clearApproval: () => {},
      selectNext: () => {},
      selectPrevious: () => {},
      selectPhase: () => {},
      reset: () => {},
    };
  }

  it("all 6 sprint events produce system blocks with sprint-specific formatting", async () => {
    const mockActions = createMockActions();
    const adapter = new OpenTUIAdapter({ actions: mockActions });

    const eventBus = new EventBus();
    adapter.connect(eventBus);
    adapter.start();

    const events = makeSprintEvents("test-wf-opentui");
    for (const event of events) {
      eventBus.emit(event);
    }

    // Allow flush interval to fire (OpenTUI batches at 16ms)
    await new Promise((resolve) => setTimeout(resolve, 50));
    adapter.stop();

    // Collect all system blocks from all captured block snapshots
    const allSystemMessages = mockActions.capturedBlocks
      .flat()
      .filter((b): b is AnyBlock & { kind: "system" } => b.kind === "system")
      .map((b) => (b as any).message as string);

    // sprint:started — emoji prefix 🏃
    expect(allSystemMessages.some((m) => m.includes("🏃") && m.includes("Sprint started"))).toBe(true);

    // sprint:iteration-started — ▸ prefix
    expect(allSystemMessages.some((m) => m.includes("▸") && m.includes("Sprint iteration 1/5"))).toBe(true);

    // sprint:verification-started — 🔍 prefix
    expect(allSystemMessages.some((m) => m.includes("🔍") && m.includes("Running verification"))).toBe(true);

    // sprint:iteration-completed — ✓ for passed
    expect(allSystemMessages.some((m) => m.includes("✓") && m.includes("Iteration 1 passed"))).toBe(true);

    // sprint:escalated — ⚠ prefix
    expect(allSystemMessages.some((m) => m.includes("⚠") && m.includes("Sprint escalating"))).toBe(true);

    // sprint:completed — ✓ for completed
    expect(allSystemMessages.some((m) => m.includes("✓") && m.includes("Sprint") && m.includes("completed"))).toBe(true);
  });
});

describe("VAL-CROSS-004: Sprint events propagate to MockAdapter", () => {
  it("all 6 sprint event types are recorded in events array", () => {
    const adapter = new MockAdapter();
    const eventBus = new EventBus();
    adapter.connect(eventBus);

    const events = makeSprintEvents("test-wf-mock");
    for (const event of events) {
      eventBus.emit(event);
    }

    const sprintEvents = adapter.events.filter((e) => e.type.startsWith("sprint:"));
    expect(sprintEvents).toHaveLength(6);

    const types = sprintEvents.map((e) => e.type);
    expect(types).toContain("sprint:started");
    expect(types).toContain("sprint:iteration-started");
    expect(types).toContain("sprint:verification-started");
    expect(types).toContain("sprint:iteration-completed");
    expect(types).toContain("sprint:escalated");
    expect(types).toContain("sprint:completed");
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-006: ContextIndexer feeds sprint worker
// ---------------------------------------------------------------------------

describe("VAL-CROSS-006: ContextIndexer feeds sprint worker", () => {
  function createMockContextIndexer(
    contextToReturn: AvailableContext,
  ): ContextIndexer & { capturedQueries: ContextQuery[] } {
    const capturedQueries: ContextQuery[] = [];
    return {
      capturedQueries,
      startIndexing: async () => {},
      getRelevantContext: (query: ContextQuery) => {
        capturedQueries.push(query);
        return contextToReturn;
      },
      dispose: () => {},
    } as unknown as ContextIndexer & { capturedQueries: ContextQuery[] };
  }

  it("getRelevantContext is called with workflowType 'sprint'", async () => {
    const mockContext: AvailableContext = {
      conventions: [{ name: "AGENTS.md", path: "AGENTS.md", summary: "Agent instructions" }],
      standards: [],
      learnings: [],
    };

    const mockIndexer = createMockContextIndexer(mockContext);
    const { executor, prompts } = promptCapturingExecutor([
      makeWorkerResult("/tmp/handoff.json"),
    ]);

    const opts = createTestOptions({
      executor,
      contextIndexer: mockIndexer,
      _readHandoff: async () => makeHandoff(),
      _runVerification: async () => passingVerification(),
    });

    const handle = createSprintLoop(opts);
    await handle.run();

    // Verify getRelevantContext was called
    expect(mockIndexer.capturedQueries.length).toBeGreaterThanOrEqual(1);

    // Verify it was called with workflowType: 'sprint'
    const sprintQuery = mockIndexer.capturedQueries.find(
      (q) => q.workflowType === "sprint",
    );
    expect(sprintQuery).toBeDefined();
    expect(sprintQuery!.workflowType).toBe("sprint");
  });

  it("returned context appears in the sprint phase prompt", async () => {
    const testConvention: ContextEntry = {
      name: "TEST_CONVENTION.md",
      path: "TEST_CONVENTION.md",
      summary: "Unique test convention for sprint context verification",
    };
    const testStandard: ContextEntry = {
      name: "Testing Standards",
      path: "docs/standards/testing.md",
      summary: "Standard testing patterns for the project",
    };
    const testLearning: ContextEntry = {
      name: "Sprint gotcha",
      path: "docs/solutions/sprint-gotcha.md",
      summary: "Learned something about sprint execution",
    };

    const mockContext: AvailableContext = {
      conventions: [testConvention],
      standards: [testStandard],
      learnings: [testLearning],
    };

    const mockIndexer = createMockContextIndexer(mockContext);
    const { executor, prompts } = promptCapturingExecutor([
      makeWorkerResult("/tmp/handoff.json"),
    ]);

    const opts = createTestOptions({
      executor,
      contextIndexer: mockIndexer,
      _readHandoff: async () => makeHandoff(),
      _runVerification: async () => passingVerification(),
    });

    const handle = createSprintLoop(opts);
    await handle.run();

    // Verify the prompt was captured
    expect(prompts.length).toBeGreaterThanOrEqual(1);
    const prompt = prompts[0];

    // The prompt should contain the context entries via buildProjectContextSection
    expect(prompt).toContain("TEST_CONVENTION.md");
    expect(prompt).toContain("Unique test convention for sprint context verification");
    expect(prompt).toContain("docs/standards/testing.md");
    expect(prompt).toContain("Standard testing patterns for the project");
    expect(prompt).toContain("docs/solutions/sprint-gotcha.md");
    expect(prompt).toContain("Learned something about sprint execution");
  });

  it("prompt contains Project Context section when indexer provides entries", async () => {
    const mockContext: AvailableContext = {
      conventions: [
        { name: "AGENTS.md", path: "AGENTS.md", summary: "Agent instructions" },
      ],
      standards: [
        { name: "Coding", path: "docs/standards/coding.md", summary: "Coding standards" },
      ],
      learnings: [],
    };

    const mockIndexer = createMockContextIndexer(mockContext);
    const { executor, prompts } = promptCapturingExecutor([
      makeWorkerResult("/tmp/handoff.json"),
    ]);

    const opts = createTestOptions({
      executor,
      contextIndexer: mockIndexer,
      _readHandoff: async () => makeHandoff(),
      _runVerification: async () => passingVerification(),
    });

    const handle = createSprintLoop(opts);
    await handle.run();

    const prompt = prompts[0];

    // Should have the Project Context section header
    expect(prompt).toContain("## Project Context");
    expect(prompt).toContain("### Conventions");
    expect(prompt).toContain("### Standards");
  });

  it("no context section when indexer is not provided", async () => {
    const { executor, prompts } = promptCapturingExecutor([
      makeWorkerResult("/tmp/handoff.json"),
    ]);

    const opts = createTestOptions({
      executor,
      // No contextIndexer provided
      _readHandoff: async () => makeHandoff(),
      _runVerification: async () => passingVerification(),
    });

    const handle = createSprintLoop(opts);
    await handle.run();

    const prompt = prompts[0];

    // Without an indexer, there should be no Project Context section
    expect(prompt).not.toContain("## Project Context");
  });
});

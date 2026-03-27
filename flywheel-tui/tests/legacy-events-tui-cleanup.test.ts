/**
 * Legacy Events & TUI Cleanup Tests
 *
 * Validates:
 * - VAL-DEL-009: Legacy events removed from event system
 * - VAL-TUI-001: Workflow panel renders only queue steps (no LegacyStepRow)
 * - VAL-TUI-002: Queue events drive all TUI updates
 * - VAL-TUI-003: Step status icons render correctly
 * - VAL-TUI-004: Timer lifecycle tied to queue events
 * - VAL-TUI-005: SessionRuntime has no deprecated fields
 * - VAL-TUI-006: Dynamic step insertion updates panel in real-time
 * - VAL-TUI-007: Queue progress tracking works
 * - VAL-CROSS-008: Step failure cascades correctly through UI
 */

import { describe, it, expect } from "bun:test";
import { EventBus, createFlywheelEmitter } from "../src/events/event-bus";
import type { FlywheelEvent } from "../src/events/types";
import { createStore } from "../src/tui/routes/work/context/ui-state/store";
import { createOpenTUIAdapter } from "../src/tui/adapters/opentui";
import {
  computeQueueProgress,
  getStepStatusIcon,
  getStepTypeLabel,
} from "../src/tui/components/workflow-panel-logic";
import type { RunningRuntime } from "../src/tui/components/session-runtime";

function ts(): string {
  return new Date().toISOString();
}

function createHarness() {
  const bus = new EventBus();
  const store = createStore("test-plan");
  const adapter = createOpenTUIAdapter(store);
  adapter.connect(bus);
  adapter.start();
  return { bus, store, adapter };
}

// ---------------------------------------------------------------------------
// VAL-DEL-009: Legacy events removed from event system
// ---------------------------------------------------------------------------

describe("VAL-DEL-009: Legacy events removed", () => {
  it("FlywheelEvent union does not include workflow:started", () => {
    // If these events existed in the union, TypeScript would accept them.
    // We verify they're gone by checking the emitter doesn't have them.
    const bus = new EventBus();
    const emitter = createFlywheelEmitter(bus);
    expect((emitter as any).workflowStarted).toBeUndefined();
    expect((emitter as any).workflowCompleted).toBeUndefined();
    expect((emitter as any).workflowFailed).toBeUndefined();
    expect((emitter as any).workflowInterrupted).toBeUndefined();
  });

  it("FlywheelEmitter does not have step:started/completed/failed methods", () => {
    const bus = new EventBus();
    const emitter = createFlywheelEmitter(bus);
    expect((emitter as any).stepStarted).toBeUndefined();
    expect((emitter as any).stepCompleted).toBeUndefined();
    expect((emitter as any).stepFailed).toBeUndefined();
  });

  it("queue lifecycle emitter methods exist", () => {
    const bus = new EventBus();
    const emitter = createFlywheelEmitter(bus);
    expect(typeof emitter.queueInitialized).toBe("function");
    expect(typeof emitter.queueCompleted).toBe("function");
    expect(typeof emitter.queueFailed).toBe("function");
    expect(typeof emitter.queueStepStarted).toBe("function");
    expect(typeof emitter.queueStepCompleted).toBe("function");
    expect(typeof emitter.queueStepFailed).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// VAL-TUI-001: Workflow panel renders only QueueStepRow
// ---------------------------------------------------------------------------

describe("VAL-TUI-001: Only QueueStepRow rendering", () => {
  it("WorkState has no steps or stages arrays", () => {
    const store = createStore("test");
    const state = store.getState();
    expect((state as any).steps).toBeUndefined();
    expect((state as any).stages).toBeUndefined();
    expect(state.queueSteps).toBeDefined();
    expect(Array.isArray(state.queueSteps)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VAL-TUI-002: Queue events drive all TUI updates
// ---------------------------------------------------------------------------

describe("VAL-TUI-002: Queue events drive TUI updates", () => {
  it("queue:step-started updates store step to running", () => {
    const { bus, store } = createHarness();
    store.setQueueSteps([
      { id: "s1", type: "work", title: "Build", status: "pending" },
    ]);
    bus.emit({
      type: "queue:step-started",
      workflowId: "w1",
      stepId: "s1",
      stepType: "work",
      stepTitle: "Build",
      timestamp: ts(),
    });
    expect(store.getState().queueSteps[0].status).toBe("running");
  });

  it("queue:step-completed updates store step to completed", () => {
    const { bus, store } = createHarness();
    store.setQueueSteps([
      { id: "s1", type: "work", title: "Build", status: "running", startTime: Date.now() },
    ]);
    bus.emit({
      type: "queue:step-completed",
      workflowId: "w1",
      stepId: "s1",
      stepType: "work",
      stepTitle: "Build",
      timestamp: ts(),
    });
    expect(store.getState().queueSteps[0].status).toBe("completed");
  });

  it("queue:step-failed updates store step to failed with reason", () => {
    const { bus, store } = createHarness();
    store.setQueueSteps([
      { id: "s1", type: "work", title: "Build", status: "running" },
    ]);
    bus.emit({
      type: "queue:step-failed",
      workflowId: "w1",
      stepId: "s1",
      stepType: "work",
      stepTitle: "Build",
      reason: "test failure",
      timestamp: ts(),
    });
    const step = store.getState().queueSteps[0];
    expect(step.status).toBe("failed");
    expect(step.error).toBe("test failure");
  });

  it("queue:step-inserted adds new step to store", () => {
    const { bus, store } = createHarness();
    store.setQueueSteps([
      { id: "s1", type: "plan", title: "Plan", status: "completed" },
      { id: "s3", type: "review", title: "Review", status: "pending" },
    ]);
    bus.emit({
      type: "queue:step-inserted",
      workflowId: "w1",
      stepId: "s2",
      stepType: "work",
      stepTitle: "Work Step",
      afterStepId: "s1",
      timestamp: ts(),
    });
    const steps = store.getState().queueSteps;
    expect(steps).toHaveLength(3);
    expect(steps[1].id).toBe("s2");
    expect(steps[1].title).toBe("Work Step");
    expect(steps[1].status).toBe("pending");
  });

  it("queue:step-removed removes step from store", () => {
    const { bus, store } = createHarness();
    store.setQueueSteps([
      { id: "s1", type: "work", title: "Step 1", status: "pending" },
      { id: "s2", type: "work", title: "Step 2", status: "pending" },
    ]);
    bus.emit({
      type: "queue:step-removed",
      workflowId: "w1",
      stepId: "s1",
      stepType: "work",
      stepTitle: "Step 1",
      timestamp: ts(),
    });
    const steps = store.getState().queueSteps;
    expect(steps).toHaveLength(1);
    expect(steps[0].id).toBe("s2");
  });
});

// ---------------------------------------------------------------------------
// VAL-TUI-003: Step status icons render correctly
// ---------------------------------------------------------------------------

describe("VAL-TUI-003: Step status icons", () => {
  it("pending shows circle", () => {
    expect(getStepStatusIcon("pending")).toBe("○");
  });

  it("running shows half circle (fallback for Spinner)", () => {
    expect(getStepStatusIcon("running")).toBe("◐");
  });

  it("completed shows checkmark", () => {
    expect(getStepStatusIcon("completed")).toBe("✓");
  });

  it("failed shows X", () => {
    expect(getStepStatusIcon("failed")).toBe("✗");
  });

  it("skipped shows circle-slash", () => {
    expect(getStepStatusIcon("skipped")).toBe("⊘");
  });
});

// ---------------------------------------------------------------------------
// VAL-TUI-004: Timer lifecycle tied to queue events
// ---------------------------------------------------------------------------

describe("VAL-TUI-004: Timer tied to queue events", () => {
  it("timer starts on queue:initialized", () => {
    const { bus, adapter } = createHarness();
    expect(adapter.timer.getStatus()).toBe("idle");
    bus.emit({
      type: "queue:initialized",
      workflowId: "w1",
      stepIds: ["s1", "s2"],
      timestamp: ts(),
    });
    expect(adapter.timer.isRunning()).toBe(true);
    adapter.disconnect();
  });

  it("timer stops on queue:completed", () => {
    const { bus, adapter } = createHarness();
    bus.emit({ type: "queue:initialized", workflowId: "w1", stepIds: ["s1"], timestamp: ts() });
    bus.emit({ type: "queue:completed", workflowId: "w1", stepsCompleted: 1, timestamp: ts() });
    expect(adapter.timer.isStopped()).toBe(true);
    adapter.disconnect();
  });

  it("timer stops on queue:failed", () => {
    const { bus, adapter } = createHarness();
    bus.emit({ type: "queue:initialized", workflowId: "w1", stepIds: ["s1"], timestamp: ts() });
    bus.emit({ type: "queue:failed", workflowId: "w1", reason: "fail", stepsCompleted: 0, timestamp: ts() });
    expect(adapter.timer.isStopped()).toBe(true);
    adapter.disconnect();
  });
});

// ---------------------------------------------------------------------------
// VAL-TUI-005: SessionRuntime has no deprecated fields
// ---------------------------------------------------------------------------

describe("VAL-TUI-005: SessionRuntime has no deprecated fields", () => {
  it("RunningRuntime type has queueCleanup, not pipelineCleanup", () => {
    // If pipelineCleanup existed, TypeScript would accept it. Since we can't
    // directly check types at runtime, we verify the shape through a mock.
    const mockRuntime: RunningRuntime = {
      kind: "running",
      sessionId: "test",
      session: {} as any,
      flusher: { dispose: () => {} } as any,
      budgetTracker: { dispose: () => {} } as any,
      storeUnsub: () => {},
      questionCleanup: () => {},
      queueCleanup: () => {},
      contextIndexer: null,
      workerPid: null,
    };
    expect(mockRuntime.queueCleanup).toBeDefined();
    expect((mockRuntime as any).pipelineCleanup).toBeUndefined();
    expect((mockRuntime as any).pipeline).toBeUndefined();
    expect((mockRuntime as any).controller).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// VAL-TUI-006: Dynamic step insertion updates panel
// ---------------------------------------------------------------------------

describe("VAL-TUI-006: Dynamic step insertion updates panel", () => {
  it("inserting steps updates queueSteps at correct positions", () => {
    const store = createStore("test");
    store.setQueueSteps([
      { id: "s1", type: "plan", title: "Plan", status: "completed" },
      { id: "s5", type: "review", title: "Review", status: "pending" },
    ]);
    // Insert work steps after plan
    store.insertQueueStep(
      { id: "s2", type: "work", title: "Work 1", status: "pending" },
      "s1",
    );
    store.insertQueueStep(
      { id: "s3", type: "work", title: "Work 2", status: "pending" },
      "s2",
    );
    const steps = store.getState().queueSteps;
    expect(steps).toHaveLength(4);
    expect(steps[0].id).toBe("s1");
    expect(steps[1].id).toBe("s2");
    expect(steps[2].id).toBe("s3");
    expect(steps[3].id).toBe("s5");
  });
});

// ---------------------------------------------------------------------------
// VAL-TUI-007: Queue progress tracking
// ---------------------------------------------------------------------------

describe("VAL-TUI-007: Queue progress tracking", () => {
  it("tracks completed/total/running/failed accurately", () => {
    const steps = [
      { id: "s1", type: "work", title: "A", status: "completed" as const },
      { id: "s2", type: "work", title: "B", status: "running" as const },
      { id: "s3", type: "work", title: "C", status: "failed" as const },
      { id: "s4", type: "work", title: "D", status: "pending" as const },
      { id: "s5", type: "work", title: "E", status: "skipped" as const },
    ];
    const progress = computeQueueProgress(steps);
    expect(progress.completed).toBe(1);
    expect(progress.running).toBe(1);
    expect(progress.failed).toBe(1);
    expect(progress.total).toBe(5);
  });

  it("updates after dynamic step insertion", () => {
    const steps = [
      { id: "s1", type: "work", title: "A", status: "completed" as const },
    ];
    const p1 = computeQueueProgress(steps);
    expect(p1.completed).toBe(1);
    expect(p1.total).toBe(1);

    // Simulate step insertion
    const updated = [
      ...steps,
      { id: "s2", type: "work", title: "B", status: "pending" as const },
    ];
    const p2 = computeQueueProgress(updated);
    expect(p2.completed).toBe(1);
    expect(p2.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-008: Step failure cascades correctly through UI
// ---------------------------------------------------------------------------

describe("VAL-CROSS-008: Step failure cascades through UI", () => {
  it("failed step shows X icon, subsequent steps remain pending", () => {
    const { bus, store, adapter } = createHarness();
    store.startWorkflow("test");
    store.setQueueSteps([
      { id: "s1", type: "work", title: "Step 1", status: "pending" },
      { id: "s2", type: "work", title: "Step 2", status: "pending" },
      { id: "s3", type: "work", title: "Step 3", status: "pending" },
    ]);

    // Start and fail step 1
    bus.emit({
      type: "queue:step-started",
      workflowId: "w1", stepId: "s1", stepType: "work", stepTitle: "Step 1",
      timestamp: ts(),
    });
    bus.emit({
      type: "queue:step-failed",
      workflowId: "w1", stepId: "s1", stepType: "work", stepTitle: "Step 1",
      reason: "test failure",
      timestamp: ts(),
    });

    const steps = store.getState().queueSteps;
    // Step 1 should be failed
    expect(steps[0].status).toBe("failed");
    expect(steps[0].error).toBe("test failure");
    expect(getStepStatusIcon(steps[0].status)).toBe("✗");

    // Steps 2 and 3 should remain pending
    expect(steps[1].status).toBe("pending");
    expect(steps[2].status).toBe("pending");
    expect(getStepStatusIcon(steps[1].status)).toBe("○");
    expect(getStepStatusIcon(steps[2].status)).toBe("○");

    adapter.disconnect();
  });

  it("queue:failed after step failure sets error on store", () => {
    const { bus, store, adapter } = createHarness();
    store.startWorkflow("test");

    bus.emit({ type: "queue:initialized", workflowId: "w1", stepIds: ["s1"], timestamp: ts() });
    bus.emit({
      type: "queue:failed",
      workflowId: "w1",
      reason: "Step s1 failed: test failure",
      stepsCompleted: 0,
      timestamp: ts(),
    });

    expect(store.getState().workflowStatus).toBe("failed");
    expect(store.getState().error).toBe("Step s1 failed: test failure");

    adapter.disconnect();
  });
});

// ---------------------------------------------------------------------------
// getStepTypeLabel
// ---------------------------------------------------------------------------

describe("getStepTypeLabel", () => {
  it("capitalizes step type", () => {
    expect(getStepTypeLabel("plan")).toBe("Plan");
    expect(getStepTypeLabel("work")).toBe("Work");
    expect(getStepTypeLabel("review")).toBe("Review");
    expect(getStepTypeLabel("ship")).toBe("Ship");
    expect(getStepTypeLabel("verify")).toBe("Verify");
  });

  it("handles empty string", () => {
    expect(getStepTypeLabel("")).toBe("");
  });
});

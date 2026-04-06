import { describe, it, expect } from "bun:test";
import { EventBus } from "../src/infra/event-bus";
import { createFlywheelEmitter } from "../src/infra/event-bus";
import { createStore } from "../src/tui/routes/work/context/ui-state/store";
import { computeQueueProgress } from "../src/tui/components/workflow-panel-logic";
import type { QueueStepState } from "../src/tui/types";

// ---------------------------------------------------------------------------
// Queue panel reactivity — verifies that queue step state propagates
// correctly through both the store chain and the direct signal path.
//
// The fix introduces a dedicated signal (shellQueueSteps) updated directly
// from event bus subscriptions, bypassing the store → workState chain that
// can break SolidJS fine-grained reactivity at runtime.
// ---------------------------------------------------------------------------

describe("queue panel reactivity — store chain propagation", () => {
  const makeSteps = (): QueueStepState[] => [
    { id: "s1", type: "plan", title: "Plan step", status: "pending" },
    { id: "s2", type: "work", title: "Work step", status: "pending" },
    { id: "s3", type: "review", title: "Review step", status: "pending" },
  ];

  it("store subscriber sees queueSteps changes immediately (notifyImmediate)", () => {
    const store = createStore("test");
    const states: QueueStepState[][] = [];

    // Subscribe before setting queue steps (mimics shell's subscribeToStore)
    store.subscribe(() => {
      states.push([...store.getState().queueSteps]);
    });

    // Set queue steps — uses notifyImmediate in the store
    store.setQueueSteps(makeSteps());

    // Subscriber should have been called with the 3 steps
    expect(states.length).toBeGreaterThanOrEqual(1);
    const latest = states[states.length - 1];
    expect(latest.length).toBe(3);
    expect(latest[0].id).toBe("s1");
    expect(latest[0].status).toBe("pending");
  });

  it("store subscriber sees step status transitions via notifyImmediate", () => {
    const store = createStore("test");
    const statuses: string[] = [];

    store.setQueueSteps(makeSteps());

    store.subscribe(() => {
      const steps = store.getState().queueSteps;
      const s1 = steps.find((s) => s.id === "s1");
      if (s1) statuses.push(s1.status);
    });

    store.startQueueStep("s1"); // notifyImmediate

    expect(statuses).toContain("running");
  });

  it("store subscriber sees step insertion (throttled notify)", async () => {
    const store = createStore("test");
    let stepCount = 0;

    store.setQueueSteps(makeSteps());

    store.subscribe(() => {
      stepCount = store.getState().queueSteps.length;
    });

    store.insertQueueStep(
      { id: "s4", type: "verify", title: "Verify", status: "pending" },
      "s2",
    );

    // insertQueueStep uses notify() (16ms throttle), not notifyImmediate.
    // The state is updated immediately, but the listener fires after the throttle.
    // Verify state is updated directly:
    expect(store.getState().queueSteps.length).toBe(4);

    // Wait for throttled notification
    await new Promise((r) => setTimeout(r, 20));
    expect(stepCount).toBe(4);
  });

  it("store creates new state object on each mutation (reference equality)", () => {
    const store = createStore("test");
    const stateRefs: object[] = [];

    store.subscribe(() => {
      stateRefs.push(store.getState());
    });

    store.setQueueSteps(makeSteps());
    const ref1 = stateRefs[stateRefs.length - 1];

    store.startQueueStep("s1");
    const ref2 = stateRefs[stateRefs.length - 1];

    // Different references — SolidJS signal should trigger
    expect(ref1).not.toBe(ref2);
  });
});

describe("queue panel reactivity — event bus → direct signal updates", () => {
  const makeSteps = (): QueueStepState[] => [
    { id: "s1", type: "plan", title: "Plan step", status: "pending" },
    { id: "s2", type: "work", title: "Work step", status: "pending" },
    { id: "s3", type: "review", title: "Review step", status: "pending" },
  ];

  /**
   * Simulates the shell's direct signal update pattern:
   * event bus subscription → setShellQueueSteps(updater)
   *
   * Instead of SolidJS signals (which need browser conditions), we
   * simulate the updater pattern with a simple variable + callback.
   */
  function createMockSignal(initial: QueueStepState[]) {
    let value = initial;
    const set = (updater: QueueStepState[] | ((prev: QueueStepState[]) => QueueStepState[])) => {
      if (typeof updater === "function") {
        value = updater(value);
      } else {
        value = updater;
      }
    };
    const get = () => value;
    return { get, set };
  }

  it("queue:step-started updates step status to running", () => {
    const bus = new EventBus();
    const signal = createMockSignal(makeSteps());

    bus.subscribeToType("queue:step-started", (e) => {
      signal.set((prev) =>
        prev.map((s) =>
          s.id === e.stepId
            ? { ...s, status: "running" as const, startTime: Date.now() }
            : s,
        ),
      );
    });

    bus.emit({
      type: "queue:step-started",
      workflowId: "test",
      stepId: "s1",
      stepType: "plan",
      stepTitle: "Plan step",
      timestamp: Date.now(),
    });

    const s1 = signal.get().find((s) => s.id === "s1");
    expect(s1?.status).toBe("running");
    expect(s1?.startTime).toBeGreaterThan(0);
    // Other steps unchanged
    expect(signal.get().find((s) => s.id === "s2")?.status).toBe("pending");
  });

  it("queue:step-completed updates step status to completed with duration", () => {
    const bus = new EventBus();
    const steps = makeSteps();
    steps[0].status = "running";
    steps[0].startTime = Date.now() - 5000;
    const signal = createMockSignal(steps);

    bus.subscribeToType("queue:step-completed", (e) => {
      signal.set((prev) =>
        prev.map((s) => {
          if (s.id !== e.stepId) return s;
          const now = Date.now();
          const duration = s.startTime ? (now - s.startTime) / 1000 : 0;
          return { ...s, status: "completed" as const, endTime: now, duration };
        }),
      );
    });

    bus.emit({
      type: "queue:step-completed",
      workflowId: "test",
      stepId: "s1",
      stepType: "plan",
      stepTitle: "Plan step",
      timestamp: Date.now(),
    });

    const s1 = signal.get().find((s) => s.id === "s1");
    expect(s1?.status).toBe("completed");
    expect(s1?.endTime).toBeGreaterThan(0);
    expect(s1?.duration).toBeGreaterThanOrEqual(4); // ~5s from startTime
  });

  it("queue:step-failed updates step status to failed with error", () => {
    const bus = new EventBus();
    const steps = makeSteps();
    steps[0].status = "running";
    const signal = createMockSignal(steps);

    bus.subscribeToType("queue:step-failed", (e) => {
      signal.set((prev) =>
        prev.map((s) => {
          if (s.id !== e.stepId) return s;
          const now = Date.now();
          return { ...s, status: "failed" as const, endTime: now, error: e.reason };
        }),
      );
    });

    bus.emit({
      type: "queue:step-failed",
      workflowId: "test",
      stepId: "s1",
      stepType: "plan",
      stepTitle: "Plan step",
      reason: "worker crashed",
      timestamp: Date.now(),
    });

    const s1 = signal.get().find((s) => s.id === "s1");
    expect(s1?.status).toBe("failed");
    expect(s1?.error).toBe("worker crashed");
  });

  it("queue:step-inserted adds step at correct position", () => {
    const bus = new EventBus();
    const signal = createMockSignal(makeSteps());

    bus.subscribeToType("queue:step-inserted", (e) => {
      signal.set((prev) => {
        const idx = prev.findIndex((s) => s.id === e.afterStepId);
        const insertIdx = idx >= 0 ? idx + 1 : prev.length;
        const newStep: QueueStepState = {
          id: e.stepId,
          type: e.stepType,
          title: e.stepTitle,
          status: "pending",
        };
        return [...prev.slice(0, insertIdx), newStep, ...prev.slice(insertIdx)];
      });
    });

    bus.emit({
      type: "queue:step-inserted",
      workflowId: "test",
      stepId: "s4",
      stepType: "verify",
      stepTitle: "Verify",
      afterStepId: "s2",
      timestamp: Date.now(),
    });

    const ids = signal.get().map((s) => s.id);
    expect(ids).toEqual(["s1", "s2", "s4", "s3"]);
    expect(signal.get().find((s) => s.id === "s4")?.status).toBe("pending");
  });

  it("queue:step-removed removes step by id", () => {
    const bus = new EventBus();
    const signal = createMockSignal(makeSteps());

    bus.subscribeToType("queue:step-removed", (e) => {
      signal.set((prev) => prev.filter((s) => s.id !== e.stepId));
    });

    bus.emit({
      type: "queue:step-removed",
      workflowId: "test",
      stepId: "s2",
      stepType: "work",
      stepTitle: "Work step",
      timestamp: Date.now(),
    });

    const ids = signal.get().map((s) => s.id);
    expect(ids).toEqual(["s1", "s3"]);
  });

  it("progress summary updates after each event", () => {
    const bus = new EventBus();
    const signal = createMockSignal(makeSteps());

    // Wire all event handlers
    bus.subscribeToType("queue:step-started", (e) => {
      signal.set((prev) =>
        prev.map((s) =>
          s.id === e.stepId
            ? { ...s, status: "running" as const, startTime: Date.now() }
            : s,
        ),
      );
    });
    bus.subscribeToType("queue:step-completed", (e) => {
      signal.set((prev) =>
        prev.map((s) => {
          if (s.id !== e.stepId) return s;
          const now = Date.now();
          return { ...s, status: "completed" as const, endTime: now, duration: 1 };
        }),
      );
    });

    // Initial: 0/3
    let progress = computeQueueProgress(signal.get());
    expect(progress.completed).toBe(0);
    expect(progress.total).toBe(3);

    // Start s1: running=1, completed=0
    bus.emit({ type: "queue:step-started", workflowId: "test", stepId: "s1", stepType: "plan", stepTitle: "Plan", timestamp: Date.now() });
    progress = computeQueueProgress(signal.get());
    expect(progress.running).toBe(1);
    expect(progress.completed).toBe(0);
    expect(progress.total).toBe(3);

    // Complete s1: running=0, completed=1
    bus.emit({ type: "queue:step-completed", workflowId: "test", stepId: "s1", stepType: "plan", stepTitle: "Plan", timestamp: Date.now() });
    progress = computeQueueProgress(signal.get());
    expect(progress.running).toBe(0);
    expect(progress.completed).toBe(1);
    expect(progress.total).toBe(3);

    // Start s2: running=1, completed=1
    bus.emit({ type: "queue:step-started", workflowId: "test", stepId: "s2", stepType: "work", stepTitle: "Work", timestamp: Date.now() });
    progress = computeQueueProgress(signal.get());
    expect(progress.running).toBe(1);
    expect(progress.completed).toBe(1);
    expect(progress.total).toBe(3);

    // Complete s2: running=0, completed=2
    bus.emit({ type: "queue:step-completed", workflowId: "test", stepId: "s2", stepType: "work", stepTitle: "Work", timestamp: Date.now() });
    progress = computeQueueProgress(signal.get());
    expect(progress.completed).toBe(2);
    expect(progress.total).toBe(3);
  });
});

describe("queue panel reactivity — WorkflowPanel queueSteps override", () => {
  it("computeQueueProgress uses override steps when provided", () => {
    // Simulates the WorkflowPanel's behavior:
    // const queueSteps = () => props.queueSteps ?? props.state.queueSteps
    const storeSteps: QueueStepState[] = []; // store has empty queueSteps
    const overrideSteps: QueueStepState[] = [
      { id: "s1", type: "plan", title: "Plan", status: "completed" },
      { id: "s2", type: "work", title: "Work", status: "running" },
      { id: "s3", type: "review", title: "Review", status: "pending" },
    ];

    // Without override: uses store steps (empty)
    const storeProgress = computeQueueProgress(storeSteps);
    expect(storeProgress.total).toBe(0);

    // With override: uses override steps
    const overrideProgress = computeQueueProgress(overrideSteps);
    expect(overrideProgress.total).toBe(3);
    expect(overrideProgress.completed).toBe(1);
    expect(overrideProgress.running).toBe(1);
  });

  it("override fallback chain: non-empty override wins over state", () => {
    const stateQueueSteps: QueueStepState[] = [
      { id: "s1", type: "plan", title: "From store", status: "pending" },
    ];

    // When override is undefined, falls back to state
    const resolve = (override: QueueStepState[] | undefined, state: QueueStepState[]) =>
      (override && override.length > 0) ? override : state;

    const queueSteps1 = resolve(undefined, stateQueueSteps);
    expect(queueSteps1).toBe(stateQueueSteps);
    expect(queueSteps1[0].title).toBe("From store");

    // When override is provided and non-empty, uses it
    const overrideSteps: QueueStepState[] = [
      { id: "s1", type: "plan", title: "From signal", status: "running" },
    ];
    const queueSteps2 = resolve(overrideSteps, stateQueueSteps);
    expect(queueSteps2).toBe(overrideSteps);
    expect(queueSteps2[0].title).toBe("From signal");
    expect(queueSteps2[0].status).toBe("running");
  });

  it("empty override array falls through to state (historical session fix)", () => {
    const stateQueueSteps: QueueStepState[] = [
      { id: "s1", type: "plan", title: "From store", status: "completed" },
      { id: "s2", type: "work", title: "From store", status: "completed" },
    ];
    const overrideSteps: QueueStepState[] = [];

    // After the fix: empty array falls through to store's steps
    const resolve = (override: QueueStepState[] | undefined, state: QueueStepState[]) =>
      (override && override.length > 0) ? override : state;

    const queueSteps = resolve(overrideSteps, stateQueueSteps);
    expect(queueSteps).toBe(stateQueueSteps);
    expect(queueSteps.length).toBe(2);
  });
});

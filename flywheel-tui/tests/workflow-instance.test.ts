import { describe, it, expect } from "bun:test";
import {
  mapLifecycleToStatus,
  buildWorkflowInstance,
  type WorkflowInstanceStatus,
} from "../src/tui/session/workflow-instance";
import type { SessionRuntime, RunningRuntime } from "../src/tui/session/session-runtime";
import type { SessionSummary } from "../src/session/manager";
import type { SessionLifecycleState } from "../src/session/state-machine";

// ---------------------------------------------------------------------------
// mapLifecycleToStatus — all 12 states
// ---------------------------------------------------------------------------

describe("mapLifecycleToStatus", () => {
  const cases: [SessionLifecycleState, WorkflowInstanceStatus][] = [
    ["new", "pending"],
    ["plan:draft", "pending"],
    ["plan:imported", "pending"],
    ["plan:approved", "pending"],
    ["plan:needs-fix", "pending"],
    ["work:active", "running"],
    ["work:review", "running"],
    ["work:paused", "paused"],
    ["budget_exhausted", "budget_exhausted"],
    ["completed", "completed"],
    ["archived", "completed"],
    ["trashed", "failed"],
  ];

  for (const [lifecycle, expected] of cases) {
    it(`maps "${lifecycle}" → "${expected}"`, () => {
      expect(mapLifecycleToStatus(lifecycle)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// buildWorkflowInstance
// ---------------------------------------------------------------------------

describe("buildWorkflowInstance", () => {
  const makeSummary = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
    id: "sess-1",
    name: "test-session",
    label: "Test Session",
    lifecycleState: "work:active",
    totalCost: 0,
    lastUpdated: new Date().toISOString(),
    planPath: "/plans/test.md",
    ...overrides,
  });

  const makePendingRuntime = (sessionId: string): SessionRuntime => ({
    kind: "pending",
    sessionId,
    session: { planPath: "/runtime/plan.md" } as any,
  });

  const makeRunningRuntime = (sessionId: string, workerPid: number | null = 1234): SessionRuntime => ({
    kind: "running",
    sessionId,
    session: { planPath: "/runtime/plan.md" } as any,
    controller: {} as any,
    loop: {} as any,
    
    flusher: {} as any,
    budgetTracker: {} as any,
    storeUnsub: () => {},
    questionCleanup: () => {},
    queueCleanup: () => {},
    contextIndexer: null,
    workerPid,
  } as RunningRuntime);

  it("returns correct shape with persisted + running runtime", () => {
    const runtime = makeRunningRuntime("sess-1", 5678);
    const persisted = makeSummary({ lifecycleState: "work:active" });

    const instance = buildWorkflowInstance("sess-1", runtime, persisted);

    expect(instance.session_id).toBe("sess-1");
    expect(instance.status).toBe("running");
    expect(instance.plan_path).toBe("/plans/test.md");
    expect(instance.current_step).toBe("work");
    expect(instance.worker_pid).toBe(5678);
  });

  it("derives status from persisted lifecycleState when available", () => {
    const runtime = makePendingRuntime("sess-1");
    const persisted = makeSummary({ lifecycleState: "completed" });

    const instance = buildWorkflowInstance("sess-1", runtime, persisted);

    expect(instance.status).toBe("completed");
  });

  it("falls back to runtime kind when no persisted data", () => {
    const runtime = makeRunningRuntime("sess-1");
    const instance = buildWorkflowInstance("sess-1", runtime, null);

    expect(instance.status).toBe("running");
  });

  it("returns 'pending' when no persisted data and runtime is pending", () => {
    const runtime = makePendingRuntime("sess-1");
    const instance = buildWorkflowInstance("sess-1", runtime, null);

    expect(instance.status).toBe("pending");
  });

  it("returns 'pending' when no runtime and no persisted data", () => {
    const instance = buildWorkflowInstance("sess-1", undefined, null);

    expect(instance.status).toBe("pending");
  });

  it("uses persisted planPath over runtime planPath", () => {
    const runtime = makeRunningRuntime("sess-1");
    const persisted = makeSummary({ planPath: "/persisted/plan.md" });

    const instance = buildWorkflowInstance("sess-1", runtime, persisted);

    expect(instance.plan_path).toBe("/persisted/plan.md");
  });

  it("falls back to runtime session planPath when persisted has none", () => {
    const runtime = makeRunningRuntime("sess-1");
    const persisted = makeSummary({ planPath: undefined });

    const instance = buildWorkflowInstance("sess-1", runtime, persisted);

    expect(instance.plan_path).toBe("/runtime/plan.md");
  });

  it("returns null plan_path when neither persisted nor runtime has one", () => {
    const instance = buildWorkflowInstance("sess-1", undefined, null);

    expect(instance.plan_path).toBeNull();
  });

  it("returns current_step 'work' for running runtime", () => {
    const runtime = makeRunningRuntime("sess-1");
    const instance = buildWorkflowInstance("sess-1", runtime, null);

    expect(instance.current_step).toBe("work");
  });

  it("returns null current_step for pending runtime", () => {
    const runtime = makePendingRuntime("sess-1");
    const instance = buildWorkflowInstance("sess-1", runtime, null);

    expect(instance.current_step).toBeNull();
  });

  it("returns null worker_pid for pending runtime", () => {
    const runtime = makePendingRuntime("sess-1");
    const instance = buildWorkflowInstance("sess-1", runtime, null);

    expect(instance.worker_pid).toBeNull();
  });

  it("returns worker_pid from running runtime", () => {
    const runtime = makeRunningRuntime("sess-1", 9999);
    const instance = buildWorkflowInstance("sess-1", runtime, null);

    expect(instance.worker_pid).toBe(9999);
  });

  it("returns null worker_pid when running runtime has null pid", () => {
    const runtime = makeRunningRuntime("sess-1", null);
    const instance = buildWorkflowInstance("sess-1", runtime, null);

    expect(instance.worker_pid).toBeNull();
  });
});

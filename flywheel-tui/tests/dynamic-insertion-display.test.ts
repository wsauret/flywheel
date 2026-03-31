import { describe, it, expect } from "bun:test";
import { createStore } from "../src/tui/routes/work/context/ui-state/store";
import {
  computeQueueProgress,
  getStepStatusIcon,
} from "../src/tui/components/workflow-panel-logic";
import {
  layoutVisibility,
  MIN_WIDTH_PANEL,
} from "../src/tui/shell/shell-modes";
import type { QueueStepState } from "../src/tui/routes/work/state/types";

// ---------------------------------------------------------------------------
// VAL-TUI-006: Dynamically inserted step appears at correct position
// ---------------------------------------------------------------------------

describe("VAL-TUI-006: dynamic step insertion", () => {
  const makeInitialSteps = (): QueueStepState[] => [
    { id: "step-1", type: "plan", title: "Create Plan", status: "completed" },
    { id: "step-2", type: "work", title: "Implement Feature", status: "running", startTime: Date.now() },
    { id: "step-3", type: "review", title: "Code Review", status: "pending" },
  ];

  it("dynamically inserted step appears at correct position after a completed step", () => {
    const store = createStore("test");
    store.setQueueSteps(makeInitialSteps());

    // Insert a verification step after the completed plan step
    const inserted: QueueStepState = {
      id: "step-new",
      type: "verify",
      title: "Verify Plan Output",
      status: "pending",
    };
    store.insertQueueStep(inserted, "step-1");

    const ids = store.getState().queueSteps.map((s) => s.id);
    expect(ids).toEqual(["step-1", "step-new", "step-2", "step-3"]);
  });

  it("dynamically inserted step appears at correct position after the running step", () => {
    const store = createStore("test");
    store.setQueueSteps(makeInitialSteps());

    // Insert a retry step after the running work step (sprint retry scenario)
    const inserted: QueueStepState = {
      id: "step-retry",
      type: "work",
      title: "Retry: Implement Feature",
      status: "pending",
    };
    store.insertQueueStep(inserted, "step-2");

    const ids = store.getState().queueSteps.map((s) => s.id);
    expect(ids).toEqual(["step-1", "step-2", "step-retry", "step-3"]);
  });

  it("dynamically inserted step appears at correct position before the last step", () => {
    const store = createStore("test");
    store.setQueueSteps(makeInitialSteps());

    // Insert an escalation step before review (after work step)
    const inserted: QueueStepState = {
      id: "step-esc",
      type: "plan",
      title: "Escalation: Replan",
      status: "pending",
    };
    store.insertQueueStep(inserted, "step-2");

    const ids = store.getState().queueSteps.map((s) => s.id);
    expect(ids).toEqual(["step-1", "step-2", "step-esc", "step-3"]);
  });

  it("step count updates after single insertion", () => {
    const store = createStore("test");
    store.setQueueSteps(makeInitialSteps());

    const progressBefore = computeQueueProgress(store.getState().queueSteps);
    expect(progressBefore.total).toBe(3);

    const inserted: QueueStepState = {
      id: "step-new",
      type: "verify",
      title: "Verify",
      status: "pending",
    };
    store.insertQueueStep(inserted, "step-2");

    const progressAfter = computeQueueProgress(store.getState().queueSteps);
    expect(progressAfter.total).toBe(4);
    expect(progressAfter.completed).toBe(1); // step-1 still completed
    expect(progressAfter.running).toBe(1);   // step-2 still running
  });

  it("step count updates after multiple insertions (sprint retry pair)", () => {
    const store = createStore("test");
    store.setQueueSteps(makeInitialSteps());

    // Simulate sprint retry: insert work+verify pair after current step
    const work: QueueStepState = {
      id: "step-retry-work",
      type: "work",
      title: "Sprint Retry: Work",
      status: "pending",
    };
    const verify: QueueStepState = {
      id: "step-retry-verify",
      type: "verify",
      title: "Sprint Retry: Verify",
      status: "pending",
    };

    // Insert verify first, then work before it (to maintain order: work, verify)
    store.insertQueueStep(work, "step-2");
    store.insertQueueStep(verify, "step-retry-work");

    const progress = computeQueueProgress(store.getState().queueSteps);
    expect(progress.total).toBe(5); // original 3 + 2 inserted
    expect(progress.completed).toBe(1);
    expect(progress.running).toBe(1);

    // Verify order: plan, work(running), retry-work, retry-verify, review
    const ids = store.getState().queueSteps.map((s) => s.id);
    expect(ids).toEqual(["step-1", "step-2", "step-retry-work", "step-retry-verify", "step-3"]);
  });

  it("step count updates after escalation insertion (plan→work→review)", () => {
    const store = createStore("test");

    // Sprint scenario: initial [work, verify] — both done/failed
    const sprintSteps: QueueStepState[] = [
      { id: "s1", type: "work", title: "Sprint Work", status: "completed" },
      { id: "s2", type: "verify", title: "Sprint Verify", status: "failed", error: "tests failed" },
    ];
    store.setQueueSteps(sprintSteps);

    const before = computeQueueProgress(store.getState().queueSteps);
    expect(before.total).toBe(2);
    expect(before.completed).toBe(1);
    expect(before.failed).toBe(1);

    // Escalation: insert plan, work, review after the failed verify
    const escalationPlan: QueueStepState = { id: "esc-plan", type: "plan", title: "Escalation Plan", status: "pending" };
    const escalationWork: QueueStepState = { id: "esc-work", type: "work", title: "Escalation Work", status: "pending" };
    const escalationReview: QueueStepState = { id: "esc-review", type: "review", title: "Escalation Review", status: "pending" };

    store.insertQueueStep(escalationPlan, "s2");
    store.insertQueueStep(escalationWork, "esc-plan");
    store.insertQueueStep(escalationReview, "esc-work");

    const after = computeQueueProgress(store.getState().queueSteps);
    expect(after.total).toBe(5); // 2 original + 3 escalation
    expect(after.completed).toBe(1);
    expect(after.failed).toBe(1);

    const ids = store.getState().queueSteps.map((s) => s.id);
    expect(ids).toEqual(["s1", "s2", "esc-plan", "esc-work", "esc-review"]);
  });

  it("inserted step has correct status and type in the store", () => {
    const store = createStore("test");
    store.setQueueSteps(makeInitialSteps());

    const inserted: QueueStepState = {
      id: "step-new",
      type: "verify",
      title: "Verify Output",
      status: "pending",
    };
    store.insertQueueStep(inserted, "step-1");

    const step = store.getState().queueSteps.find((s) => s.id === "step-new");
    expect(step).toBeDefined();
    expect(step!.type).toBe("verify");
    expect(step!.title).toBe("Verify Output");
    expect(step!.status).toBe("pending");
    expect(step!.error).toBeUndefined();
  });

  it("inserted step can subsequently transition through lifecycle", () => {
    const store = createStore("test");
    store.setQueueSteps(makeInitialSteps());

    const inserted: QueueStepState = {
      id: "step-new",
      type: "verify",
      title: "Verify",
      status: "pending",
    };
    store.insertQueueStep(inserted, "step-2");

    // Start the inserted step
    store.startQueueStep("step-new");
    let step = store.getState().queueSteps.find((s) => s.id === "step-new");
    expect(step!.status).toBe("running");

    // Complete it
    store.completeQueueStep("step-new");
    step = store.getState().queueSteps.find((s) => s.id === "step-new");
    expect(step!.status).toBe("completed");
    expect(step!.duration).toBeDefined();
  });

  it("removed step updates total count", () => {
    const store = createStore("test");
    store.setQueueSteps(makeInitialSteps());

    const before = computeQueueProgress(store.getState().queueSteps);
    expect(before.total).toBe(3);

    store.removeQueueStep("step-3");

    const after = computeQueueProgress(store.getState().queueSteps);
    expect(after.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// VAL-TUI-006: OpenTUI adapter handles queue:step-inserted events
// ---------------------------------------------------------------------------

describe("VAL-TUI-006: adapter event handling for dynamic insertion", () => {
  // The OpenTUI adapter handles queue:step-inserted events by calling
  // actions.insertQueueStep(). We test the store-level action here
  // since the adapter simply delegates to the action.

  it("insertQueueStep called with correct arguments from adapter event shape", () => {
    const store = createStore("test");
    const initialSteps: QueueStepState[] = [
      { id: "a", type: "work", title: "Work", status: "running" },
      { id: "b", type: "review", title: "Review", status: "pending" },
    ];
    store.setQueueSteps(initialSteps);

    // Simulating what the adapter does when receiving queue:step-inserted event:
    // this.actions.insertQueueStep(
    //   { id: event.stepId, type: event.stepType, title: event.stepTitle, status: "pending" },
    //   event.afterStepId,
    // );
    store.insertQueueStep(
      { id: "c", type: "verify", title: "Verify Output", status: "pending" },
      "a",
    );

    const ids = store.getState().queueSteps.map((s) => s.id);
    expect(ids).toEqual(["a", "c", "b"]);
    expect(store.getState().queueSteps[1].type).toBe("verify");
    expect(store.getState().queueSteps[1].title).toBe("Verify Output");
    expect(store.getState().queueSteps[1].status).toBe("pending");
  });

  it("removeQueueStep called with correct arguments from adapter event shape", () => {
    const store = createStore("test");
    const initialSteps: QueueStepState[] = [
      { id: "a", type: "work", title: "Work", status: "completed" },
      { id: "b", type: "verify", title: "Verify", status: "pending" },
      { id: "c", type: "review", title: "Review", status: "pending" },
    ];
    store.setQueueSteps(initialSteps);

    // Simulating what the adapter does when receiving queue:step-removed event:
    // this.actions.removeQueueStep(event.stepId);
    store.removeQueueStep("b");

    const ids = store.getState().queueSteps.map((s) => s.id);
    expect(ids).toEqual(["a", "c"]);
  });

  it("progress updates correctly after adapter-driven insert", () => {
    const store = createStore("test");
    store.setQueueSteps([
      { id: "a", type: "plan", title: "Plan", status: "completed" },
      { id: "b", type: "work", title: "Work", status: "running" },
    ]);

    expect(computeQueueProgress(store.getState().queueSteps).total).toBe(2);

    // Adapter inserts a new step
    store.insertQueueStep(
      { id: "c", type: "verify", title: "Verify", status: "pending" },
      "b",
    );

    const progress = computeQueueProgress(store.getState().queueSteps);
    expect(progress.total).toBe(3);
    expect(progress.completed).toBe(1);
    expect(progress.running).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// VAL-TUI-009: Panel hides below 120 columns
// ---------------------------------------------------------------------------

describe("VAL-TUI-009: responsive panel hiding", () => {
  it("panel visible at exactly 120 columns", () => {
    const vis = layoutVisibility(120);
    expect(vis.showPanel).toBe(true);
  });

  it("panel visible above 120 columns", () => {
    const vis = layoutVisibility(200);
    expect(vis.showPanel).toBe(true);
  });

  it("panel hidden below 120 columns", () => {
    const vis = layoutVisibility(119);
    expect(vis.showPanel).toBe(false);
  });

  it("panel hidden at 80 columns (typical narrow terminal)", () => {
    const vis = layoutVisibility(80);
    expect(vis.showPanel).toBe(false);
  });

  it("panel hidden at minimum width", () => {
    const vis = layoutVisibility(1);
    expect(vis.showPanel).toBe(false);
  });

  it("MIN_WIDTH_PANEL constant is 120", () => {
    expect(MIN_WIDTH_PANEL).toBe(120);
  });

  it("sidebar visible at 90+ columns regardless of panel visibility", () => {
    const vis = layoutVisibility(90);
    expect(vis.showSidebar).toBe(true);
    expect(vis.showPanel).toBe(false); // 90 < 120
  });

  it("sidebar hidden below 90 columns", () => {
    const vis = layoutVisibility(80);
    expect(vis.showSidebar).toBe(false);
    expect(vis.showPanel).toBe(false);
  });

  it("both visible at wide terminal", () => {
    const vis = layoutVisibility(150);
    expect(vis.showSidebar).toBe(true);
    expect(vis.showPanel).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VAL-TUI-006 + VAL-TUI-015: Progress summary with dynamic insertions
// ---------------------------------------------------------------------------

describe("progress summary with dynamic insertions", () => {
  it("progress Steps: X/Y accurately reflects dynamically inserted steps", () => {
    const steps: QueueStepState[] = [
      { id: "1", type: "plan", title: "Plan", status: "completed" },
      { id: "2", type: "work", title: "Work 1", status: "completed" },
      { id: "3", type: "work", title: "Work 2", status: "running" },
      { id: "4", type: "review", title: "Review", status: "pending" },
    ];

    // Before insertion
    let progress = computeQueueProgress(steps);
    expect(progress.completed).toBe(2);
    expect(progress.total).toBe(4);

    // After dynamic insertion (simulating adding 2 more steps)
    const withInsertions: QueueStepState[] = [
      ...steps.slice(0, 3),
      { id: "5", type: "verify", title: "Verify", status: "pending" },
      { id: "6", type: "work", title: "Retry Work", status: "pending" },
      steps[3], // review stays at end
    ];

    progress = computeQueueProgress(withInsertions);
    expect(progress.completed).toBe(2);
    expect(progress.total).toBe(6);
    expect(progress.running).toBe(1);
  });

  it("step icons are correctly rendered for all possible statuses", () => {
    // Verify that all statuses used in dynamic insertion have correct icons
    expect(getStepStatusIcon("pending")).toBe("○");
    expect(getStepStatusIcon("running")).toBe("◐");
    expect(getStepStatusIcon("completed")).toBe("✓");
    expect(getStepStatusIcon("failed")).toBe("✗");
    expect(getStepStatusIcon("skipped")).toBe("⊘");
  });
});

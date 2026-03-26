import { describe, it, expect } from "bun:test";
import { createStore } from "../src/tui/routes/work/context/ui-state/store";
import type { QueueStepState } from "../src/tui/routes/work/state/types";

// ---------------------------------------------------------------------------
// Queue step actions — store integration tests
// ---------------------------------------------------------------------------

describe("queue step actions", () => {
  const makeSteps = (): QueueStepState[] => [
    { id: "s1", type: "plan", title: "Plan", status: "pending" },
    { id: "s2", type: "work", title: "Work 1", status: "pending" },
    { id: "s3", type: "review", title: "Review", status: "pending" },
  ];

  it("setQueueSteps populates state.queueSteps", () => {
    const store = createStore("test");
    const steps = makeSteps();
    store.setQueueSteps(steps);
    expect(store.getState().queueSteps).toEqual(steps);
  });

  it("startQueueStep transitions step to running", () => {
    const store = createStore("test");
    store.setQueueSteps(makeSteps());
    store.startQueueStep("s1");
    const step = store.getState().queueSteps.find((s) => s.id === "s1");
    expect(step?.status).toBe("running");
    expect(step?.startTime).toBeGreaterThan(0);
  });

  it("completeQueueStep transitions step to completed with duration", () => {
    const store = createStore("test");
    store.setQueueSteps(makeSteps());
    store.startQueueStep("s1");
    store.completeQueueStep("s1");
    const step = store.getState().queueSteps.find((s) => s.id === "s1");
    expect(step?.status).toBe("completed");
    expect(step?.endTime).toBeGreaterThan(0);
    expect(step?.duration).toBeDefined();
    expect(step!.duration!).toBeGreaterThanOrEqual(0);
  });

  it("failQueueStep transitions step to failed with error", () => {
    const store = createStore("test");
    store.setQueueSteps(makeSteps());
    store.startQueueStep("s1");
    store.failQueueStep("s1", "worker crashed");
    const step = store.getState().queueSteps.find((s) => s.id === "s1");
    expect(step?.status).toBe("failed");
    expect(step?.error).toBe("worker crashed");
    expect(step?.endTime).toBeGreaterThan(0);
  });

  it("insertQueueStep inserts after specified step", () => {
    const store = createStore("test");
    store.setQueueSteps(makeSteps());
    const newStep: QueueStepState = { id: "s4", type: "work", title: "Work 2", status: "pending" };
    store.insertQueueStep(newStep, "s2");
    const ids = store.getState().queueSteps.map((s) => s.id);
    expect(ids).toEqual(["s1", "s2", "s4", "s3"]);
  });

  it("insertQueueStep at end when afterStepId not found", () => {
    const store = createStore("test");
    store.setQueueSteps(makeSteps());
    const newStep: QueueStepState = { id: "s4", type: "verify", title: "Verify", status: "pending" };
    store.insertQueueStep(newStep, "nonexistent");
    const ids = store.getState().queueSteps.map((s) => s.id);
    expect(ids).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("removeQueueStep removes step by id", () => {
    const store = createStore("test");
    store.setQueueSteps(makeSteps());
    store.removeQueueStep("s2");
    const ids = store.getState().queueSteps.map((s) => s.id);
    expect(ids).toEqual(["s1", "s3"]);
  });

  it("panel updates live as steps transition", () => {
    const store = createStore("test");
    store.setQueueSteps(makeSteps());

    // All pending
    expect(store.getState().queueSteps.every((s) => s.status === "pending")).toBe(true);

    // Start step 1
    store.startQueueStep("s1");
    expect(store.getState().queueSteps[0].status).toBe("running");

    // Complete step 1
    store.completeQueueStep("s1");
    expect(store.getState().queueSteps[0].status).toBe("completed");

    // Start step 2
    store.startQueueStep("s2");
    expect(store.getState().queueSteps[1].status).toBe("running");

    // Fail step 2
    store.failQueueStep("s2", "error");
    expect(store.getState().queueSteps[1].status).toBe("failed");
    expect(store.getState().queueSteps[1].error).toBe("error");
  });

  it("queueSteps initializes empty", () => {
    const store = createStore("test");
    expect(store.getState().queueSteps).toEqual([]);
  });
});

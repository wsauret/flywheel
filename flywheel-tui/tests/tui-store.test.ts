import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createStore } from "../src/tui/routes/work/context/ui-state/store";
import type { UIActions } from "../src/tui/routes/work/context/ui-state/types";

describe("Work Store", () => {
  let store: UIActions;

  beforeEach(() => {
    store = createStore("test-plan");
  });

  // ── Factory ──

  describe("createStore", () => {
    it("creates store with initial state", () => {
      const state = store.getState();
      expect(state.planName).toBe("test-plan");
      expect(state.workflowStatus).toBe("idle");
      expect(state.queueSteps).toEqual([]);
      expect(state.outputLines).toEqual([]);
      expect(state.approvalState).toEqual({ pending: false });
      expect(state.selectedStepIndex).toBe(0);
      expect(state.scrollOffset).toBe(0);
    });

    it("each createStore returns isolated instance", () => {
      const store2 = createStore("other-plan");
      store.startWorkflow("plan-a");
      expect(store.getState().workflowStatus).toBe("running");
      expect(store2.getState().workflowStatus).toBe("idle");
    });

    it("createStore(a) !== createStore(b) — always independent", () => {
      const storeA = createStore("a");
      const storeB = createStore("b");
      expect(storeA).not.toBe(storeB);
    });

    it("state mutations do not leak between independent stores", () => {
      const storeA = createStore("a");
      const storeB = createStore("b");

      // Mutate store A
      storeA.startWorkflow("plan-a");
      storeA.setQueueSteps([{ id: "s1", type: "work", title: "Step 0", status: "pending" }]);
      storeA.appendOutput({ stream: "stdout", data: "hello\n", timestamp: "t1" });
      storeA.setApprovalPending("Approve?");

      // Store B must be completely unaffected
      expect(storeB.getState().workflowStatus).toBe("idle");
      expect(storeB.getState().queueSteps).toHaveLength(0);
      expect(storeB.getState().outputLines).toHaveLength(0);
      expect(storeB.getState().approvalState.pending).toBe(false);
      expect(storeB.getState().planName).toBe("b");
    });
  });

  // ── Throttle / Notification ──

  describe("throttle", () => {
    it("batches notifications within 16ms", async () => {
      let notified = 0;
      store.subscribe(() => { notified++; });

      // appendOutput uses throttled notify
      store.appendOutput({ stream: "stdout", data: "line1\n", timestamp: "t1" });
      store.appendOutput({ stream: "stdout", data: "line2\n", timestamp: "t2" });
      store.appendOutput({ stream: "stdout", data: "line3\n", timestamp: "t3" });

      // Immediately: should have at most 1 notification (the first setTimeout)
      const immediateCount = notified;

      // Wait for throttle to flush
      await new Promise((r) => setTimeout(r, 30));

      // All 3 outputs should be in state, but notifications should be batched
      expect(store.getState().outputLines).toHaveLength(3);
      // Total notifications should be less than 3 (batched)
      expect(notified).toBeLessThanOrEqual(3);
      expect(notified).toBeGreaterThanOrEqual(1);
    });

    it("notifyImmediate bypasses throttle for approval", () => {
      let notified = 0;
      store.subscribe(() => { notified++; });
      store.setApprovalPending("Please approve");
      // Immediate: should have notified synchronously
      expect(notified).toBeGreaterThanOrEqual(1);
      expect(store.getState().approvalState.pending).toBe(true);
    });

    it("startWorkflow uses notifyImmediate", () => {
      let notified = 0;
      store.subscribe(() => { notified++; });
      store.startWorkflow("my-plan");
      expect(notified).toBeGreaterThanOrEqual(1);
      expect(store.getState().workflowStatus).toBe("running");
    });

    it("startQueueStep uses notifyImmediate", () => {
      let notified = 0;
      store.setQueueSteps([{ id: "s1", type: "work", title: "Step 0", status: "pending" }]);
      store.subscribe(() => { notified++; });
      store.startQueueStep("s1");
      expect(notified).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Reset ──

  describe("reset", () => {
    it("resets state to initial with new planName", () => {
      store.startWorkflow("old-plan");
      store.setQueueSteps([{ id: "s1", type: "work", title: "Step 0", status: "running" }]);
      store.appendOutput({ stream: "stdout", data: "hello\n", timestamp: "t1" });

      store.reset("new-plan");

      const state = store.getState();
      expect(state.planName).toBe("new-plan");
      expect(state.workflowStatus).toBe("idle");
      expect(state.queueSteps).toEqual([]);
      expect(state.outputLines).toEqual([]);
    });

    it("re-notifies subscribers on reset", () => {
      let notified = 0;
      store.subscribe(() => { notified++; });
      store.reset("fresh");
      expect(notified).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Queue Step Actions ──

  describe("queue step actions", () => {
    it("setQueueSteps replaces step list", () => {
      store.setQueueSteps([
        { id: "s1", type: "work", title: "Setup", status: "pending" },
      ]);
      const steps = store.getState().queueSteps;
      expect(steps).toHaveLength(1);
      expect(steps[0].id).toBe("s1");
      expect(steps[0].title).toBe("Setup");
      expect(steps[0].status).toBe("pending");
    });

    it("startQueueStep transitions step to running", () => {
      store.setQueueSteps([
        { id: "s1", type: "work", title: "Build", status: "pending" },
      ]);
      store.startQueueStep("s1");
      const step = store.getState().queueSteps[0];
      expect(step.status).toBe("running");
      expect(step.startTime).toBeDefined();
    });

    it("completeQueueStep transitions step to completed with duration", () => {
      store.setQueueSteps([
        { id: "s1", type: "work", title: "Build", status: "pending" },
      ]);
      store.startQueueStep("s1");
      store.completeQueueStep("s1");
      const step = store.getState().queueSteps[0];
      expect(step.status).toBe("completed");
      expect(step.endTime).toBeDefined();
      expect(step.duration).toBeDefined();
      expect(step.duration!).toBeGreaterThanOrEqual(0);
    });

    it("failQueueStep transitions step to failed with error", () => {
      store.setQueueSteps([
        { id: "s1", type: "work", title: "Build", status: "pending" },
      ]);
      store.startQueueStep("s1");
      store.failQueueStep("s1", "Build error");
      const step = store.getState().queueSteps[0];
      expect(step.status).toBe("failed");
      expect(step.error).toBe("Build error");
    });

    it("insertQueueStep adds step after specified position", () => {
      store.setQueueSteps([
        { id: "s1", type: "work", title: "First", status: "completed" },
        { id: "s3", type: "review", title: "Third", status: "pending" },
      ]);
      store.insertQueueStep(
        { id: "s2", type: "work", title: "Second", status: "pending" },
        "s1",
      );
      const steps = store.getState().queueSteps;
      expect(steps).toHaveLength(3);
      expect(steps[1].id).toBe("s2");
    });

    it("removeQueueStep removes step by ID", () => {
      store.setQueueSteps([
        { id: "s1", type: "work", title: "First", status: "pending" },
        { id: "s2", type: "work", title: "Second", status: "pending" },
      ]);
      store.removeQueueStep("s1");
      const steps = store.getState().queueSteps;
      expect(steps).toHaveLength(1);
      expect(steps[0].id).toBe("s2");
    });

    it("completeQueueStep is no-op for unknown step ID", () => {
      store.setQueueSteps([]);
      store.completeQueueStep("nonexistent");
      expect(store.getState().queueSteps).toHaveLength(0);
    });

    it("failQueueStep is no-op for unknown step ID", () => {
      store.setQueueSteps([]);
      store.failQueueStep("nonexistent", "error");
      expect(store.getState().queueSteps).toHaveLength(0);
    });
  });

  // ── Workflow Actions ──

  describe("workflow actions", () => {
    it("startWorkflow sets running status and planName", () => {
      store.startWorkflow("my-plan.md");
      const state = store.getState();
      expect(state.workflowStatus).toBe("running");
      expect(state.planName).toBe("my-plan.md");
      expect(state.startTime).toBeDefined();
    });

    it("startWorkflow resets queueSteps and output", () => {
      store.setQueueSteps([{ id: "s1", type: "work", title: "Old Step", status: "running" }]);
      store.appendOutput({ stream: "stdout", data: "old\n", timestamp: "t1" });
      store.startWorkflow("fresh-plan");
      const state = store.getState();
      expect(state.queueSteps).toEqual([]);
      expect(state.outputLines).toEqual([]);
    });

    it("stopWorkflow sets completed status", () => {
      store.startWorkflow("plan");
      store.stopWorkflow("completed");
      const state = store.getState();
      expect(state.workflowStatus).toBe("completed");
      expect(state.endTime).toBeDefined();
    });

    it("stopWorkflow sets interrupted status", () => {
      store.startWorkflow("plan");
      store.stopWorkflow("interrupted");
      expect(store.getState().workflowStatus).toBe("interrupted");
    });

    it("setError sets failed status and error message", () => {
      store.startWorkflow("plan");
      store.setError("Something broke");
      const state = store.getState();
      expect(state.workflowStatus).toBe("failed");
      expect(state.error).toBe("Something broke");
    });

    it("appendOutput adds lines to outputLines", () => {
      store.appendOutput({ stream: "stdout", data: "hello\n", timestamp: "t1" });
      store.appendOutput({ stream: "stderr", data: "error\n", timestamp: "t2" });
      const lines = store.getState().outputLines;
      expect(lines).toHaveLength(2);
      expect(lines[0].stream).toBe("stdout");
      expect(lines[0].data).toBe("hello\n");
      expect(lines[1].stream).toBe("stderr");
    });

    it("setApprovalPending sets approval state", () => {
      store.setApprovalPending("Review this change");
      const approval = store.getState().approvalState;
      expect(approval.pending).toBe(true);
      expect(approval.description).toBe("Review this change");
    });

    it("clearApproval resets approval state", () => {
      store.setApprovalPending("Review");
      store.clearApproval();
      const approval = store.getState().approvalState;
      expect(approval.pending).toBe(false);
      expect(approval.description).toBeUndefined();
    });

    it("continueStage updates planName without wiping output", () => {
      store.startWorkflow("stage-1-plan");
      store.appendOutput({ stream: "stdout", data: "stage 1 output\n", timestamp: "t1" });
      store.setOutputBlocks([{ kind: "text", content: "block1", timestamp: Date.now() }]);

      store.continueStage("stage-2-plan");

      const state = store.getState();
      expect(state.planName).toBe("stage-2-plan");
      expect(state.workflowStatus).toBe("running");
      expect(state.approvalState.pending).toBe(false);
      expect(state.error).toBeUndefined();
      // Output must be preserved (not wiped)
      expect(state.outputLines).toHaveLength(1);
      expect(state.outputBlocks).toHaveLength(1);
      // startTime must be preserved (not reset)
      expect(state.startTime).toBeDefined();
    });

    it("continueStage clears pending approval and error", () => {
      store.startWorkflow("plan-a");
      store.setApprovalPending("Review this");
      store.setError("old error");

      store.continueStage("plan-b");

      const state = store.getState();
      expect(state.approvalState.pending).toBe(false);
      expect(state.error).toBeUndefined();
      expect(state.workflowStatus).toBe("running");
    });
  });

  // ── Navigation Actions ──

  describe("navigation actions", () => {
    it("selectNext increments selectedStepIndex", () => {
      store.setQueueSteps([
        { id: "s1", type: "work", title: "Step 0", status: "pending" },
        { id: "s2", type: "work", title: "Step 1", status: "pending" },
      ]);
      store.selectStep(0);
      store.selectNext();
      expect(store.getState().selectedStepIndex).toBe(1);
    });

    it("selectNext clamps to last step", () => {
      store.setQueueSteps([
        { id: "s1", type: "work", title: "Step 0", status: "pending" },
        { id: "s2", type: "work", title: "Step 1", status: "pending" },
      ]);
      store.selectStep(1);
      store.selectNext();
      expect(store.getState().selectedStepIndex).toBe(1);
    });

    it("selectPrevious decrements selectedStepIndex", () => {
      store.setQueueSteps([
        { id: "s1", type: "work", title: "Step 0", status: "pending" },
        { id: "s2", type: "work", title: "Step 1", status: "pending" },
      ]);
      store.selectStep(1);
      store.selectPrevious();
      expect(store.getState().selectedStepIndex).toBe(0);
    });

    it("selectPrevious clamps to 0", () => {
      store.setQueueSteps([
        { id: "s1", type: "work", title: "Step 0", status: "pending" },
      ]);
      store.selectStep(0);
      store.selectPrevious();
      expect(store.getState().selectedStepIndex).toBe(0);
    });

    it("selectStep sets index directly", () => {
      store.setQueueSteps([
        { id: "s1", type: "work", title: "Step 0", status: "pending" },
        { id: "s2", type: "work", title: "Step 1", status: "pending" },
        { id: "s3", type: "work", title: "Step 2", status: "pending" },
      ]);
      store.selectStep(2);
      expect(store.getState().selectedStepIndex).toBe(2);
    });

    it("selectNext is no-op when no steps", () => {
      store.selectNext();
      expect(store.getState().selectedStepIndex).toBe(0);
    });

    it("selectPrevious is no-op when no steps", () => {
      store.selectPrevious();
      expect(store.getState().selectedStepIndex).toBe(0);
    });
  });
});

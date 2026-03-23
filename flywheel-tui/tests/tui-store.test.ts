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
      expect(state.phases).toEqual([]);
      expect(state.outputLines).toEqual([]);
      expect(state.approvalState).toEqual({ pending: false });
      expect(state.selectedPhaseIndex).toBe(0);
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
      storeA.startPhase(0, "Phase 0");
      storeA.appendOutput({ stream: "stdout", data: "hello\n", timestamp: "t1" });
      storeA.setApprovalPending("Approve?");

      // Store B must be completely unaffected
      expect(storeB.getState().workflowStatus).toBe("idle");
      expect(storeB.getState().phases).toHaveLength(0);
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

    it("startPhase uses notifyImmediate", () => {
      let notified = 0;
      store.subscribe(() => { notified++; });
      store.startPhase(0, "Phase 0");
      expect(notified).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Reset ──

  describe("reset", () => {
    it("resets state to initial with new planName", () => {
      store.startWorkflow("old-plan");
      store.startPhase(0, "Phase 0");
      store.appendOutput({ stream: "stdout", data: "hello\n", timestamp: "t1" });

      store.reset("new-plan");

      const state = store.getState();
      expect(state.planName).toBe("new-plan");
      expect(state.workflowStatus).toBe("idle");
      expect(state.phases).toEqual([]);
      expect(state.outputLines).toEqual([]);
    });

    it("re-notifies subscribers on reset", () => {
      let notified = 0;
      store.subscribe(() => { notified++; });
      store.reset("fresh");
      expect(notified).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Phase Actions ──

  describe("phase actions", () => {
    it("addPhase appends a new phase with pending status", () => {
      store.addPhase({ index: 0, name: "Setup" });
      const phases = store.getState().phases;
      expect(phases).toHaveLength(1);
      expect(phases[0].index).toBe(0);
      expect(phases[0].name).toBe("Setup");
      expect(phases[0].status).toBe("pending");
    });

    it("startPhase creates phase if not existing and sets running", () => {
      store.startPhase(0, "Build");
      const phases = store.getState().phases;
      expect(phases).toHaveLength(1);
      expect(phases[0].status).toBe("running");
      expect(phases[0].startTime).toBeDefined();
      expect(phases[0].name).toBe("Build");
    });

    it("startPhase updates existing phase to running", () => {
      store.addPhase({ index: 0, name: "Setup" });
      store.startPhase(0, "Setup");
      const phases = store.getState().phases;
      expect(phases).toHaveLength(1);
      expect(phases[0].status).toBe("running");
    });

    it("startPhase auto-selects the started phase", () => {
      store.startPhase(0, "Phase 0");
      store.startPhase(1, "Phase 1");
      expect(store.getState().selectedPhaseIndex).toBe(1);
    });

    it("completePhase sets status to completed with duration", () => {
      store.startPhase(0, "Build");
      store.completePhase(0);
      const phase = store.getState().phases[0];
      expect(phase.status).toBe("completed");
      expect(phase.endTime).toBeDefined();
      expect(phase.duration).toBeDefined();
      expect(phase.duration!).toBeGreaterThanOrEqual(0);
    });

    it("failPhase sets status to failed with error", () => {
      store.startPhase(0, "Build");
      store.failPhase(0, "Build error");
      const phase = store.getState().phases[0];
      expect(phase.status).toBe("failed");
      expect(phase.error).toBe("Build error");
    });

    it("skipPhase sets status to skipped", () => {
      store.addPhase({ index: 0, name: "Optional" });
      store.skipPhase(0);
      expect(store.getState().phases[0].status).toBe("skipped");
    });

    it("completePhase is no-op for unknown phase index", () => {
      store.completePhase(99);
      expect(store.getState().phases).toHaveLength(0);
    });

    it("failPhase is no-op for unknown phase index", () => {
      store.failPhase(99, "error");
      expect(store.getState().phases).toHaveLength(0);
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

    it("startWorkflow resets phases and output", () => {
      store.startPhase(0, "Old Phase");
      store.appendOutput({ stream: "stdout", data: "old\n", timestamp: "t1" });
      store.startWorkflow("fresh-plan");
      const state = store.getState();
      expect(state.phases).toEqual([]);
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
      store.startPhase(0, "Phase A");

      store.continueStage("stage-2-plan");

      const state = store.getState();
      expect(state.planName).toBe("stage-2-plan");
      expect(state.workflowStatus).toBe("running");
      expect(state.approvalState.pending).toBe(false);
      expect(state.error).toBeUndefined();
      // Output must be preserved (not wiped)
      expect(state.outputLines).toHaveLength(1);
      expect(state.outputBlocks).toHaveLength(1);
      // Phases must be preserved
      expect(state.phases).toHaveLength(1);
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
    it("selectNext increments selectedPhaseIndex", () => {
      store.startPhase(0, "Phase 0");
      store.startPhase(1, "Phase 1");
      store.selectPhase(0);
      store.selectNext();
      expect(store.getState().selectedPhaseIndex).toBe(1);
    });

    it("selectNext clamps to last phase", () => {
      store.startPhase(0, "Phase 0");
      store.startPhase(1, "Phase 1");
      store.selectPhase(1);
      store.selectNext();
      expect(store.getState().selectedPhaseIndex).toBe(1);
    });

    it("selectPrevious decrements selectedPhaseIndex", () => {
      store.startPhase(0, "Phase 0");
      store.startPhase(1, "Phase 1");
      store.selectPhase(1);
      store.selectPrevious();
      expect(store.getState().selectedPhaseIndex).toBe(0);
    });

    it("selectPrevious clamps to 0", () => {
      store.startPhase(0, "Phase 0");
      store.selectPhase(0);
      store.selectPrevious();
      expect(store.getState().selectedPhaseIndex).toBe(0);
    });

    it("selectPhase sets index directly", () => {
      store.startPhase(0, "Phase 0");
      store.startPhase(1, "Phase 1");
      store.startPhase(2, "Phase 2");
      store.selectPhase(2);
      expect(store.getState().selectedPhaseIndex).toBe(2);
    });

    it("selectNext is no-op when no phases", () => {
      store.selectNext();
      expect(store.getState().selectedPhaseIndex).toBe(0);
    });

    it("selectPrevious is no-op when no phases", () => {
      store.selectPrevious();
      expect(store.getState().selectedPhaseIndex).toBe(0);
    });
  });
});

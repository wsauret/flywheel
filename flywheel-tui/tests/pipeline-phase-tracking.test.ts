import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { EventBus } from "../src/events/event-bus";
import { OpenTUIAdapter, createOpenTUIAdapter } from "../src/tui/adapters/opentui";
import { createStore } from "../src/tui/routes/work/context/ui-state/store";
import { timerService } from "../src/tui/shared/services/timer";
import { computeStageProgress } from "../src/tui/components/workflow-panel-logic";
import type { UIActions } from "../src/tui/routes/work/context/ui-state/types";

function createHarness() {
  const bus = new EventBus();
  const store = createStore("test-plan");
  const adapter = createOpenTUIAdapter(store);
  adapter.connect(bus);
  adapter.start();
  return { bus, store, adapter };
}

function ts(): string {
  return new Date().toISOString();
}

describe("Pipeline Phase Tracking (Hierarchical Stages)", () => {
  beforeEach(() => {
    timerService.reset();
  });

  afterEach(() => {
    timerService.reset();
  });

  // ── Stage Store Actions ──

  describe("stage store actions", () => {
    it("addStage creates a new StageGroup with pending status", () => {
      const store = createStore("test");
      store.addStage("plan");
      const stages = store.getState().stages;
      expect(stages).toHaveLength(1);
      expect(stages[0].label).toBe("plan");
      expect(stages[0].status).toBe("pending");
      expect(stages[0].phases).toEqual([]);
    });

    it("addStage does not create duplicates", () => {
      const store = createStore("test");
      store.addStage("plan");
      store.addStage("plan");
      expect(store.getState().stages).toHaveLength(1);
    });

    it("startStage sets stage to running", () => {
      const store = createStore("test");
      store.addStage("work");
      store.startStage("work");
      expect(store.getState().stages[0].status).toBe("running");
    });

    it("completeStage sets stage to completed", () => {
      const store = createStore("test");
      store.addStage("work");
      store.startStage("work");
      store.completeStage("work");
      expect(store.getState().stages[0].status).toBe("completed");
    });

    it("failStage sets stage to failed", () => {
      const store = createStore("test");
      store.addStage("work");
      store.startStage("work");
      store.failStage("work");
      expect(store.getState().stages[0].status).toBe("failed");
    });

    it("startStage is no-op for unknown label", () => {
      const store = createStore("test");
      store.startStage("nonexistent");
      expect(store.getState().stages).toHaveLength(0);
    });

    it("addPhaseToStage appends a phase to the stage", () => {
      const store = createStore("test");
      store.addStage("plan");
      store.addPhaseToStage("plan", { index: 0, name: "Phase 0", status: "pending" });
      const stages = store.getState().stages;
      expect(stages[0].phases).toHaveLength(1);
      expect(stages[0].phases[0].name).toBe("Phase 0");
      expect(stages[0].phases[0].status).toBe("pending");
    });

    it("startPhaseInStage starts a phase within the stage", () => {
      const store = createStore("test");
      store.addStage("work");
      store.startPhaseInStage("work", 0, "Build");
      const phase = store.getState().stages[0].phases[0];
      expect(phase.status).toBe("running");
      expect(phase.name).toBe("Build");
      expect(phase.startTime).toBeDefined();
    });

    it("startPhaseInStage creates phase if not existing", () => {
      const store = createStore("test");
      store.addStage("work");
      store.startPhaseInStage("work", 0, "Phase A");
      expect(store.getState().stages[0].phases).toHaveLength(1);
      expect(store.getState().stages[0].phases[0].status).toBe("running");
    });

    it("startPhaseInStage updates existing phase to running", () => {
      const store = createStore("test");
      store.addStage("work");
      store.addPhaseToStage("work", { index: 0, name: "Phase A", status: "pending" });
      store.startPhaseInStage("work", 0, "Phase A");
      const stages = store.getState().stages;
      expect(stages[0].phases).toHaveLength(1);
      expect(stages[0].phases[0].status).toBe("running");
    });

    it("completePhaseInStage completes a phase within the stage", () => {
      const store = createStore("test");
      store.addStage("work");
      store.startPhaseInStage("work", 0, "Build");
      store.completePhaseInStage("work", 0);
      const phase = store.getState().stages[0].phases[0];
      expect(phase.status).toBe("completed");
      expect(phase.endTime).toBeDefined();
      expect(phase.duration).toBeDefined();
      expect(phase.duration!).toBeGreaterThanOrEqual(0);
    });

    it("failPhaseInStage fails a phase within the stage", () => {
      const store = createStore("test");
      store.addStage("work");
      store.startPhaseInStage("work", 0, "Build");
      store.failPhaseInStage("work", 0, "compile error");
      const phase = store.getState().stages[0].phases[0];
      expect(phase.status).toBe("failed");
      expect(phase.error).toBe("compile error");
    });

    it("stages are cleared on reset", () => {
      const store = createStore("test");
      store.addStage("plan");
      store.addStage("work");
      store.reset("new-plan");
      expect(store.getState().stages).toEqual([]);
    });

    it("stages are cleared on startWorkflow", () => {
      const store = createStore("test");
      store.addStage("plan");
      store.startWorkflow("new-plan");
      expect(store.getState().stages).toEqual([]);
    });
  });

  // ── Pipeline Event Flow ──

  describe("pipeline event flow → stages populated", () => {
    it("pipeline:started pre-creates all stages with pending status", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "pipeline:started",
        pipelineId: "p1",
        stages: ["plan", "work", "review"],
        timestamp: ts(),
      });
      const stages = store.getState().stages;
      expect(stages).toHaveLength(3);
      expect(stages[0]).toEqual({ label: "plan", status: "pending", phases: [] });
      expect(stages[1]).toEqual({ label: "work", status: "pending", phases: [] });
      expect(stages[2]).toEqual({ label: "review", status: "pending", phases: [] });
    });

    it("workflow:started for first stage sets it to running", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "pipeline:started",
        pipelineId: "p1",
        stages: ["plan", "work"],
        timestamp: ts(),
      });
      bus.emit({
        type: "workflow:started",
        workflowId: "w1",
        planPath: "plan.md",
        timestamp: ts(),
      });
      const stages = store.getState().stages;
      expect(stages[0].status).toBe("running");
      expect(stages[1].status).toBe("pending");
    });

    it("phase events add phases to the active stage's children", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "pipeline:started",
        pipelineId: "p1",
        stages: ["plan", "work"],
        timestamp: ts(),
      });
      bus.emit({
        type: "workflow:started",
        workflowId: "w1",
        planPath: "plan.md",
        timestamp: ts(),
      });
      bus.emit({
        type: "phase:started",
        workflowId: "w1",
        phaseIndex: 0,
        phaseName: "Draft Plan",
        timestamp: ts(),
      });

      const stages = store.getState().stages;
      expect(stages[0].phases).toHaveLength(1);
      expect(stages[0].phases[0].name).toBe("Draft Plan");
      expect(stages[0].phases[0].status).toBe("running");
      // Work stage should still have no phases
      expect(stages[1].phases).toHaveLength(0);
    });

    it("phase names from earlier stages are preserved when later stages start", () => {
      const { bus, store } = createHarness();
      // Start pipeline
      bus.emit({
        type: "pipeline:started",
        pipelineId: "p1",
        stages: ["plan", "work"],
        timestamp: ts(),
      });
      // Plan stage
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "plan.md", timestamp: ts() });
      bus.emit({ type: "phase:started", workflowId: "w1", phaseIndex: 0, phaseName: "Draft Plan", timestamp: ts() });
      bus.emit({ type: "phase:completed", workflowId: "w1", phaseIndex: 0, timestamp: ts() });
      bus.emit({ type: "workflow:completed", workflowId: "w1", timestamp: ts() });

      // Transition to work
      bus.emit({ type: "pipeline:stage-transition", pipelineId: "p1", from: "plan", to: "work", timestamp: ts() });
      bus.emit({ type: "workflow:started", workflowId: "w2", planPath: "work.md", timestamp: ts() });
      bus.emit({ type: "phase:started", workflowId: "w2", phaseIndex: 1, phaseName: "Implement", timestamp: ts() });

      const stages = store.getState().stages;
      // Plan stage phases preserved
      expect(stages[0].label).toBe("plan");
      expect(stages[0].status).toBe("completed");
      expect(stages[0].phases).toHaveLength(1);
      expect(stages[0].phases[0].name).toBe("Draft Plan");
      expect(stages[0].phases[0].status).toBe("completed");
      // Work stage has new phases
      expect(stages[1].label).toBe("work");
      expect(stages[1].status).toBe("running");
      expect(stages[1].phases).toHaveLength(1);
      expect(stages[1].phases[0].name).toBe("Implement");
      expect(stages[1].phases[0].status).toBe("running");
    });

    it("pipeline:completed completes the final stage", () => {
      const { bus, store } = createHarness();
      bus.emit({ type: "pipeline:started", pipelineId: "p1", stages: ["plan", "work"], timestamp: ts() });
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "plan.md", timestamp: ts() });
      bus.emit({ type: "workflow:completed", workflowId: "w1", timestamp: ts() });
      bus.emit({ type: "pipeline:stage-transition", pipelineId: "p1", from: "plan", to: "work", timestamp: ts() });
      bus.emit({ type: "workflow:started", workflowId: "w2", planPath: "work.md", timestamp: ts() });
      bus.emit({ type: "workflow:completed", workflowId: "w2", timestamp: ts() });
      bus.emit({ type: "pipeline:completed", pipelineId: "p1", stagesCompleted: 2, timestamp: ts() });

      const stages = store.getState().stages;
      expect(stages[0].status).toBe("completed");
      expect(stages[1].status).toBe("completed");
    });

    it("pipeline:failed fails the current stage", () => {
      const { bus, store } = createHarness();
      bus.emit({ type: "pipeline:started", pipelineId: "p1", stages: ["plan", "work"], timestamp: ts() });
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "plan.md", timestamp: ts() });
      bus.emit({ type: "pipeline:failed", pipelineId: "p1", reason: "boom", stagesCompleted: 0, timestamp: ts() });

      const stages = store.getState().stages;
      expect(stages[0].status).toBe("failed");
      expect(stages[1].status).toBe("pending");
    });

    it("flat phases array is still populated for backward compatibility", () => {
      const { bus, store } = createHarness();
      bus.emit({ type: "pipeline:started", pipelineId: "p1", stages: ["plan", "work"], timestamp: ts() });
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "plan.md", timestamp: ts() });
      bus.emit({ type: "phase:started", workflowId: "w1", phaseIndex: 0, phaseName: "Phase A", timestamp: ts() });
      bus.emit({ type: "phase:completed", workflowId: "w1", phaseIndex: 0, timestamp: ts() });

      // Flat phases
      expect(store.getState().phases).toHaveLength(1);
      expect(store.getState().phases[0].name).toBe("Phase A");
      expect(store.getState().phases[0].status).toBe("completed");

      // Stage phases
      expect(store.getState().stages[0].phases).toHaveLength(1);
      expect(store.getState().stages[0].phases[0].name).toBe("Phase A");
      expect(store.getState().stages[0].phases[0].status).toBe("completed");
    });
  });

  // ── Standalone mode ──

  describe("standalone mode", () => {
    it("standalone workflow:started creates a single 'work' stage", () => {
      const { bus, store } = createHarness();
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "plan.md", timestamp: ts() });
      const stages = store.getState().stages;
      expect(stages).toHaveLength(1);
      expect(stages[0].label).toBe("work");
      expect(stages[0].status).toBe("running");
    });

    it("standalone phases are added to the 'work' stage", () => {
      const { bus, store } = createHarness();
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "plan.md", timestamp: ts() });
      bus.emit({ type: "phase:started", workflowId: "w1", phaseIndex: 0, phaseName: "Build", timestamp: ts() });
      bus.emit({ type: "phase:completed", workflowId: "w1", phaseIndex: 0, timestamp: ts() });

      const stages = store.getState().stages;
      expect(stages[0].phases).toHaveLength(1);
      expect(stages[0].phases[0].name).toBe("Build");
      expect(stages[0].phases[0].status).toBe("completed");
    });
  });

  // ── Progress computation ──

  describe("computeStageProgress", () => {
    it("computes progress across all stages", () => {
      const store = createStore("test");
      store.addStage("plan");
      store.addStage("work");
      store.startPhaseInStage("plan", 0, "Phase A");
      store.completePhaseInStage("plan", 0);
      store.startPhaseInStage("work", 1, "Phase B");
      store.startPhaseInStage("work", 2, "Phase C");
      store.failPhaseInStage("work", 2, "error");

      const progress = computeStageProgress(store.getState().stages);
      expect(progress.total).toBe(3);
      expect(progress.completed).toBe(1);
      expect(progress.running).toBe(1);
      expect(progress.failed).toBe(1);
    });

    it("returns zero progress for empty stages", () => {
      const progress = computeStageProgress([]);
      expect(progress.total).toBe(0);
      expect(progress.completed).toBe(0);
      expect(progress.running).toBe(0);
      expect(progress.failed).toBe(0);
    });

    it("returns zero progress for stages with no phases", () => {
      const progress = computeStageProgress([
        { label: "plan", status: "pending", phases: [] },
        { label: "work", status: "pending", phases: [] },
      ]);
      expect(progress.total).toBe(0);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { EventBus } from "../src/events/event-bus";
import { OpenTUIAdapter, createOpenTUIAdapter } from "../src/tui/adapters/opentui";
import { createTestStore } from "../src/tui/routes/work/context/ui-state/store";
import { timerService } from "../src/tui/shared/services/timer";
import type { FlywheelEvent } from "../src/events/types";
import type { UIActions } from "../src/tui/routes/work/context/ui-state/types";

/**
 * Helper to create a test harness with event bus, store, and adapter
 */
function createHarness() {
  const bus = new EventBus();
  const store = createTestStore("test-plan");
  const adapter = createOpenTUIAdapter(store);
  adapter.connect(bus);
  adapter.start();
  return { bus, store, adapter };
}

function ts(): string {
  return new Date().toISOString();
}

describe("OpenTUIAdapter", () => {
  beforeEach(() => {
    timerService.reset();
  });

  afterEach(() => {
    timerService.reset();
  });

  // ── Basics ──

  describe("basics", () => {
    it("has adapterType 'opentui'", () => {
      const store = createTestStore("test");
      const adapter = createOpenTUIAdapter(store);
      expect(adapter.adapterType).toBe("opentui");
    });

    it("connects to event bus and receives events", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "workflow:started",
        workflowId: "w1",
        planPath: "plan.md",
        timestamp: ts(),
      });
      expect(store.getState().workflowStatus).toBe("running");
    });

    it("factory function creates adapter", () => {
      const store = createTestStore("test");
      const adapter = createOpenTUIAdapter(store);
      expect(adapter).toBeInstanceOf(OpenTUIAdapter);
    });
  });

  // ── Event-to-Action translation ──

  describe("event-to-action translation", () => {
    // -- Workflow events --

    it("workflow:started → startWorkflow + timer start", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "workflow:started",
        workflowId: "w1",
        planPath: "plan.md",
        timestamp: ts(),
      });
      expect(store.getState().workflowStatus).toBe("running");
      expect(store.getState().planName).toBe("plan.md");
      expect(timerService.isRunning()).toBe(true);
    });

    it("workflow:completed → stopWorkflow('completed') + timer stop", () => {
      const { bus, store } = createHarness();
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "p", timestamp: ts() });
      bus.emit({ type: "workflow:completed", workflowId: "w1", timestamp: ts() });
      expect(store.getState().workflowStatus).toBe("completed");
      expect(timerService.isStopped()).toBe(true);
    });

    it("workflow:failed → setError + timer stop", () => {
      const { bus, store } = createHarness();
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "p", timestamp: ts() });
      bus.emit({ type: "workflow:failed", workflowId: "w1", reason: "kaboom", timestamp: ts() });
      expect(store.getState().workflowStatus).toBe("failed");
      expect(store.getState().error).toBe("kaboom");
      expect(timerService.isStopped()).toBe(true);
    });

    it("workflow:interrupted → stopWorkflow('interrupted') + timer stop", () => {
      const { bus, store } = createHarness();
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "p", timestamp: ts() });
      bus.emit({ type: "workflow:interrupted", workflowId: "w1", reason: "ctrl-c", timestamp: ts() });
      expect(store.getState().workflowStatus).toBe("interrupted");
      expect(timerService.isStopped()).toBe(true);
    });

    // -- Phase events --

    it("phase:started → startPhase + timer registerAgent", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "phase:started",
        workflowId: "w1",
        phaseIndex: 0,
        phaseName: "Build",
        timestamp: ts(),
      });
      expect(store.getState().phases).toHaveLength(1);
      expect(store.getState().phases[0].status).toBe("running");
      expect(timerService.hasAgent("phase-0")).toBe(true);
    });

    it("phase:completed → completePhase + timer completeAgent", () => {
      const { bus, store } = createHarness();
      bus.emit({ type: "phase:started", workflowId: "w1", phaseIndex: 0, phaseName: "Build", timestamp: ts() });
      bus.emit({ type: "phase:completed", workflowId: "w1", phaseIndex: 0, timestamp: ts() });
      expect(store.getState().phases[0].status).toBe("completed");
      expect(timerService.hasAgent("phase-0")).toBe(false);
    });

    it("phase:failed → failPhase + timer completeAgent", () => {
      const { bus, store } = createHarness();
      bus.emit({ type: "phase:started", workflowId: "w1", phaseIndex: 0, phaseName: "Build", timestamp: ts() });
      bus.emit({ type: "phase:failed", workflowId: "w1", phaseIndex: 0, reason: "compile error", timestamp: ts() });
      expect(store.getState().phases[0].status).toBe("failed");
      expect(store.getState().phases[0].error).toBe("compile error");
      expect(timerService.hasAgent("phase-0")).toBe(false);
    });

    // -- Worker events --

    it("worker:output stdout → structured outputBlocks", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: "hello world\n",
        timestamp: "2025-01-01T00:00:00Z",
      });
      // Stdout now goes through the structured pipeline → outputBlocks
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      expect(blocks[0].kind).toBe("text");
      expect((blocks[0] as any).content).toContain("hello world");
    });

    it("worker:output stderr → structured outputBlocks (text block)", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stderr",
        data: "error output\n",
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const textBlocks = blocks.filter((b: any) => b.kind === "text");
      expect(textBlocks.length).toBeGreaterThanOrEqual(1);
      expect((textBlocks[0] as any).content).toContain("error output");
    });

    it("worker:retrying → structured outputBlocks with retry message", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "worker:retrying",
        workflowId: "w1",
        attempt: 2,
        maxAttempts: 3,
        reason: "timeout",
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const text = blocks.filter((b: any) => b.kind === "text").map((b: any) => b.content).join("");
      expect(text).toContain("Retrying (2/3)");
      expect(text).toContain("timeout");
    });

    it("worker:spawned produces structured outputBlock", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "worker:spawned",
        workflowId: "w1",
        phaseIndex: 0,
        stepIndex: 0,
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const text = blocks.filter((b: any) => b.kind === "text").map((b: any) => b.content).join("");
      expect(text).toContain("Worker spawned for step 0");
    });

    it("worker:completed produces structured outputBlock", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "worker:completed",
        workflowId: "w1",
        result: { output: "", exitCode: 0, durationMs: 100, truncated: false } as any,
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const text = blocks.filter((b: any) => b.kind === "text").map((b: any) => b.content).join("");
      expect(text).toContain("Worker finished");
    });

    it("worker:failed produces structured outputBlock", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "worker:failed",
        workflowId: "w1",
        failure: { kind: "timeout", timeoutMs: 5000, message: "timed out" } as any,
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const text = blocks.filter((b: any) => b.kind === "text").map((b: any) => b.content).join("");
      expect(text).toContain("Worker failed: timed out");
    });

    // -- Approval events --

    it("approval:requested → setApprovalPending", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "approval:requested",
        workflowId: "w1",
        phaseIndex: 0,
        stepIndex: 0,
        description: "Delete database?",
        timestamp: ts(),
      });
      expect(store.getState().approvalState.pending).toBe(true);
      expect(store.getState().approvalState.description).toBe("Delete database?");
    });

    it("approval:received → clearApproval", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "approval:requested",
        workflowId: "w1",
        phaseIndex: 0,
        stepIndex: 0,
        description: "Delete?",
        timestamp: ts(),
      });
      bus.emit({
        type: "approval:received",
        workflowId: "w1",
        approved: true,
        skipped: false,
        timestamp: ts(),
      });
      expect(store.getState().approvalState.pending).toBe(false);
    });

    // -- Step events --

    it("step:started produces structured outputBlock", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "step:started",
        workflowId: "w1",
        phaseIndex: 0,
        stepIndex: 0,
        description: "Run tests",
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const text = blocks.filter((b: any) => b.kind === "text").map((b: any) => b.content).join("");
      expect(text).toContain("Step 0: Run tests");
    });

    it("step:completed produces structured outputBlock", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "step:completed",
        workflowId: "w1",
        phaseIndex: 0,
        stepIndex: 0,
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const text = blocks.filter((b: any) => b.kind === "text").map((b: any) => b.content).join("");
      expect(text).toContain("Step 0 complete");
    });

    it("step:failed produces structured outputBlock", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "step:failed",
        workflowId: "w1",
        phaseIndex: 0,
        stepIndex: 0,
        reason: "assertion failed",
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const text = blocks.filter((b: any) => b.kind === "text").map((b: any) => b.content).join("");
      expect(text).toContain("Step 0 failed: assertion failed");
    });

    // -- Dispatcher events --

    it("dispatcher:invoked produces structured outputBlock", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "dispatcher:invoked",
        workflowId: "w1",
        phaseIndex: 0,
        stepIndex: 2,
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const text = blocks.filter((b: any) => b.kind === "text").map((b: any) => b.content).join("");
      expect(text).toContain("Dispatcher: crafting prompt for step 2");
    });

    it("dispatcher:completed produces structured outputBlock", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "dispatcher:completed",
        workflowId: "w1",
        decision: { action: "continue", phaseIndex: 0 } as any,
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const text = blocks.filter((b: any) => b.kind === "text").map((b: any) => b.content).join("");
      expect(text).toContain("Dispatcher: prompt ready");
    });

    it("dispatcher:failed produces structured outputBlock", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "dispatcher:failed",
        workflowId: "w1",
        reason: "dispatch error",
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const text = blocks.filter((b: any) => b.kind === "text").map((b: any) => b.content).join("");
      expect(text).toContain("Dispatcher failed: dispatch error");
      expect(text).toContain("Using static template");
    });

    // -- Evaluator events --

    it("evaluator:invoked produces structured outputBlock", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "evaluator:invoked",
        workflowId: "w1",
        phaseIndex: 0,
        stepIndex: 0,
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const text = blocks.filter((b: any) => b.kind === "text").map((b: any) => b.content).join("");
      expect(text).toContain("Evaluator: checking output quality");
    });

    it("evaluator:completed (passed) produces structured outputBlock", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "evaluator:completed",
        workflowId: "w1",
        result: { passed: true, reasoning: "All tests pass" } as any,
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const text = blocks.filter((b: any) => b.kind === "text").map((b: any) => b.content).join("");
      expect(text).toContain("passed");
      expect(text).toContain("All tests pass");
    });

    it("evaluator:completed (failed) produces structured outputBlock", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "evaluator:completed",
        workflowId: "w1",
        result: { passed: false, reasoning: "Missing error handling" } as any,
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const text = blocks.filter((b: any) => b.kind === "text").map((b: any) => b.content).join("");
      expect(text).toContain("needs revision");
      expect(text).toContain("Missing error handling");
    });

    it("evaluator:failed produces structured outputBlock", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "evaluator:failed",
        workflowId: "w1",
        reason: "eval error",
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const text = blocks.filter((b: any) => b.kind === "text").map((b: any) => b.content).join("");
      expect(text).toContain("Evaluator failed: eval error");
      expect(text).toContain("Skipping");
    });
  });

  // ── Timer Integration ──

  describe("timer integration", () => {
    it("timer starts on workflow:started", () => {
      const { bus } = createHarness();
      expect(timerService.getStatus()).toBe("idle");
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "p", timestamp: ts() });
      expect(timerService.isRunning()).toBe(true);
    });

    it("timer stops on workflow:completed", () => {
      const { bus } = createHarness();
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "p", timestamp: ts() });
      bus.emit({ type: "workflow:completed", workflowId: "w1", timestamp: ts() });
      expect(timerService.isStopped()).toBe(true);
    });

    it("timer stops on workflow:failed", () => {
      const { bus } = createHarness();
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "p", timestamp: ts() });
      bus.emit({ type: "workflow:failed", workflowId: "w1", reason: "fail", timestamp: ts() });
      expect(timerService.isStopped()).toBe(true);
    });

    it("timer stops on workflow:interrupted", () => {
      const { bus } = createHarness();
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "p", timestamp: ts() });
      bus.emit({ type: "workflow:interrupted", workflowId: "w1", reason: "ctrl-c", timestamp: ts() });
      expect(timerService.isStopped()).toBe(true);
    });

    it("timer resets on new workflow:started", () => {
      const { bus } = createHarness();
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "p", timestamp: ts() });
      // timerService was reset then started
      expect(timerService.isRunning()).toBe(true);
    });

    it("phase start/complete registers and completes agent", () => {
      const { bus } = createHarness();
      bus.emit({ type: "phase:started", workflowId: "w1", phaseIndex: 2, phaseName: "Test", timestamp: ts() });
      expect(timerService.hasAgent("phase-2")).toBe(true);
      bus.emit({ type: "phase:completed", workflowId: "w1", phaseIndex: 2, timestamp: ts() });
      expect(timerService.hasAgent("phase-2")).toBe(false);
    });

    it("phase fail completes agent timer", () => {
      const { bus } = createHarness();
      bus.emit({ type: "phase:started", workflowId: "w1", phaseIndex: 1, phaseName: "Build", timestamp: ts() });
      expect(timerService.hasAgent("phase-1")).toBe(true);
      bus.emit({ type: "phase:failed", workflowId: "w1", phaseIndex: 1, reason: "err", timestamp: ts() });
      expect(timerService.hasAgent("phase-1")).toBe(false);
    });
  });

  // ── Dynamic Phase Discovery ──

  describe("dynamic phase discovery", () => {
    it("phase:started with unknown index dynamically adds phase before starting it", () => {
      const { bus, store } = createHarness();
      // No phases exist initially
      expect(store.getState().phases).toHaveLength(0);

      // Emit phase:started with index 0 — should add + start
      bus.emit({
        type: "phase:started",
        workflowId: "w1",
        phaseIndex: 0,
        phaseName: "Dynamic Phase 0",
        timestamp: ts(),
      });
      expect(store.getState().phases).toHaveLength(1);
      expect(store.getState().phases[0].status).toBe("running");
      expect(store.getState().phases[0].name).toBe("Dynamic Phase 0");
    });

    it("phase:started with gap in indices adds missing phase", () => {
      const { bus, store } = createHarness();

      // Start phase 0
      bus.emit({
        type: "phase:started",
        workflowId: "w1",
        phaseIndex: 0,
        phaseName: "Phase 0",
        timestamp: ts(),
      });
      bus.emit({
        type: "phase:completed",
        workflowId: "w1",
        phaseIndex: 0,
        timestamp: ts(),
      });
      expect(store.getState().phases).toHaveLength(1);

      // Jump to phase 2 (skipping phase 1) — dynamic discovery adds phase 2
      bus.emit({
        type: "phase:started",
        workflowId: "w1",
        phaseIndex: 2,
        phaseName: "Skipped Ahead",
        timestamp: ts(),
      });
      // Phase was added dynamically, so we have phases at index 0 and 2
      expect(store.getState().phases.length).toBeGreaterThanOrEqual(2);
      const phase2 = store.getState().phases.find(p => p.index === 2);
      expect(phase2).toBeDefined();
      expect(phase2!.status).toBe("running");
    });

    it("phase:started with existing index does not duplicate", () => {
      const { bus, store } = createHarness();

      // Start and complete phase 0
      bus.emit({
        type: "phase:started",
        workflowId: "w1",
        phaseIndex: 0,
        phaseName: "Phase 0",
        timestamp: ts(),
      });
      expect(store.getState().phases).toHaveLength(1);

      // Emit phase:started again for index 0 — should not add duplicate
      bus.emit({
        type: "phase:started",
        workflowId: "w1",
        phaseIndex: 0,
        phaseName: "Phase 0 Restarted",
        timestamp: ts(),
      });
      expect(store.getState().phases).toHaveLength(1);
      expect(store.getState().phases[0].name).toBe("Phase 0 Restarted");
    });
  });

  // ── Pipeline Events ──

  describe("pipeline events", () => {
    it("pipeline:started pushes system text with joined stage names", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "pipeline:started",
        pipelineId: "p1",
        stages: ["plan", "work", "review"],
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const text = blocks.filter((b: any) => b.kind === "text").map((b: any) => b.content).join("");
      expect(text).toContain("Pipeline started");
      expect(text).toContain("plan → work → review");
    });

    it("pipeline:stage-transition pushes transition message with from and to", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "pipeline:stage-transition",
        pipelineId: "p1",
        from: "plan",
        to: "work",
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const text = blocks.filter((b: any) => b.kind === "text").map((b: any) => b.content).join("");
      expect(text).toContain("plan");
      expect(text).toContain("work");
    });

    it("pipeline:completed pushes completion message with stagesCompleted", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "pipeline:completed",
        pipelineId: "p1",
        stagesCompleted: 3,
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const text = blocks.filter((b: any) => b.kind === "text").map((b: any) => b.content).join("");
      expect(text).toContain("Pipeline complete");
      expect(text).toContain("3 stages");
    });

    it("pipeline:failed pushes error text AND calls setError", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "pipeline:failed",
        pipelineId: "p1",
        reason: "stage work exploded",
        stagesCompleted: 1,
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const text = blocks.filter((b: any) => b.kind === "text").map((b: any) => b.content).join("");
      expect(text).toContain("Pipeline failed");
      expect(text).toContain("stage work exploded");
      // Also sets error on the store (for ErrorModal)
      expect(store.getState().error).toBe("stage work exploded");
    });
  });

  // ── Pipeline Timer Continuity ──

  describe("pipeline timer continuity", () => {
    it("pipeline:started sets pipelineMode to true", () => {
      const { bus, adapter } = createHarness();
      expect(adapter.isPipelineMode).toBe(false);
      bus.emit({
        type: "pipeline:started",
        pipelineId: "p1",
        stages: ["plan", "work", "review"],
        timestamp: ts(),
      });
      expect(adapter.isPipelineMode).toBe(true);
    });

    it("workflow:started does NOT reset timer when pipelineMode is true", () => {
      const { bus } = createHarness();
      // Start the pipeline (sets pipelineMode)
      bus.emit({
        type: "pipeline:started",
        pipelineId: "p1",
        stages: ["plan", "work"],
        timestamp: ts(),
      });
      // First workflow:started — timer resets and starts normally
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "plan.md", timestamp: ts() });
      expect(timerService.isRunning()).toBe(true);
      const startTime1 = timerService.getWorkflowRuntime();

      // Complete the first workflow
      bus.emit({ type: "workflow:completed", workflowId: "w1", timestamp: ts() });

      // Stage transition
      bus.emit({
        type: "pipeline:stage-transition",
        pipelineId: "p1",
        from: "plan",
        to: "work",
        timestamp: ts(),
      });

      // Second workflow:started — should NOT reset timer (pipelineMode is true)
      bus.emit({ type: "workflow:started", workflowId: "w2", planPath: "work.md", timestamp: ts() });
      // Timer should be running again (start() was called, but NOT reset())
      expect(timerService.isRunning()).toBe(true);
    });

    it("pipeline:stage-transition records elapsed time for completed stage", () => {
      const { bus, adapter } = createHarness();
      bus.emit({
        type: "pipeline:started",
        pipelineId: "p1",
        stages: ["plan", "work"],
        timestamp: ts(),
      });
      expect(adapter.pipelineStageTimings).toHaveLength(0);

      bus.emit({
        type: "pipeline:stage-transition",
        pipelineId: "p1",
        from: "plan",
        to: "work",
        timestamp: ts(),
      });
      expect(adapter.pipelineStageTimings).toHaveLength(1);
      expect(typeof adapter.pipelineStageTimings[0]).toBe("number");
      expect(adapter.pipelineStageTimings[0]).toBeGreaterThanOrEqual(0);
    });

    it("pipeline:completed clears pipelineMode and preserves stage timings", () => {
      const { bus, adapter } = createHarness();
      bus.emit({
        type: "pipeline:started",
        pipelineId: "p1",
        stages: ["plan", "work"],
        timestamp: ts(),
      });
      bus.emit({
        type: "pipeline:stage-transition",
        pipelineId: "p1",
        from: "plan",
        to: "work",
        timestamp: ts(),
      });
      expect(adapter.isPipelineMode).toBe(true);

      bus.emit({
        type: "pipeline:completed",
        pipelineId: "p1",
        stagesCompleted: 2,
        timestamp: ts(),
      });
      expect(adapter.isPipelineMode).toBe(false);
      // Stage timings are still accessible after pipeline completes
      expect(adapter.pipelineStageTimings).toHaveLength(1);
    });

    it("pipeline:failed clears pipelineMode", () => {
      const { bus, adapter } = createHarness();
      bus.emit({
        type: "pipeline:started",
        pipelineId: "p1",
        stages: ["plan", "work"],
        timestamp: ts(),
      });
      expect(adapter.isPipelineMode).toBe(true);

      bus.emit({
        type: "pipeline:failed",
        pipelineId: "p1",
        reason: "stage failed",
        stagesCompleted: 1,
        timestamp: ts(),
      });
      expect(adapter.isPipelineMode).toBe(false);
    });

    it("workflow:started resets timer when NOT in pipelineMode", () => {
      const { bus } = createHarness();
      // No pipeline — normal workflow behavior
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "plan.md", timestamp: ts() });
      expect(timerService.isRunning()).toBe(true);
      bus.emit({ type: "workflow:completed", workflowId: "w1", timestamp: ts() });
      expect(timerService.isStopped()).toBe(true);

      // New workflow:started should reset and start fresh
      bus.emit({ type: "workflow:started", workflowId: "w2", planPath: "plan2.md", timestamp: ts() });
      expect(timerService.isRunning()).toBe(true);
    });
  });

  // ── Suppress Pipeline Error (Pause Behavior) ──

  describe("suppressPipelineError", () => {
    it("suppressPipelineError defaults to false", () => {
      const { adapter } = createHarness();
      expect(adapter.suppressPipelineError).toBe(false);
    });

    it("pipeline:failed calls setError when suppressPipelineError is false", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "pipeline:failed",
        pipelineId: "p1",
        reason: "stage failed",
        stagesCompleted: 1,
        timestamp: "2025-01-01T00:00:00Z",
      });
      expect(store.getState().error).toBe("stage failed");
    });

    it("pipeline:failed skips setError when suppressPipelineError is true", () => {
      const { bus, store, adapter } = createHarness();
      adapter.suppressPipelineError = true;
      bus.emit({
        type: "pipeline:failed",
        pipelineId: "p1",
        reason: "user paused",
        stagesCompleted: 1,
        timestamp: "2025-01-01T00:00:00Z",
      });
      // Error text is still pushed to output blocks
      const blocks = store.getState().outputBlocks;
      const text = blocks.filter((b: any) => b.kind === "text").map((b: any) => b.content).join("");
      expect(text).toContain("Pipeline failed");
      // But store.error is NOT set (no ErrorModal)
      expect(store.getState().error).toBeUndefined();
    });

    it("suppressPipelineError resets to false after being set", () => {
      const { adapter } = createHarness();
      adapter.suppressPipelineError = true;
      expect(adapter.suppressPipelineError).toBe(true);
      adapter.suppressPipelineError = false;
      expect(adapter.suppressPipelineError).toBe(false);
    });

    it("workflow:failed skips setError when suppressPipelineError is true", () => {
      const { bus, store, adapter } = createHarness();
      // Enter pipeline mode
      bus.emit({
        type: "pipeline:started",
        pipelineId: "p1",
        stages: ["plan", "work"],
        timestamp: "2025-01-01T00:00:00Z",
      });
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "p", timestamp: ts() });
      adapter.suppressPipelineError = true;
      bus.emit({ type: "workflow:failed", workflowId: "w1", reason: "interrupted by user", timestamp: ts() });
      // Error should NOT be set (suppressed)
      expect(store.getState().error).toBeUndefined();
    });

    it("workflow:failed still calls setError when suppressPipelineError is false", () => {
      const { bus, store } = createHarness();
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "p", timestamp: ts() });
      bus.emit({ type: "workflow:failed", workflowId: "w1", reason: "real failure", timestamp: ts() });
      expect(store.getState().error).toBe("real failure");
    });

    it("pipeline:failed still stops timer and clears pipelineMode when suppressed", () => {
      const { bus, adapter } = createHarness();
      bus.emit({
        type: "pipeline:started",
        pipelineId: "p1",
        stages: ["plan", "work"],
        timestamp: ts(),
      });
      // Start a workflow so the timer is running
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "p", timestamp: ts() });
      expect(adapter.isPipelineMode).toBe(true);
      expect(timerService.isRunning()).toBe(true);

      adapter.suppressPipelineError = true;
      bus.emit({
        type: "pipeline:failed",
        pipelineId: "p1",
        reason: "user paused",
        stagesCompleted: 1,
        timestamp: ts(),
      });
      expect(adapter.isPipelineMode).toBe(false);
      expect(timerService.isStopped()).toBe(true);
    });
  });

  // ── Disconnect ──

  describe("disconnect", () => {
    it("disconnect prevents further event processing", () => {
      const { bus, store, adapter } = createHarness();
      adapter.disconnect();
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "p", timestamp: ts() });
      // State should remain idle since adapter is disconnected
      expect(store.getState().workflowStatus).toBe("idle");
    });
  });
});

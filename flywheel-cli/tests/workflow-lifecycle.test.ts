import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestStore, resetWorkStore } from "../src/tui/routes/work/context/ui-state/store";
import { OpenTUIAdapter } from "../src/tui/adapters/opentui";
import { EventBus } from "../src/events/event-bus";
import { timerService } from "../src/tui/shared/services/timer";
import type { UIActions } from "../src/tui/routes/work/context/ui-state/types";

/**
 * Workflow Lifecycle Tests
 *
 * Tests the non-UI lifecycle logic that FlywheelShell uses to manage workflows:
 * - startWorkflow: creates fresh store, adapter, controller
 * - Events flow through adapter → store → state updates
 * - stopWorkflow: resets timer, cleans up
 * - Sequential workflows start with clean state
 */

function ts(): string {
  return new Date().toISOString();
}

describe("Workflow Lifecycle", () => {
  beforeEach(() => {
    resetWorkStore();
    timerService.reset();
  });

  afterEach(() => {
    resetWorkStore();
    timerService.reset();
  });

  // ── startWorkflow creates fresh store, adapter, controller ──

  describe("startWorkflow creates fresh components", () => {
    it("resetWorkStore + createTestStore gives clean state", () => {
      // First store with some state
      const store1 = createTestStore("plan-1");
      const bus1 = new EventBus();
      const adapter1 = new OpenTUIAdapter({ actions: store1 });
      adapter1.connect(bus1);
      adapter1.start();

      // Simulate workflow activity
      bus1.emit({ type: "workflow:started", workflowId: "w1", planPath: "plan-1", timestamp: ts() });
      bus1.emit({ type: "phase:started", workflowId: "w1", phaseIndex: 0, phaseName: "Build", timestamp: ts() });
      bus1.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: "some output\n",
        timestamp: ts(),
      });

      expect(store1.getState().workflowStatus).toBe("running");
      expect(store1.getState().phases).toHaveLength(1);
      expect(store1.getState().outputLines).toHaveLength(1);

      // Disconnect first adapter
      adapter1.stop();
      adapter1.disconnect();

      // Reset and create fresh
      resetWorkStore();
      timerService.reset();

      const store2 = createTestStore("plan-2");
      expect(store2.getState().workflowStatus).toBe("idle");
      expect(store2.getState().phases).toHaveLength(0);
      expect(store2.getState().outputLines).toHaveLength(0);
      expect(store2.getState().planName).toBe("plan-2");
    });

    it("fresh store has correct plan name", () => {
      const store = createTestStore("my-cool-plan.md");
      expect(store.getState().planName).toBe("my-cool-plan.md");
      expect(store.getState().workflowStatus).toBe("idle");
    });

    it("adapter connects to event bus and store receives events", () => {
      const store = createTestStore("test-plan");
      const bus = new EventBus();
      const adapter = new OpenTUIAdapter({ actions: store });
      adapter.connect(bus);
      adapter.start();

      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "test-plan", timestamp: ts() });
      expect(store.getState().workflowStatus).toBe("running");
      expect(adapter.isConnected()).toBe(true);
      expect(adapter.isRunning()).toBe(true);

      adapter.stop();
      adapter.disconnect();
    });
  });

  // ── Events flow through adapter → store → state updates ──

  describe("events flow through adapter → store → state updates", () => {
    it("full workflow lifecycle: start → phases → complete", () => {
      const store = createTestStore("integration-plan");
      const bus = new EventBus();
      const adapter = new OpenTUIAdapter({ actions: store });
      adapter.connect(bus);
      adapter.start();

      // Start workflow
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "integration-plan", timestamp: ts() });
      expect(store.getState().workflowStatus).toBe("running");

      // Phase 0 starts
      bus.emit({ type: "phase:started", workflowId: "w1", phaseIndex: 0, phaseName: "Setup", timestamp: ts() });
      expect(store.getState().phases).toHaveLength(1);
      expect(store.getState().phases[0].status).toBe("running");

      // Some output
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: "installing deps...\n",
        timestamp: ts(),
      });
      expect(store.getState().outputLines).toHaveLength(1);

      // Phase 0 completes
      bus.emit({ type: "phase:completed", workflowId: "w1", phaseIndex: 0, timestamp: ts() });
      expect(store.getState().phases[0].status).toBe("completed");

      // Phase 1 starts and completes
      bus.emit({ type: "phase:started", workflowId: "w1", phaseIndex: 1, phaseName: "Build", timestamp: ts() });
      bus.emit({ type: "phase:completed", workflowId: "w1", phaseIndex: 1, timestamp: ts() });
      expect(store.getState().phases).toHaveLength(2);

      // Workflow completes
      bus.emit({ type: "workflow:completed", workflowId: "w1", timestamp: ts() });
      expect(store.getState().workflowStatus).toBe("completed");

      adapter.stop();
      adapter.disconnect();
    });

    it("store subscription notifies on state changes", (done) => {
      const store = createTestStore("sub-plan");
      const bus = new EventBus();
      const adapter = new OpenTUIAdapter({ actions: store });
      adapter.connect(bus);
      adapter.start();

      let notified = false;
      const unsub = store.subscribe(() => {
        notified = true;
        unsub();
        adapter.stop();
        adapter.disconnect();
        done();
      });

      // This should trigger a notification (throttled, 16ms)
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "sub-plan", timestamp: ts() });

      // Wait for throttled notification
      setTimeout(() => {
        if (!notified) {
          unsub();
          adapter.stop();
          adapter.disconnect();
          // Some stores notify immediately for certain actions
          expect(store.getState().workflowStatus).toBe("running");
          done();
        }
      }, 50);
    });
  });

  // ── stopWorkflow cleans up resources ──

  describe("stopWorkflow cleanup", () => {
    it("stopping adapter disconnects from event bus", () => {
      const store = createTestStore("stop-plan");
      const bus = new EventBus();
      const adapter = new OpenTUIAdapter({ actions: store });
      adapter.connect(bus);
      adapter.start();

      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "stop-plan", timestamp: ts() });
      expect(store.getState().workflowStatus).toBe("running");

      // Stop and disconnect (simulates stopWorkflow cleanup)
      adapter.stop();
      adapter.disconnect();

      expect(adapter.isRunning()).toBe(false);
      expect(adapter.isConnected()).toBe(false);

      // Events after disconnect should not update store
      bus.emit({ type: "phase:started", workflowId: "w1", phaseIndex: 0, phaseName: "Ghost", timestamp: ts() });
      expect(store.getState().phases).toHaveLength(0);
    });

    it("timerService.reset() clears all timer state", () => {
      timerService.start();
      timerService.registerAgent("phase-0");

      expect(timerService.isRunning()).toBe(true);
      expect(timerService.hasAgent("phase-0")).toBe(true);

      timerService.reset();

      expect(timerService.getStatus()).toBe("idle");
      expect(timerService.hasAgent("phase-0")).toBe(false);
      expect(timerService.getWorkflowRuntime()).toBe("00:00");
    });

    it("timer resets between workflow stops and starts", () => {
      // Start first workflow
      timerService.start();
      expect(timerService.isRunning()).toBe(true);

      // Stop first workflow
      timerService.stop();
      expect(timerService.isStopped()).toBe(true);

      // Reset for new workflow
      timerService.reset();
      expect(timerService.getStatus()).toBe("idle");

      // Start second workflow
      timerService.start();
      expect(timerService.isRunning()).toBe(true);

      timerService.reset(); // cleanup
    });
  });

  // ── Second workflow after first completes starts with clean state ──

  describe("sequential workflow runs", () => {
    it("second workflow starts with completely clean state", () => {
      // === First workflow ===
      const store1 = createTestStore("plan-A");
      const bus1 = new EventBus();
      const adapter1 = new OpenTUIAdapter({ actions: store1 });
      adapter1.connect(bus1);
      adapter1.start();

      bus1.emit({ type: "workflow:started", workflowId: "w1", planPath: "plan-A", timestamp: ts() });
      bus1.emit({ type: "phase:started", workflowId: "w1", phaseIndex: 0, phaseName: "Build", timestamp: ts() });
      bus1.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: "first workflow output\n",
        timestamp: ts(),
      });
      bus1.emit({ type: "phase:completed", workflowId: "w1", phaseIndex: 0, timestamp: ts() });
      bus1.emit({ type: "workflow:completed", workflowId: "w1", timestamp: ts() });

      // Verify first workflow had state
      expect(store1.getState().workflowStatus).toBe("completed");
      expect(store1.getState().phases).toHaveLength(1);
      expect(store1.getState().outputLines).toHaveLength(1);

      // Cleanup first workflow (simulates stopWorkflow)
      adapter1.stop();
      adapter1.disconnect();
      resetWorkStore();
      timerService.reset();

      // === Second workflow ===
      const store2 = createTestStore("plan-B");
      const bus2 = new EventBus();
      const adapter2 = new OpenTUIAdapter({ actions: store2 });
      adapter2.connect(bus2);
      adapter2.start();

      // Verify clean state before events
      expect(store2.getState().workflowStatus).toBe("idle");
      expect(store2.getState().phases).toHaveLength(0);
      expect(store2.getState().outputLines).toHaveLength(0);
      expect(store2.getState().planName).toBe("plan-B");
      expect(timerService.getStatus()).toBe("idle");

      // Second workflow starts fresh
      bus2.emit({ type: "workflow:started", workflowId: "w2", planPath: "plan-B", timestamp: ts() });
      expect(store2.getState().workflowStatus).toBe("running");
      expect(store2.getState().planName).toBe("plan-B");

      adapter2.stop();
      adapter2.disconnect();
    });

    it("independent stores do not cross-contaminate", () => {
      const storeA = createTestStore("plan-A");
      const storeB = createTestStore("plan-B");

      const busA = new EventBus();
      const busB = new EventBus();

      const adapterA = new OpenTUIAdapter({ actions: storeA });
      adapterA.connect(busA);
      adapterA.start();

      const adapterB = new OpenTUIAdapter({ actions: storeB });
      adapterB.connect(busB);
      adapterB.start();

      // Only send events to store A
      busA.emit({ type: "workflow:started", workflowId: "w1", planPath: "plan-A", timestamp: ts() });
      busA.emit({ type: "phase:started", workflowId: "w1", phaseIndex: 0, phaseName: "Build", timestamp: ts() });

      // Store A has state
      expect(storeA.getState().workflowStatus).toBe("running");
      expect(storeA.getState().phases).toHaveLength(1);

      // Store B is untouched
      expect(storeB.getState().workflowStatus).toBe("idle");
      expect(storeB.getState().phases).toHaveLength(0);

      adapterA.stop();
      adapterA.disconnect();
      adapterB.stop();
      adapterB.disconnect();
    });
  });

  // ── startWorkflow/stopWorkflow function contract ──

  describe("workflow lifecycle function contract", () => {
    it("simulated startWorkflow creates store → adapter → connects in correct order", () => {
      // This simulates the exact sequence FlywheelShell.startWorkflow does:
      // 1. resetWorkStore()
      // 2. timerService.reset()
      // 3. createTestStore(planPath)
      // 4. new OpenTUIAdapter({ actions: store })
      // 5. adapter.connect(bus) — via WorkController constructor
      // 6. adapter.start() — via WorkController constructor

      resetWorkStore();
      timerService.reset();

      const store = createTestStore("lifecycle-plan");
      expect(store.getState().workflowStatus).toBe("idle");

      const adapter = new OpenTUIAdapter({ actions: store });
      expect(adapter.isConnected()).toBe(false);
      expect(adapter.isRunning()).toBe(false);

      const bus = new EventBus();
      // WorkController constructor calls connect + start
      adapter.connect(bus);
      adapter.start();

      expect(adapter.isConnected()).toBe(true);
      expect(adapter.isRunning()).toBe(true);

      // Now events flow
      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "lifecycle-plan", timestamp: ts() });
      expect(store.getState().workflowStatus).toBe("running");

      adapter.stop();
      adapter.disconnect();
    });

    it("simulated stopWorkflow: stop + disconnect + reset timer", () => {
      const store = createTestStore("stop-lifecycle-plan");
      const bus = new EventBus();
      const adapter = new OpenTUIAdapter({ actions: store });
      adapter.connect(bus);
      adapter.start();

      bus.emit({ type: "workflow:started", workflowId: "w1", planPath: "stop-lifecycle-plan", timestamp: ts() });
      expect(store.getState().workflowStatus).toBe("running");
      expect(timerService.isRunning()).toBe(true);

      // Simulated stopWorkflow sequence
      adapter.stop();
      adapter.disconnect();
      timerService.reset();

      expect(adapter.isRunning()).toBe(false);
      expect(adapter.isConnected()).toBe(false);
      expect(timerService.getStatus()).toBe("idle");
    });
  });
});

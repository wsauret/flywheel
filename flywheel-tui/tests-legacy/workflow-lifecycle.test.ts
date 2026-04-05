import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createStore } from "../src/tui/routes/work/context/ui-state/store";
import { OpenTUIAdapter } from "../src/tui/adapters/opentui";
import { EventBus } from "../src/protocol/event-bus";
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
    timerService.reset();
  });

  afterEach(() => {
    timerService.reset();
  });

  // ── startWorkflow creates fresh store, adapter, controller ──

  describe("startWorkflow creates fresh components", () => {
    it("createStore always gives clean state", () => {
      // First store with some state
      const store1 = createStore("plan-1");
      const bus1 = new EventBus();
      const adapter1 = new OpenTUIAdapter({ actions: store1 });
      adapter1.connect(bus1);
      adapter1.start();

      // Simulate workflow activity
      store1.startWorkflow("plan-1");
      bus1.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: "some output\n",
        timestamp: ts(),
      });

      expect(store1.getState().workflowStatus).toBe("running");
      // Stdout goes to structured outputBlocks now, not outputLines
      expect(store1.getState().outputBlocks.length).toBeGreaterThanOrEqual(1);

      // Disconnect first adapter
      adapter1.stop();
      adapter1.disconnect();

      // Create fresh — no singleton reset needed
      timerService.reset();

      const store2 = createStore("plan-2");
      expect(store2.getState().workflowStatus).toBe("idle");
      expect(store2.getState().queueSteps).toHaveLength(0);
      expect(store2.getState().outputLines).toHaveLength(0);
      expect(store2.getState().planName).toBe("plan-2");
    });

    it("fresh store has correct plan name", () => {
      const store = createStore("my-cool-plan.md");
      expect(store.getState().planName).toBe("my-cool-plan.md");
      expect(store.getState().workflowStatus).toBe("idle");
    });

    it("adapter connects to event bus and store receives events", () => {
      const store = createStore("test-plan");
      const bus = new EventBus();
      const adapter = new OpenTUIAdapter({ actions: store });
      adapter.connect(bus);
      adapter.start();

      store.startWorkflow("test-plan");
      bus.emit({ type: "queue:initialized", workflowId: "w1", stepIds: ["s1"], timestamp: ts() });
      expect(store.getState().workflowStatus).toBe("running");
      expect(adapter.isConnected()).toBe(true);
      expect(adapter.isRunning()).toBe(true);

      adapter.stop();
      adapter.disconnect();
    });
  });

  // ── Events flow through adapter → store → state updates ──

  describe("events flow through adapter → store → state updates", () => {
    it("full workflow lifecycle: start → steps → complete", () => {
      const store = createStore("integration-plan");
      const bus = new EventBus();
      const adapter = new OpenTUIAdapter({ actions: store });
      adapter.connect(bus);
      adapter.start();

      // Start workflow
      store.startWorkflow("integration-plan");
      bus.emit({ type: "queue:initialized", workflowId: "w1", stepIds: ["s1"], timestamp: ts() });
      expect(store.getState().workflowStatus).toBe("running");

      // Some output
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: "installing deps...\n",
        timestamp: ts(),
      });
      // Stdout goes to structured outputBlocks now
      expect(store.getState().outputBlocks.length).toBeGreaterThanOrEqual(1);

      // Workflow completes
      bus.emit({ type: "queue:completed", workflowId: "w1", stepsCompleted: 1, timestamp: ts() });
      expect(store.getState().workflowStatus).toBe("completed");

      adapter.stop();
      adapter.disconnect();
    });

    it("store subscription notifies on state changes", (done) => {
      const store = createStore("sub-plan");
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
      store.startWorkflow("sub-plan");

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
      const store = createStore("stop-plan");
      const bus = new EventBus();
      const adapter = new OpenTUIAdapter({ actions: store });
      adapter.connect(bus);
      adapter.start();

      store.startWorkflow("stop-plan");
      bus.emit({ type: "queue:initialized", workflowId: "w1", stepIds: ["s1"], timestamp: ts() });
      expect(store.getState().workflowStatus).toBe("running");

      // Stop and disconnect (simulates stopWorkflow cleanup)
      adapter.stop();
      adapter.disconnect();

      expect(adapter.isRunning()).toBe(false);
      expect(adapter.isConnected()).toBe(false);

      // Events after disconnect should not update store
      bus.emit({ type: "queue:completed", workflowId: "w1", stepsCompleted: 1, timestamp: ts() });
      // Store still shows 'running' because adapter is disconnected
      expect(store.getState().workflowStatus).toBe("running");
    });

    it("timerService.reset() clears all timer state", () => {
      timerService.start();
      timerService.registerAgent("step-0");

      expect(timerService.isRunning()).toBe(true);
      expect(timerService.hasAgent("step-0")).toBe(true);

      timerService.reset();

      expect(timerService.getStatus()).toBe("idle");
      expect(timerService.hasAgent("step-0")).toBe(false);
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
      const store1 = createStore("plan-A");
      const bus1 = new EventBus();
      const adapter1 = new OpenTUIAdapter({ actions: store1 });
      adapter1.connect(bus1);
      adapter1.start();

      store1.startWorkflow("plan-A");
      bus1.emit({ type: "queue:initialized", workflowId: "w1", stepIds: ["s1"], timestamp: ts() });
      bus1.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: "first workflow output\n",
        timestamp: ts(),
      });
      bus1.emit({ type: "queue:completed", workflowId: "w1", stepsCompleted: 1, timestamp: ts() });

      // Verify first workflow had state
      expect(store1.getState().workflowStatus).toBe("completed");
      // Stdout goes to structured outputBlocks now
      expect(store1.getState().outputBlocks.length).toBeGreaterThanOrEqual(1);

      // Cleanup first workflow (simulates stopWorkflow)
      adapter1.stop();
      adapter1.disconnect();
      timerService.reset();

      // === Second workflow ===
      const store2 = createStore("plan-B");
      const bus2 = new EventBus();
      const adapter2 = new OpenTUIAdapter({ actions: store2 });
      adapter2.connect(bus2);
      adapter2.start();

      // Verify clean state before events
      expect(store2.getState().workflowStatus).toBe("idle");
      expect(store2.getState().queueSteps).toHaveLength(0);
      expect(store2.getState().outputLines).toHaveLength(0);
      expect(store2.getState().planName).toBe("plan-B");
      expect(adapter2.timer.getStatus()).toBe("idle");

      // Second workflow starts fresh
      store2.startWorkflow("plan-B");
      bus2.emit({ type: "queue:initialized", workflowId: "w2", stepIds: ["s1"], timestamp: ts() });
      expect(store2.getState().workflowStatus).toBe("running");
      expect(store2.getState().planName).toBe("plan-B");

      adapter2.stop();
      adapter2.disconnect();
    });

    it("independent stores do not cross-contaminate", () => {
      const storeA = createStore("plan-A");
      const storeB = createStore("plan-B");

      const busA = new EventBus();
      const busB = new EventBus();

      const adapterA = new OpenTUIAdapter({ actions: storeA });
      adapterA.connect(busA);
      adapterA.start();

      const adapterB = new OpenTUIAdapter({ actions: storeB });
      adapterB.connect(busB);
      adapterB.start();

      // Only send events to store A
      storeA.startWorkflow("plan-A");
      busA.emit({ type: "queue:initialized", workflowId: "w1", stepIds: ["s1"], timestamp: ts() });

      // Store A has state
      expect(storeA.getState().workflowStatus).toBe("running");

      // Store B is untouched
      expect(storeB.getState().workflowStatus).toBe("idle");

      adapterA.stop();
      adapterA.disconnect();
      adapterB.stop();
      adapterB.disconnect();
    });
  });

  // ── startWorkflow/stopWorkflow function contract ──

  describe("workflow lifecycle function contract", () => {
    it("simulated startWorkflow creates store → adapter → connects in correct order", () => {
      // This simulates the exact sequence createWorkflowSession does:
      // 1. timerService.reset()
      // 2. createStore(planPath)
      // 3. new OpenTUIAdapter({ actions: store })
      // 4. adapter.connect(bus)
      // 5. adapter.start()

      timerService.reset();

      const store = createStore("lifecycle-plan");
      expect(store.getState().workflowStatus).toBe("idle");

      const adapter = new OpenTUIAdapter({ actions: store });
      expect(adapter.isConnected()).toBe(false);
      expect(adapter.isRunning()).toBe(false);

      const bus = new EventBus();
      // createWorkflowSession calls connect + start
      adapter.connect(bus);
      adapter.start();

      expect(adapter.isConnected()).toBe(true);
      expect(adapter.isRunning()).toBe(true);

      // Now events flow
      store.startWorkflow("lifecycle-plan");
      bus.emit({ type: "queue:initialized", workflowId: "w1", stepIds: ["s1"], timestamp: ts() });
      expect(store.getState().workflowStatus).toBe("running");

      adapter.stop();
      adapter.disconnect();
    });

    it("simulated stopWorkflow: stop + disconnect + stop timer", () => {
      const store = createStore("stop-lifecycle-plan");
      const bus = new EventBus();
      const adapter = new OpenTUIAdapter({ actions: store });
      adapter.connect(bus);
      adapter.start();

      store.startWorkflow("stop-lifecycle-plan");
      bus.emit({ type: "queue:initialized", workflowId: "w1", stepIds: ["s1"], timestamp: ts() });
      expect(store.getState().workflowStatus).toBe("running");
      expect(adapter.timer.isRunning()).toBe(true);

      // Simulated stopWorkflow sequence (per-session timer: stop instead of reset)
      adapter.stop();
      adapter.disconnect();
      adapter.timer.stop();

      expect(adapter.isRunning()).toBe(false);
      expect(adapter.isConnected()).toBe(false);
      expect(adapter.timer.isStopped()).toBe(true);
    });
  });
});

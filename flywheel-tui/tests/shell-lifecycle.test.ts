import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
// Store is now factory-based (no singleton to reset)
import { timerService } from "../src/tui/shared/services/timer";
import {
  createWorkflowSession,
  destroyWorkflowSession,
  type WorkflowSession,
} from "../src/tui/components/workflow-session";

/**
 * Shell Lifecycle Tests
 *
 * Tests the workflow session management functions used by FlywheelShell:
 * - createWorkflowSession: creates fresh store, adapter (no controller — that needs real config)
 * - destroyWorkflowSession: disconnects adapter, resets timer
 * - Sequential sessions start clean
 */

function ts(): string {
  return new Date().toISOString();
}

describe("Shell Lifecycle (workflow-session)", () => {
  beforeEach(() => {
    timerService.reset();
  });

  afterEach(() => {
    timerService.reset();
  });

  describe("createWorkflowSession", () => {
    it("returns session with store, adapter, and eventBus", () => {
      const session = createWorkflowSession("test-plan.md");

      expect(session).toBeDefined();
      expect(session.store).toBeDefined();
      expect(session.adapter).toBeDefined();
      expect(session.eventBus).toBeDefined();
      expect(session.planPath).toBe("test-plan.md");

      // Adapter should be connected and started
      expect(session.adapter.isConnected()).toBe(true);
      expect(session.adapter.isRunning()).toBe(true);

      // Store should be clean
      expect(session.store.getState().workflowStatus).toBe("idle");
      expect(session.store.getState().queueSteps).toHaveLength(0);
      expect(session.store.getState().outputLines).toHaveLength(0);

      destroyWorkflowSession(session);
    });

    it("creates session with fresh per-session timer", () => {
      // Dirty up the global timer (should not affect the session's timer)
      timerService.start();
      timerService.registerAgent("leftover-agent");
      expect(timerService.isRunning()).toBe(true);

      const session = createWorkflowSession("fresh.md");

      // Session has its own fresh timer (idle, no leftover agents)
      expect(session.timer.getStatus()).toBe("idle");
      expect(session.timer.hasAgent("leftover-agent")).toBe(false);

      destroyWorkflowSession(session);
    });

    it("events flow through session's event bus to store", () => {
      const session = createWorkflowSession("event-flow.md");

      session.store.startWorkflow("event-flow.md");
      session.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });

      expect(session.store.getState().workflowStatus).toBe("running");

      destroyWorkflowSession(session);
    });
  });

  describe("destroyWorkflowSession", () => {
    it("disconnects adapter and stops timer", () => {
      const session = createWorkflowSession("destroy-test.md");

      // Start workflow to get timer running
      session.store.startWorkflow("destroy-test.md");
      session.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });
      expect(session.timer.isRunning()).toBe(true);
      expect(session.adapter.isConnected()).toBe(true);

      destroyWorkflowSession(session);

      expect(session.adapter.isRunning()).toBe(false);
      expect(session.adapter.isConnected()).toBe(false);
      expect(session.timer.isStopped()).toBe(true);
    });

    it("events after destroy do not reach store", () => {
      const session = createWorkflowSession("post-destroy.md");

      session.store.startWorkflow("post-destroy.md");
      session.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });
      expect(session.store.getState().workflowStatus).toBe("running");

      destroyWorkflowSession(session);

      // Events after destroy should not update store
      session.eventBus.emit({
        type: "queue:completed",
        workflowId: "w1",
        stepsCompleted: 1,
        timestamp: ts(),
      });
      // Store still shows 'running' because adapter is disconnected
      expect(session.store.getState().workflowStatus).toBe("running");
    });
  });

  describe("sequential sessions", () => {
    it("second session starts with completely clean state", () => {
      // First session
      const session1 = createWorkflowSession("plan-A.md");
      session1.store.startWorkflow("plan-A.md");
      session1.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });
      session1.eventBus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: "first run output\n",
        timestamp: ts(),
      });
      session1.eventBus.emit({
        type: "queue:completed",
        workflowId: "w1",
        stepsCompleted: 1,
        timestamp: ts(),
      });

      expect(session1.store.getState().workflowStatus).toBe("completed");

      destroyWorkflowSession(session1);

      // Second session
      const session2 = createWorkflowSession("plan-B.md");

      expect(session2.store.getState().workflowStatus).toBe("idle");
      expect(session2.store.getState().queueSteps).toHaveLength(0);
      expect(session2.store.getState().outputLines).toHaveLength(0);
      expect(session2.store.getState().planName).toBe("plan-B.md");
      expect(session2.timer.getStatus()).toBe("idle");

      // Second session works independently
      session2.store.startWorkflow("plan-B.md");
      session2.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w2",
        stepIds: ["s1"],
        timestamp: ts(),
      });
      expect(session2.store.getState().workflowStatus).toBe("running");

      destroyWorkflowSession(session2);
    });

    it("destroying one session does not affect a fresh session", () => {
      const session1 = createWorkflowSession("old.md");
      session1.store.startWorkflow("old.md");
      session1.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });
      destroyWorkflowSession(session1);

      const session2 = createWorkflowSession("new.md");
      expect(session2.store.getState().workflowStatus).toBe("idle");
      expect(session2.adapter.isConnected()).toBe(true);

      destroyWorkflowSession(session2);
    });
  });
});

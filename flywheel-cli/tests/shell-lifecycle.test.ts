import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resetWorkStore } from "../src/tui/routes/work/context/ui-state/store";
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
    resetWorkStore();
    timerService.reset();
  });

  afterEach(() => {
    resetWorkStore();
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
      expect(session.store.getState().phases).toHaveLength(0);
      expect(session.store.getState().outputLines).toHaveLength(0);

      destroyWorkflowSession(session);
    });

    it("clears singleton and timer before creating", () => {
      // Dirty up the timer
      timerService.start();
      timerService.registerAgent("leftover-agent");
      expect(timerService.isRunning()).toBe(true);

      const session = createWorkflowSession("fresh.md");

      // Timer should have been reset (it's idle after reset, not running — 
      // running only starts when workflow:started event fires)
      expect(timerService.getStatus()).toBe("idle");
      expect(timerService.hasAgent("leftover-agent")).toBe(false);

      destroyWorkflowSession(session);
    });

    it("events flow through session's event bus to store", () => {
      const session = createWorkflowSession("event-flow.md");

      session.eventBus.emit({
        type: "workflow:started",
        workflowId: "w1",
        planPath: "event-flow.md",
        timestamp: ts(),
      });

      expect(session.store.getState().workflowStatus).toBe("running");

      session.eventBus.emit({
        type: "phase:started",
        workflowId: "w1",
        phaseIndex: 0,
        phaseName: "Build",
        timestamp: ts(),
      });

      expect(session.store.getState().phases).toHaveLength(1);
      expect(session.store.getState().phases[0].status).toBe("running");

      destroyWorkflowSession(session);
    });
  });

  describe("destroyWorkflowSession", () => {
    it("disconnects adapter and resets timer", () => {
      const session = createWorkflowSession("destroy-test.md");

      // Start workflow to get timer running
      session.eventBus.emit({
        type: "workflow:started",
        workflowId: "w1",
        planPath: "destroy-test.md",
        timestamp: ts(),
      });
      expect(timerService.isRunning()).toBe(true);
      expect(session.adapter.isConnected()).toBe(true);

      destroyWorkflowSession(session);

      expect(session.adapter.isRunning()).toBe(false);
      expect(session.adapter.isConnected()).toBe(false);
      expect(timerService.getStatus()).toBe("idle");
    });

    it("events after destroy do not reach store", () => {
      const session = createWorkflowSession("post-destroy.md");

      session.eventBus.emit({
        type: "workflow:started",
        workflowId: "w1",
        planPath: "post-destroy.md",
        timestamp: ts(),
      });
      expect(session.store.getState().workflowStatus).toBe("running");

      destroyWorkflowSession(session);

      // Events after destroy should not update store
      session.eventBus.emit({
        type: "phase:started",
        workflowId: "w1",
        phaseIndex: 0,
        phaseName: "Ghost",
        timestamp: ts(),
      });
      expect(session.store.getState().phases).toHaveLength(0);
    });
  });

  describe("sequential sessions", () => {
    it("second session starts with completely clean state", () => {
      // First session
      const session1 = createWorkflowSession("plan-A.md");
      session1.eventBus.emit({
        type: "workflow:started",
        workflowId: "w1",
        planPath: "plan-A.md",
        timestamp: ts(),
      });
      session1.eventBus.emit({
        type: "phase:started",
        workflowId: "w1",
        phaseIndex: 0,
        phaseName: "Build",
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
        type: "workflow:completed",
        workflowId: "w1",
        timestamp: ts(),
      });

      expect(session1.store.getState().workflowStatus).toBe("completed");
      expect(session1.store.getState().phases).toHaveLength(1);

      destroyWorkflowSession(session1);

      // Second session
      const session2 = createWorkflowSession("plan-B.md");

      expect(session2.store.getState().workflowStatus).toBe("idle");
      expect(session2.store.getState().phases).toHaveLength(0);
      expect(session2.store.getState().outputLines).toHaveLength(0);
      expect(session2.store.getState().planName).toBe("plan-B.md");
      expect(timerService.getStatus()).toBe("idle");

      // Second session works independently
      session2.eventBus.emit({
        type: "workflow:started",
        workflowId: "w2",
        planPath: "plan-B.md",
        timestamp: ts(),
      });
      expect(session2.store.getState().workflowStatus).toBe("running");

      destroyWorkflowSession(session2);
    });

    it("destroying one session does not affect a fresh session", () => {
      const session1 = createWorkflowSession("old.md");
      session1.eventBus.emit({
        type: "workflow:started",
        workflowId: "w1",
        planPath: "old.md",
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

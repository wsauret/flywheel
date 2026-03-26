// ---------------------------------------------------------------------------
// Tests for queue and step lifecycle event types (VAL-QUEUE-030, VAL-QUEUE-031)
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "bun:test";
import { EventBus, createFlywheelEmitter } from "../src/events/event-bus";
import type { FlywheelEmitter } from "../src/events/event-bus";
import type {
  FlywheelEvent,
  QueueInitialized,
  QueueCompleted,
  QueueFailed,
  QueueStepStarted,
  QueueStepCompleted,
  QueueStepFailed,
  QueueStepInserted,
  QueueStepRemoved,
} from "../src/events/types";

describe("Queue event types", () => {
  let bus: EventBus;
  let emitter: FlywheelEmitter;
  let received: FlywheelEvent[];

  beforeEach(() => {
    bus = new EventBus();
    emitter = createFlywheelEmitter(bus);
    received = [];
    bus.subscribe((e) => received.push(e));
  });

  // ── QueueInitialized (VAL-QUEUE-031) ──

  describe("queue:initialized", () => {
    it("emits QueueInitialized with workflowId and stepIds", () => {
      emitter.queueInitialized("wf-1", ["s1", "s2", "s3"]);
      expect(received).toHaveLength(1);
      const e = received[0] as QueueInitialized;
      expect(e.type).toBe("queue:initialized");
      expect(e.workflowId).toBe("wf-1");
      expect(e.stepIds).toEqual(["s1", "s2", "s3"]);
      expect(typeof e.timestamp).toBe("string");
    });

    it("can subscribe to queue:initialized specifically", () => {
      const specific: FlywheelEvent[] = [];
      bus.subscribeToType("queue:initialized", (e) => specific.push(e));
      emitter.queueInitialized("wf-1", ["s1"]);
      emitter.workflowStarted("wf-1", "/some/plan");
      expect(specific).toHaveLength(1);
      expect(specific[0].type).toBe("queue:initialized");
    });
  });

  // ── QueueCompleted (VAL-QUEUE-031) ──

  describe("queue:completed", () => {
    it("emits QueueCompleted with workflowId and stepsCompleted", () => {
      emitter.queueCompleted("wf-2", 5);
      expect(received).toHaveLength(1);
      const e = received[0] as QueueCompleted;
      expect(e.type).toBe("queue:completed");
      expect(e.workflowId).toBe("wf-2");
      expect(e.stepsCompleted).toBe(5);
      expect(typeof e.timestamp).toBe("string");
    });
  });

  // ── QueueFailed (VAL-QUEUE-031) ──

  describe("queue:failed", () => {
    it("emits QueueFailed with reason and stepsCompleted", () => {
      emitter.queueFailed("wf-3", "worker crashed", 2);
      expect(received).toHaveLength(1);
      const e = received[0] as QueueFailed;
      expect(e.type).toBe("queue:failed");
      expect(e.workflowId).toBe("wf-3");
      expect(e.reason).toBe("worker crashed");
      expect(e.stepsCompleted).toBe(2);
      expect(typeof e.timestamp).toBe("string");
    });
  });

  // ── QueueStepStarted (VAL-QUEUE-030) ──

  describe("queue:step-started", () => {
    it("emits QueueStepStarted with stepId, stepType, and stepTitle", () => {
      emitter.queueStepStarted("wf-4", "step-uuid-1", "work", "Implement feature X");
      expect(received).toHaveLength(1);
      const e = received[0] as QueueStepStarted;
      expect(e.type).toBe("queue:step-started");
      expect(e.workflowId).toBe("wf-4");
      expect(e.stepId).toBe("step-uuid-1");
      expect(e.stepType).toBe("work");
      expect(e.stepTitle).toBe("Implement feature X");
      expect(typeof e.timestamp).toBe("string");
    });
  });

  // ── QueueStepCompleted (VAL-QUEUE-030) ──

  describe("queue:step-completed", () => {
    it("emits QueueStepCompleted with stepId, stepType, and stepTitle", () => {
      emitter.queueStepCompleted("wf-5", "step-uuid-2", "plan", "Create plan");
      expect(received).toHaveLength(1);
      const e = received[0] as QueueStepCompleted;
      expect(e.type).toBe("queue:step-completed");
      expect(e.workflowId).toBe("wf-5");
      expect(e.stepId).toBe("step-uuid-2");
      expect(e.stepType).toBe("plan");
      expect(e.stepTitle).toBe("Create plan");
      expect(typeof e.timestamp).toBe("string");
    });
  });

  // ── QueueStepFailed (VAL-QUEUE-030) ──

  describe("queue:step-failed", () => {
    it("emits QueueStepFailed with stepId, stepType, stepTitle, and reason", () => {
      emitter.queueStepFailed("wf-6", "step-uuid-3", "review", "Review changes", "timeout");
      expect(received).toHaveLength(1);
      const e = received[0] as QueueStepFailed;
      expect(e.type).toBe("queue:step-failed");
      expect(e.workflowId).toBe("wf-6");
      expect(e.stepId).toBe("step-uuid-3");
      expect(e.stepType).toBe("review");
      expect(e.stepTitle).toBe("Review changes");
      expect(e.reason).toBe("timeout");
      expect(typeof e.timestamp).toBe("string");
    });
  });

  // ── QueueStepInserted ──

  describe("queue:step-inserted", () => {
    it("emits QueueStepInserted with position info", () => {
      emitter.queueStepInserted("wf-7", "new-step-1", "verify", "Verify output", "step-uuid-2");
      expect(received).toHaveLength(1);
      const e = received[0] as QueueStepInserted;
      expect(e.type).toBe("queue:step-inserted");
      expect(e.workflowId).toBe("wf-7");
      expect(e.stepId).toBe("new-step-1");
      expect(e.stepType).toBe("verify");
      expect(e.stepTitle).toBe("Verify output");
      expect(e.afterStepId).toBe("step-uuid-2");
      expect(typeof e.timestamp).toBe("string");
    });
  });

  // ── QueueStepRemoved ──

  describe("queue:step-removed", () => {
    it("emits QueueStepRemoved with step info", () => {
      emitter.queueStepRemoved("wf-8", "step-uuid-4", "gate", "Approval gate");
      expect(received).toHaveLength(1);
      const e = received[0] as QueueStepRemoved;
      expect(e.type).toBe("queue:step-removed");
      expect(e.workflowId).toBe("wf-8");
      expect(e.stepId).toBe("step-uuid-4");
      expect(e.stepType).toBe("gate");
      expect(e.stepTitle).toBe("Approval gate");
      expect(typeof e.timestamp).toBe("string");
    });
  });

  // ── Existing events still work ──

  describe("existing events preserved", () => {
    it("old step events still emit correctly", () => {
      bus.emit({
        type: "step:started",
        workflowId: "wf-1",
        stepIndex: 0,
        description: "Old step",
        timestamp: new Date().toISOString(),
      });
      expect(received).toHaveLength(1);
      expect(received[0].type).toBe("step:started");
    });
  });
});

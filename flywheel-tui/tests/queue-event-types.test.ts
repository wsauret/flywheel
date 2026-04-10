// ---------------------------------------------------------------------------
// Tests for queue and step lifecycle event types (VAL-QUEUE-030, VAL-QUEUE-031)
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "bun:test";
import { EventBus, createEmit, type EmitFn } from "../src/infra/event-bus";
import type {
  FlywheelEvent,
  QueueInitialized,
  QueueCompleted,
  QueueFailed,
  QueueStepStarted,
  QueueStepCompleted,
  QueueStepFailed,
} from "../src/infra/events";

describe("Queue event types", () => {
  let bus: EventBus;
  let emit: EmitFn;
  let received: FlywheelEvent[];

  beforeEach(() => {
    bus = new EventBus();
    emit = createEmit(bus);
    received = [];
    bus.subscribe((e) => received.push(e));
  });

  // ── QueueInitialized (VAL-QUEUE-031) ──

  describe("queue:initialized", () => {
    it("emits QueueInitialized with workflowId and stepIds", () => {
      emit("queue:initialized", { workflowId: "wf-1", stepIds: ["s1", "s2", "s3"] });
      expect(received).toHaveLength(1);
      const e = received[0] as QueueInitialized;
      expect(e.type).toBe("queue:initialized");
      expect(e.workflowId).toBe("wf-1");
      expect(e.stepIds).toEqual(["s1", "s2", "s3"]);
      expect(typeof e.timestamp).toBe("number");
    });

    it("can subscribe to queue:initialized specifically", () => {
      const specific: FlywheelEvent[] = [];
      bus.subscribeToType("queue:initialized", (e) => specific.push(e));
      emit("queue:initialized", { workflowId: "wf-1", stepIds: ["s1"] });
      emit("subprocess:spawned", { workflowId: "wf-1", stepIndex: 0 });
      expect(specific).toHaveLength(1);
      expect(specific[0].type).toBe("queue:initialized");
    });
  });

  // ── QueueCompleted (VAL-QUEUE-031) ──

  describe("queue:completed", () => {
    it("emits QueueCompleted with workflowId and stepsCompleted", () => {
      emit("queue:completed", { workflowId: "wf-2", stepsCompleted: 5 });
      expect(received).toHaveLength(1);
      const e = received[0] as QueueCompleted;
      expect(e.type).toBe("queue:completed");
      expect(e.workflowId).toBe("wf-2");
      expect(e.stepsCompleted).toBe(5);
      expect(typeof e.timestamp).toBe("number");
    });
  });

  // ── QueueFailed (VAL-QUEUE-031) ──

  describe("queue:failed", () => {
    it("emits QueueFailed with reason and stepsCompleted", () => {
      emit("queue:failed", { workflowId: "wf-3", reason: "worker crashed", stepsCompleted: 2 });
      expect(received).toHaveLength(1);
      const e = received[0] as QueueFailed;
      expect(e.type).toBe("queue:failed");
      expect(e.workflowId).toBe("wf-3");
      expect(e.reason).toBe("worker crashed");
      expect(e.stepsCompleted).toBe(2);
      expect(typeof e.timestamp).toBe("number");
    });
  });

  // ── QueueStepStarted (VAL-QUEUE-030) ──

  describe("queue:step-started", () => {
    it("emits QueueStepStarted with stepId, stepType, and stepTitle", () => {
      emit("queue:step-started", { workflowId: "wf-4", stepId: "step-uuid-1", stepType: "work", stepTitle: "Implement feature X" });
      expect(received).toHaveLength(1);
      const e = received[0] as QueueStepStarted;
      expect(e.type).toBe("queue:step-started");
      expect(e.workflowId).toBe("wf-4");
      expect(e.stepId).toBe("step-uuid-1");
      expect(e.stepType).toBe("work");
      expect(e.stepTitle).toBe("Implement feature X");
      expect(typeof e.timestamp).toBe("number");
    });
  });

  // ── QueueStepCompleted (VAL-QUEUE-030) ──

  describe("queue:step-completed", () => {
    it("emits QueueStepCompleted with stepId, stepType, and stepTitle", () => {
      emit("queue:step-completed", { workflowId: "wf-5", stepId: "step-uuid-2", stepType: "plan", stepTitle: "Create plan" });
      expect(received).toHaveLength(1);
      const e = received[0] as QueueStepCompleted;
      expect(e.type).toBe("queue:step-completed");
      expect(e.workflowId).toBe("wf-5");
      expect(e.stepId).toBe("step-uuid-2");
      expect(e.stepType).toBe("plan");
      expect(e.stepTitle).toBe("Create plan");
      expect(typeof e.timestamp).toBe("number");
    });
  });

  // ── QueueStepFailed (VAL-QUEUE-030) ──

  describe("queue:step-failed", () => {
    it("emits QueueStepFailed with stepId, stepType, stepTitle, and reason", () => {
      emit("queue:step-failed", { workflowId: "wf-6", stepId: "step-uuid-3", stepType: "review", stepTitle: "Review changes", reason: "timeout" });
      expect(received).toHaveLength(1);
      const e = received[0] as QueueStepFailed;
      expect(e.type).toBe("queue:step-failed");
      expect(e.workflowId).toBe("wf-6");
      expect(e.stepId).toBe("step-uuid-3");
      expect(e.stepType).toBe("review");
      expect(e.stepTitle).toBe("Review changes");
      expect(e.reason).toBe("timeout");
      expect(typeof e.timestamp).toBe("number");
    });
  });

  // ── Existing events still work ──

  describe("existing events preserved", () => {
    it("queue step events still emit correctly", () => {
      emit("queue:step-started", { workflowId: "wf-1", stepId: "step-0", stepType: "work", stepTitle: "Old step" });
      expect(received).toHaveLength(1);
      expect(received[0].type).toBe("queue:step-started");
    });
  });
});

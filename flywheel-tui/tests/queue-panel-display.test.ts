import { describe, it, expect } from "bun:test";
import {
  computeQueueProgress,
  getStepStatusIcon,
  getStepTypeLabel,
} from "../src/tui/components/workflow-panel-logic";
import type { QueueStepState } from "../src/tui/routes/work/state/types";

// ---------------------------------------------------------------------------
// computeQueueProgress
// ---------------------------------------------------------------------------

describe("computeQueueProgress", () => {
  it("counts all step statuses correctly", () => {
    const steps: QueueStepState[] = [
      { id: "1", type: "plan", title: "Plan", status: "completed" },
      { id: "2", type: "work", title: "Work 1", status: "running" },
      { id: "3", type: "work", title: "Work 2", status: "failed", error: "oops" },
      { id: "4", type: "review", title: "Review", status: "pending" },
      { id: "5", type: "gate", title: "Gate", status: "skipped" },
    ];
    const result = computeQueueProgress(steps);
    expect(result.completed).toBe(1);
    expect(result.running).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(5);
  });

  it("returns zeros for empty steps", () => {
    const result = computeQueueProgress([]);
    expect(result.completed).toBe(0);
    expect(result.running).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(0);
  });

  it("counts all completed steps", () => {
    const steps: QueueStepState[] = [
      { id: "1", type: "plan", title: "Plan", status: "completed" },
      { id: "2", type: "work", title: "Work", status: "completed" },
    ];
    const result = computeQueueProgress(steps);
    expect(result.completed).toBe(2);
    expect(result.total).toBe(2);
    expect(result.running).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("handles skipped steps (not counted as completed/running/failed)", () => {
    const steps: QueueStepState[] = [
      { id: "1", type: "plan", title: "Plan", status: "completed" },
      { id: "2", type: "gate", title: "Gate", status: "skipped" },
      { id: "3", type: "work", title: "Work", status: "pending" },
    ];
    const result = computeQueueProgress(steps);
    expect(result.completed).toBe(1);
    expect(result.total).toBe(3);
    expect(result.running).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("progress summary Steps: X/Y is accurate", () => {
    const steps: QueueStepState[] = [
      { id: "1", type: "plan", title: "Plan", status: "completed" },
      { id: "2", type: "work", title: "Work 1", status: "completed" },
      { id: "3", type: "work", title: "Work 2", status: "running" },
      { id: "4", type: "review", title: "Review", status: "pending" },
    ];
    const result = computeQueueProgress(steps);
    expect(result.completed).toBe(2);
    expect(result.total).toBe(4);
    // Panel would display "Steps: 2/4"
  });
});

// ---------------------------------------------------------------------------
// getStepStatusIcon
// ---------------------------------------------------------------------------

describe("getStepStatusIcon", () => {
  it("returns ○ for pending", () => {
    expect(getStepStatusIcon("pending")).toBe("○");
  });

  it("returns spinner placeholder for running", () => {
    // Running uses Spinner component, but icon fallback is ◐
    expect(getStepStatusIcon("running")).toBe("◐");
  });

  it("returns ✓ for completed", () => {
    expect(getStepStatusIcon("completed")).toBe("✓");
  });

  it("returns ✗ for failed", () => {
    expect(getStepStatusIcon("failed")).toBe("✗");
  });

  it("returns ⊘ for skipped", () => {
    expect(getStepStatusIcon("skipped")).toBe("⊘");
  });

  it("all 5 statuses have distinct icons", () => {
    const icons = new Set([
      getStepStatusIcon("pending"),
      getStepStatusIcon("running"),
      getStepStatusIcon("completed"),
      getStepStatusIcon("failed"),
      getStepStatusIcon("skipped"),
    ]);
    expect(icons.size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// getStepTypeLabel
// ---------------------------------------------------------------------------

describe("getStepTypeLabel", () => {
  it("capitalizes plan", () => {
    expect(getStepTypeLabel("plan")).toBe("Plan");
  });

  it("capitalizes work", () => {
    expect(getStepTypeLabel("work")).toBe("Work");
  });

  it("capitalizes review", () => {
    expect(getStepTypeLabel("review")).toBe("Review");
  });

  it("capitalizes ship", () => {
    expect(getStepTypeLabel("ship")).toBe("Ship");
  });

  it("capitalizes debug", () => {
    expect(getStepTypeLabel("debug")).toBe("Debug");
  });

  it("capitalizes research", () => {
    expect(getStepTypeLabel("research")).toBe("Research");
  });

  it("capitalizes verify", () => {
    expect(getStepTypeLabel("verify")).toBe("Verify");
  });

  it("capitalizes gate", () => {
    expect(getStepTypeLabel("gate")).toBe("Gate");
  });
});

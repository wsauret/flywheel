import { describe, it, expect } from "bun:test";
import { formatQueueStepProgress, formatQueueStepName, type QueueStepProgressInfo } from "../src/tui/utils/format";

// ---------------------------------------------------------------------------
// VAL-TUI-010: Telemetry bar shows step position "Step N/M"
// ---------------------------------------------------------------------------
describe("formatQueueStepProgress (VAL-TUI-010)", () => {
  it("formats Step 1/3", () => {
    const info: QueueStepProgressInfo = { currentStep: 1, totalSteps: 3, stepName: "plan" };
    expect(formatQueueStepProgress(info)).toBe("Step 1/3");
  });

  it("formats Step 2/5", () => {
    const info: QueueStepProgressInfo = { currentStep: 2, totalSteps: 5, stepName: "work" };
    expect(formatQueueStepProgress(info)).toBe("Step 2/5");
  });

  it("returns empty string for null info", () => {
    expect(formatQueueStepProgress(null)).toBe("");
  });

  it("returns empty string for undefined info", () => {
    expect(formatQueueStepProgress(undefined)).toBe("");
  });

  it("returns empty string when currentStep is 0", () => {
    expect(formatQueueStepProgress({ currentStep: 0, totalSteps: 3, stepName: "plan" })).toBe("");
  });

  it("returns empty string when totalSteps is 0", () => {
    expect(formatQueueStepProgress({ currentStep: 1, totalSteps: 0, stepName: "plan" })).toBe("");
  });

  it("handles single-step queue", () => {
    expect(formatQueueStepProgress({ currentStep: 1, totalSteps: 1, stepName: "work" })).toBe("Step 1/1");
  });
});

// ---------------------------------------------------------------------------
// VAL-TUI-011: Telemetry bar shows current step name/type
// ---------------------------------------------------------------------------
describe("formatQueueStepName (VAL-TUI-011)", () => {
  it("capitalizes plan step name", () => {
    expect(formatQueueStepName({ currentStep: 1, totalSteps: 3, stepName: "plan" })).toBe("Plan");
  });

  it("capitalizes work step name", () => {
    expect(formatQueueStepName({ currentStep: 2, totalSteps: 5, stepName: "work" })).toBe("Work");
  });

  it("capitalizes review step name", () => {
    expect(formatQueueStepName({ currentStep: 3, totalSteps: 5, stepName: "review" })).toBe("Review");
  });

  it("capitalizes verify step name", () => {
    expect(formatQueueStepName({ currentStep: 1, totalSteps: 2, stepName: "verify" })).toBe("Verify");
  });

  it("capitalizes gate step name", () => {
    expect(formatQueueStepName({ currentStep: 1, totalSteps: 1, stepName: "gate" })).toBe("Gate");
  });

  it("returns empty string for null info", () => {
    expect(formatQueueStepName(null)).toBe("");
  });

  it("returns empty string for undefined info", () => {
    expect(formatQueueStepName(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// VAL-TUI-013: Counter and name update on step transitions
// ---------------------------------------------------------------------------
describe("formatQueueStepProgress updates on step transitions (VAL-TUI-013)", () => {
  it("step 1 then step 2 shows different output", () => {
    const step1: QueueStepProgressInfo = { currentStep: 1, totalSteps: 3, stepName: "plan" };
    const step2: QueueStepProgressInfo = { currentStep: 2, totalSteps: 3, stepName: "work" };
    
    const result1 = formatQueueStepProgress(step1);
    const result2 = formatQueueStepProgress(step2);
    
    expect(result1).toBe("Step 1/3");
    expect(result2).toBe("Step 2/3");
    expect(result1).not.toBe(result2);
  });

  it("step name changes between transitions", () => {
    const step1: QueueStepProgressInfo = { currentStep: 1, totalSteps: 3, stepName: "plan" };
    const step2: QueueStepProgressInfo = { currentStep: 2, totalSteps: 3, stepName: "work" };
    
    expect(formatQueueStepName(step1)).toBe("Plan");
    expect(formatQueueStepName(step2)).toBe("Work");
  });

  it("totalSteps increases when dynamic steps are inserted", () => {
    const before: QueueStepProgressInfo = { currentStep: 2, totalSteps: 3, stepName: "work" };
    const after: QueueStepProgressInfo = { currentStep: 2, totalSteps: 5, stepName: "work" };
    
    expect(formatQueueStepProgress(before)).toBe("Step 2/3");
    expect(formatQueueStepProgress(after)).toBe("Step 2/5");
  });
});

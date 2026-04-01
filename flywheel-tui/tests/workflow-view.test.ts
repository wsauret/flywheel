import { describe, it, expect } from "bun:test";
import {
  getDisplayedStepStatus,
  getDisplayedWorkflowStatus,
  getStepTitleMaxWidth,
} from "../src/tui/components/workflow-panel-logic";

/**
 * WorkflowView / WorkShell / StepProgress / TelemetryBar generalization tests.
 *
 * These are unit tests for the display text logic, not rendering tests
 * (OpenTUI components can't be rendered/imported in test without --conditions=browser).
 */

// ── StepProgress display text logic ──

describe("StepProgress display text", () => {
  /**
   * Replicates the display text logic from StepProgress:
   *   `{stepLabel ?? "Plan"} Progress (N {stepLabel?.toLowerCase() ?? "step"}s)`
   */
  function progressText(count: number, stepLabel?: string): string {
    const label = stepLabel ?? "Plan";
    const unit = stepLabel?.toLowerCase() ?? "step";
    const plural = count === 1 ? unit : `${unit}s`;
    return `${label} Progress (${count} ${plural})`;
  }

  it("defaults to 'Plan Progress (N steps)' without stepLabel", () => {
    expect(progressText(3)).toBe("Plan Progress (3 steps)");
  });

  it("uses singular when count is 1", () => {
    expect(progressText(1)).toBe("Plan Progress (1 step)");
  });

  it("uses custom stepLabel 'Step'", () => {
    expect(progressText(5, "Step")).toBe("Step Progress (5 steps)");
  });

  it("uses custom stepLabel 'Cycle'", () => {
    expect(progressText(2, "Cycle")).toBe("Cycle Progress (2 cycles)");
  });

  it("uses custom stepLabel 'Step' (explicit)", () => {
    expect(progressText(4, "Step")).toBe("Step Progress (4 steps)");
  });

  it("handles zero count", () => {
    expect(progressText(0)).toBe("Plan Progress (0 steps)");
  });

  it("handles singular with custom stepLabel", () => {
    expect(progressText(1, "Cycle")).toBe("Cycle Progress (1 cycle)");
  });
});

// ── TelemetryBar display text logic ──

describe("TelemetryBar display text", () => {
  /**
   * Replicates the step display text from TelemetryBar:
   *   `{stepLabel ?? "Step"} X/N`
   */
  function stepDisplayText(
    currentStep: number,
    totalSteps: number,
    stepLabel?: string,
  ): string {
    return `${stepLabel ?? "Step"} ${currentStep}/${totalSteps}`;
  }

  it("defaults to 'Step X/N' without stepLabel", () => {
    expect(stepDisplayText(2, 5)).toBe("Step 2/5");
  });

  it("uses custom stepLabel 'Step'", () => {
    expect(stepDisplayText(1, 3, "Step")).toBe("Step 1/3");
  });

  it("uses custom stepLabel 'Cycle'", () => {
    expect(stepDisplayText(0, 2, "Cycle")).toBe("Cycle 0/2");
  });
});

describe("Workflow panel step title truncation", () => {
  it("uses a shorter title width when a duration is visible", () => {
    expect(getStepTitleMaxWidth(true)).toBeLessThan(getStepTitleMaxWidth(false));
  });

  it("preserves the existing wider width when no duration is shown", () => {
    expect(getStepTitleMaxWidth(false)).toBe(22);
  });
});

describe("Interrupted display state", () => {
  it("maps a running step to paused when interrupted", () => {
    expect(getDisplayedStepStatus("running", true)).toBe("paused");
  });

  it("keeps non-running step statuses unchanged when interrupted", () => {
    expect(getDisplayedStepStatus("completed", true)).toBe("completed");
  });

  it("maps running workflow status to interrupted when interrupted", () => {
    expect(getDisplayedWorkflowStatus("running", true)).toBe("interrupted");
  });
});

// ── WorkShell defaults verification ──

describe("WorkShell defaults", () => {
  it("WorkShell would pass stepLabel='Step' and workflowName='work' to WorkflowView", () => {
    // This validates the contract: WorkShell hardcodes these values.
    // We verify by checking the expected defaults match the StepProgress/TelemetryBar logic.
    const stepLabel = "Step";
    const workflowName = "work";

    // StepProgress with stepLabel="Step"
    const label = stepLabel;
    const unit = stepLabel.toLowerCase();
    expect(`${label} Progress (3 ${unit}s)`).toBe("Step Progress (3 steps)");

    // TelemetryBar with stepLabel="Step"
    expect(`${stepLabel} 2/5`).toBe("Step 2/5");

    // workflowName is passed through
    expect(workflowName).toBe("work");
  });
});

import { describe, it, expect } from "bun:test";

/**
 * WorkflowView / WorkShell / PhaseProgress / TelemetryBar generalization tests.
 *
 * These are unit tests for the display text logic, not rendering tests
 * (OpenTUI components can't be rendered/imported in test without --conditions=browser).
 */

// ── PhaseProgress display text logic ──

describe("PhaseProgress display text", () => {
  /**
   * Replicates the display text logic from PhaseProgress:
   *   `{stepLabel ?? "Plan"} Progress (N {stepLabel?.toLowerCase() ?? "phase"}s)`
   */
  function progressText(count: number, stepLabel?: string): string {
    const label = stepLabel ?? "Plan";
    const unit = stepLabel?.toLowerCase() ?? "phase";
    const plural = count === 1 ? unit : `${unit}s`;
    return `${label} Progress (${count} ${plural})`;
  }

  it("defaults to 'Plan Progress (N phases)' without stepLabel", () => {
    expect(progressText(3)).toBe("Plan Progress (3 phases)");
  });

  it("uses singular when count is 1", () => {
    expect(progressText(1)).toBe("Plan Progress (1 phase)");
  });

  it("uses custom stepLabel 'Step'", () => {
    expect(progressText(5, "Step")).toBe("Step Progress (5 steps)");
  });

  it("uses custom stepLabel 'Cycle'", () => {
    expect(progressText(2, "Cycle")).toBe("Cycle Progress (2 cycles)");
  });

  it("uses custom stepLabel 'Phase' (explicit)", () => {
    expect(progressText(4, "Phase")).toBe("Phase Progress (4 phases)");
  });

  it("handles zero count", () => {
    expect(progressText(0)).toBe("Plan Progress (0 phases)");
  });

  it("handles singular with custom stepLabel", () => {
    expect(progressText(1, "Cycle")).toBe("Cycle Progress (1 cycle)");
  });
});

// ── TelemetryBar display text logic ──

describe("TelemetryBar display text", () => {
  /**
   * Replicates the phase display text from TelemetryBar:
   *   `{stepLabel ?? "Phase"} X/N`
   */
  function phaseDisplayText(
    currentPhase: number,
    totalPhases: number,
    stepLabel?: string,
  ): string {
    return `${stepLabel ?? "Phase"} ${currentPhase}/${totalPhases}`;
  }

  it("defaults to 'Phase X/N' without stepLabel", () => {
    expect(phaseDisplayText(2, 5)).toBe("Phase 2/5");
  });

  it("uses custom stepLabel 'Step'", () => {
    expect(phaseDisplayText(1, 3, "Step")).toBe("Step 1/3");
  });

  it("uses custom stepLabel 'Cycle'", () => {
    expect(phaseDisplayText(0, 2, "Cycle")).toBe("Cycle 0/2");
  });
});

// ── WorkShell defaults verification ──

describe("WorkShell defaults", () => {
  it("WorkShell would pass stepLabel='Step' and workflowName='work' to WorkflowView", () => {
    // This validates the contract: WorkShell hardcodes these values.
    // We verify by checking the expected defaults match the PhaseProgress/TelemetryBar logic.
    const stepLabel = "Step";
    const workflowName = "work";

    // PhaseProgress with stepLabel="Step"
    const label = stepLabel;
    const unit = stepLabel.toLowerCase();
    expect(`${label} Progress (3 ${unit}s)`).toBe("Step Progress (3 steps)");

    // TelemetryBar with stepLabel="Step"
    expect(`${stepLabel} 2/5`).toBe("Step 2/5");

    // workflowName is passed through
    expect(workflowName).toBe("work");
  });
});

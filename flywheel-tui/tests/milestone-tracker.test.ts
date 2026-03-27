import { describe, it, expect } from "bun:test";
import {
  MilestoneTracker,
  isMilestoneImplementationComplete,
  type MilestoneStep,
  VALIDATION_SKILL_NAMES,
} from "../src/controller/milestone-tracker";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStep(overrides: Partial<MilestoneStep> = {}): MilestoneStep {
  return {
    index: 0,
    title: "Test step",
    status: "pending",
    milestone: undefined,
    isValidation: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isMilestoneImplementationComplete (pure function)
// ---------------------------------------------------------------------------

describe("isMilestoneImplementationComplete", () => {
  // VAL-MILE-004: Milestone completion detected when all steps completed or cancelled
  describe("VAL-MILE-004: milestone completion detection", () => {
    it("returns true when all steps in a milestone are completed", () => {
      const steps: MilestoneStep[] = [
        createStep({ index: 0, title: "Step A", milestone: "M1", status: "completed" }),
        createStep({ index: 1, title: "Step B", milestone: "M1", status: "completed" }),
      ];

      expect(isMilestoneImplementationComplete(steps, "M1")).toBe(true);
    });

    it("returns true when all steps are cancelled", () => {
      const steps: MilestoneStep[] = [
        createStep({ index: 0, title: "Step A", milestone: "M1", status: "cancelled" }),
        createStep({ index: 1, title: "Step B", milestone: "M1", status: "cancelled" }),
      ];

      expect(isMilestoneImplementationComplete(steps, "M1")).toBe(true);
    });

    it("returns true when steps are mix of completed and cancelled", () => {
      const steps: MilestoneStep[] = [
        createStep({ index: 0, title: "Step A", milestone: "M1", status: "completed" }),
        createStep({ index: 1, title: "Step B", milestone: "M1", status: "cancelled" }),
        createStep({ index: 2, title: "Step C", milestone: "M1", status: "completed" }),
      ];

      expect(isMilestoneImplementationComplete(steps, "M1")).toBe(true);
    });

    it("returns false when any step is pending", () => {
      const steps: MilestoneStep[] = [
        createStep({ index: 0, title: "Step A", milestone: "M1", status: "completed" }),
        createStep({ index: 1, title: "Step B", milestone: "M1", status: "pending" }),
      ];

      expect(isMilestoneImplementationComplete(steps, "M1")).toBe(false);
    });

    it("returns false when any step is in_progress", () => {
      const steps: MilestoneStep[] = [
        createStep({ index: 0, title: "Step A", milestone: "M1", status: "completed" }),
        createStep({ index: 1, title: "Step B", milestone: "M1", status: "in_progress" }),
      ];

      expect(isMilestoneImplementationComplete(steps, "M1")).toBe(false);
    });

    it("returns false when no steps belong to the milestone", () => {
      const steps: MilestoneStep[] = [
        createStep({ index: 0, title: "Step A", milestone: "M2", status: "completed" }),
      ];

      expect(isMilestoneImplementationComplete(steps, "M1")).toBe(false);
    });

    it("only considers steps belonging to the specified milestone", () => {
      const steps: MilestoneStep[] = [
        createStep({ index: 0, title: "Step A", milestone: "M1", status: "completed" }),
        createStep({ index: 1, title: "Step B", milestone: "M2", status: "pending" }),
        createStep({ index: 2, title: "Step C", milestone: "M1", status: "completed" }),
      ];

      // M1 steps are all complete, M2 step is pending but shouldn't matter
      expect(isMilestoneImplementationComplete(steps, "M1")).toBe(true);
      expect(isMilestoneImplementationComplete(steps, "M2")).toBe(false);
    });
  });

  // Validation-type steps excluded from milestone completion check
  describe("validation step exclusion", () => {
    it("excludes validation-type steps from milestone completion check", () => {
      const steps: MilestoneStep[] = [
        createStep({ index: 0, title: "Step A", milestone: "M1", status: "completed" }),
        createStep({ index: 1, title: "Step B", milestone: "M1", status: "completed" }),
        // Validation step is still pending — should be excluded
        createStep({
          index: 2,
          title: "Scrutiny: M1",
          milestone: "M1",
          status: "pending",
          isValidation: true,
        }),
      ];

      expect(isMilestoneImplementationComplete(steps, "M1")).toBe(true);
    });

    it("returns false if only validation steps exist (no implementation steps)", () => {
      const steps: MilestoneStep[] = [
        createStep({
          index: 0,
          title: "Scrutiny: M1",
          milestone: "M1",
          status: "completed",
          isValidation: true,
        }),
      ];

      // No implementation steps → milestone cannot be "complete"
      expect(isMilestoneImplementationComplete(steps, "M1")).toBe(false);
    });

    it("handles mix of completed implementation and pending validation steps", () => {
      const steps: MilestoneStep[] = [
        createStep({ index: 0, title: "Setup", milestone: "M1", status: "completed" }),
        createStep({ index: 1, title: "Build API", milestone: "M1", status: "completed" }),
        createStep({
          index: 2,
          title: "Scrutiny: M1",
          milestone: "M1",
          status: "pending",
          isValidation: true,
        }),
        createStep({
          index: 3,
          title: "Behavioral: M1",
          milestone: "M1",
          status: "pending",
          isValidation: true,
        }),
      ];

      expect(isMilestoneImplementationComplete(steps, "M1")).toBe(true);
    });
  });

  // Steps without milestones never part of milestone completion logic
  describe("steps without milestones", () => {
    it("steps with milestone: undefined are never part of milestone completion", () => {
      const steps: MilestoneStep[] = [
        createStep({ index: 0, title: "Step A", milestone: undefined, status: "pending" }),
        createStep({ index: 1, title: "Step B", milestone: "M1", status: "completed" }),
      ];

      // The undefined-milestone step shouldn't prevent M1 from being complete
      expect(isMilestoneImplementationComplete(steps, "M1")).toBe(true);
    });

    it("returns false for any milestone name when all steps have undefined milestone", () => {
      const steps: MilestoneStep[] = [
        createStep({ index: 0, title: "Step A", milestone: undefined, status: "completed" }),
        createStep({ index: 1, title: "Step B", milestone: undefined, status: "completed" }),
      ];

      expect(isMilestoneImplementationComplete(steps, "M1")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// MilestoneTracker class
// ---------------------------------------------------------------------------

describe("MilestoneTracker", () => {
  // -------------------------------------------------------------------------
  // Basic tracking
  // -------------------------------------------------------------------------
  describe("basic milestone tracking", () => {
    it("detects milestone completion", () => {
      const steps: MilestoneStep[] = [
        createStep({ index: 0, title: "Step A", milestone: "M1", status: "completed" }),
        createStep({ index: 1, title: "Step B", milestone: "M1", status: "completed" }),
        createStep({ index: 2, title: "Step C", milestone: "M2", status: "pending" }),
      ];

      const tracker = new MilestoneTracker();
      expect(tracker.isMilestoneComplete(steps, "M1")).toBe(true);
      expect(tracker.isMilestoneComplete(steps, "M2")).toBe(false);
    });

    it("returns all milestone names from steps", () => {
      const steps: MilestoneStep[] = [
        createStep({ index: 0, milestone: "Alpha" }),
        createStep({ index: 1, milestone: "Beta" }),
        createStep({ index: 2, milestone: "Alpha" }),
        createStep({ index: 3, milestone: undefined }),
      ];

      const tracker = new MilestoneTracker();
      const names = tracker.getMilestoneNames(steps);
      expect(names).toEqual(["Alpha", "Beta"]);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-MILE-007: Sealed milestones prevent re-injection
  // -------------------------------------------------------------------------
  describe("VAL-MILE-007: sealed milestones", () => {
    it("tracks milestones with validation planned", () => {
      const tracker = new MilestoneTracker();

      expect(tracker.hasValidationPlanned("M1")).toBe(false);

      tracker.markValidationPlanned("M1");
      expect(tracker.hasValidationPlanned("M1")).toBe(true);
      expect(tracker.hasValidationPlanned("M2")).toBe(false);
    });

    it("sealed milestones do not trigger re-injection", () => {
      const steps: MilestoneStep[] = [
        createStep({ index: 0, title: "Step A", milestone: "M1", status: "completed" }),
        createStep({ index: 1, title: "Step B", milestone: "M1", status: "completed" }),
      ];

      const tracker = new MilestoneTracker();

      // First time: should detect completion
      expect(tracker.shouldInjectValidation(steps, "M1")).toBe(true);

      // Mark as sealed
      tracker.markValidationPlanned("M1");

      // Second time: should NOT trigger because it's sealed
      expect(tracker.shouldInjectValidation(steps, "M1")).toBe(false);
    });

    it("sealing one milestone does not affect others", () => {
      const steps: MilestoneStep[] = [
        createStep({ index: 0, milestone: "M1", status: "completed" }),
        createStep({ index: 1, milestone: "M2", status: "completed" }),
      ];

      const tracker = new MilestoneTracker();
      tracker.markValidationPlanned("M1");

      expect(tracker.shouldInjectValidation(steps, "M1")).toBe(false);
      expect(tracker.shouldInjectValidation(steps, "M2")).toBe(true);
    });

    it("getMilestonesWithValidationPlanned returns sealed milestone names", () => {
      const tracker = new MilestoneTracker();
      expect(tracker.getMilestonesWithValidationPlanned()).toEqual([]);

      tracker.markValidationPlanned("M1");
      tracker.markValidationPlanned("M2");
      expect(tracker.getMilestonesWithValidationPlanned()).toEqual(["M1", "M2"]);
    });

    it("marking the same milestone twice is idempotent", () => {
      const tracker = new MilestoneTracker();
      tracker.markValidationPlanned("M1");
      tracker.markValidationPlanned("M1");

      expect(tracker.getMilestonesWithValidationPlanned()).toEqual(["M1"]);
    });

    it("can initialize with pre-sealed milestones", () => {
      const tracker = new MilestoneTracker(["M1", "M2"]);

      expect(tracker.hasValidationPlanned("M1")).toBe(true);
      expect(tracker.hasValidationPlanned("M2")).toBe(true);
      expect(tracker.hasValidationPlanned("M3")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // checkCompletedMilestones: batch detection
  // -------------------------------------------------------------------------
  describe("checkCompletedMilestones", () => {
    it("returns newly completed milestones that are not yet sealed", () => {
      const steps: MilestoneStep[] = [
        createStep({ index: 0, milestone: "M1", status: "completed" }),
        createStep({ index: 1, milestone: "M1", status: "completed" }),
        createStep({ index: 2, milestone: "M2", status: "pending" }),
      ];

      const tracker = new MilestoneTracker();
      const completed = tracker.checkCompletedMilestones(steps);

      expect(completed).toEqual(["M1"]);
    });

    it("excludes already-sealed milestones", () => {
      const steps: MilestoneStep[] = [
        createStep({ index: 0, milestone: "M1", status: "completed" }),
        createStep({ index: 1, milestone: "M2", status: "completed" }),
      ];

      const tracker = new MilestoneTracker(["M1"]);
      const completed = tracker.checkCompletedMilestones(steps);

      expect(completed).toEqual(["M2"]);
    });

    it("returns empty array when no milestones are newly complete", () => {
      const steps: MilestoneStep[] = [
        createStep({ index: 0, milestone: "M1", status: "pending" }),
      ];

      const tracker = new MilestoneTracker();
      const completed = tracker.checkCompletedMilestones(steps);

      expect(completed).toEqual([]);
    });

    it("ignores steps with undefined milestone", () => {
      const steps: MilestoneStep[] = [
        createStep({ index: 0, milestone: undefined, status: "completed" }),
        createStep({ index: 1, milestone: "M1", status: "completed" }),
      ];

      const tracker = new MilestoneTracker();
      const completed = tracker.checkCompletedMilestones(steps);

      expect(completed).toEqual(["M1"]);
    });
  });
});

// ---------------------------------------------------------------------------
// VALIDATION_SKILL_NAMES constant
// ---------------------------------------------------------------------------

describe("VALIDATION_SKILL_NAMES", () => {
  it("contains expected validator skill names", () => {
    expect(VALIDATION_SKILL_NAMES).toContain("scrutiny-validator");
    expect(VALIDATION_SKILL_NAMES).toContain("user-testing-validator");
  });

  it("is a frozen array", () => {
    expect(Object.isFrozen(VALIDATION_SKILL_NAMES)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation step auto-injection
// ---------------------------------------------------------------------------

describe("Validation step auto-injection", () => {
  // VAL-EXEC-001: Scrutiny steps auto-inject at milestone completion
  describe("VAL-EXEC-001: scrutiny step auto-injection", () => {
    it("creates a scrutiny validation step when milestone completes", () => {
      const tracker = new MilestoneTracker();
      const steps = tracker.createValidationSteps("auth", 0);

      const scrutiny = steps.find((p) => p.title.startsWith("Scrutiny:"));
      expect(scrutiny).toBeDefined();
      expect(scrutiny!.title).toBe("Scrutiny: auth");
      expect(scrutiny!.status).toBe("pending");
      expect(scrutiny!.milestone).toBe("auth");
    });

    it("scrutiny step is first in the injection order", () => {
      const tracker = new MilestoneTracker();
      const steps = tracker.createValidationSteps("auth", 0);

      expect(steps[0].title).toBe("Scrutiny: auth");
    });
  });

  // VAL-EXEC-002: Behavioral validation steps auto-inject
  describe("VAL-EXEC-002: behavioral validation step auto-injection", () => {
    it("creates a behavioral validation step when milestone completes", () => {
      const tracker = new MilestoneTracker();
      const steps = tracker.createValidationSteps("auth", 0);

      const behavioral = steps.find((p) => p.title.startsWith("Validation:"));
      expect(behavioral).toBeDefined();
      expect(behavioral!.title).toBe("Validation: auth");
      expect(behavioral!.status).toBe("pending");
      expect(behavioral!.milestone).toBe("auth");
    });

    it("behavioral validation step comes after scrutiny", () => {
      const tracker = new MilestoneTracker();
      const steps = tracker.createValidationSteps("auth", 0);

      expect(steps.length).toBe(2);
      expect(steps[0].title).toBe("Scrutiny: auth");
      expect(steps[1].title).toBe("Validation: auth");
    });
  });

  // VAL-EXEC-009: Validation steps have correct metadata
  describe("VAL-EXEC-009: validation step metadata", () => {
    it("scrutiny step has descriptive name with milestone", () => {
      const tracker = new MilestoneTracker();
      const steps = tracker.createValidationSteps("checkout-flow", 5);

      expect(steps[0].title).toBe("Scrutiny: checkout-flow");
    });

    it("behavioral step has descriptive name with milestone", () => {
      const tracker = new MilestoneTracker();
      const steps = tracker.createValidationSteps("checkout-flow", 5);

      expect(steps[1].title).toBe("Validation: checkout-flow");
    });

    it("steps have appropriate descriptions", () => {
      const tracker = new MilestoneTracker();
      const steps = tracker.createValidationSteps("auth", 0);

      expect(steps[0].description).toContain("Scrutiny validation");
      expect(steps[0].description).toContain("auth");
      expect(steps[1].description).toContain("Behavioral validation");
      expect(steps[1].description).toContain("auth");
    });

    it("steps have step checklists", () => {
      const tracker = new MilestoneTracker();
      const steps = tracker.createValidationSteps("auth", 0);

      expect(steps[0].steps!.length).toBeGreaterThan(0);
      expect(steps[1].steps!.length).toBeGreaterThan(0);
    });

    it("steps are assigned sequential indices from startIndex", () => {
      const tracker = new MilestoneTracker();
      const steps = tracker.createValidationSteps("auth", 10);

      expect(steps[0].index).toBe(10);
      expect(steps[1].index).toBe(11);
    });
  });

  // VAL-EXEC-008: Skip flags bypass validation
  describe("VAL-EXEC-008: skip flags", () => {
    it("skip_scrutiny prevents scrutiny step injection", () => {
      const tracker = new MilestoneTracker();
      const steps = tracker.createValidationSteps("auth", 0, { skipScrutiny: true });

      expect(steps.length).toBe(1);
      expect(steps[0].title).toBe("Validation: auth");
    });

    it("skip_validation prevents behavioral validation step injection", () => {
      const tracker = new MilestoneTracker();
      const steps = tracker.createValidationSteps("auth", 0, { skipValidation: true });

      expect(steps.length).toBe(1);
      expect(steps[0].title).toBe("Scrutiny: auth");
    });

    it("both skip flags prevent all validation step injection", () => {
      const tracker = new MilestoneTracker();
      const steps = tracker.createValidationSteps("auth", 0, {
        skipScrutiny: true,
        skipValidation: true,
      });

      expect(steps.length).toBe(0);
    });

    it("skip flags are independent — can skip one but not the other", () => {
      const tracker = new MilestoneTracker();

      // Skip only scrutiny
      const steps1 = tracker.createValidationSteps("M1", 0, { skipScrutiny: true, skipValidation: false });
      expect(steps1.length).toBe(1);
      expect(steps1[0].title).toBe("Validation: M1");

      // Skip only validation
      const tracker2 = new MilestoneTracker();
      const steps2 = tracker2.createValidationSteps("M2", 0, { skipScrutiny: false, skipValidation: true });
      expect(steps2.length).toBe(1);
      expect(steps2[0].title).toBe("Scrutiny: M2");
    });
  });

  // VAL-EXEC-012: Injection preserves step ordering
  describe("VAL-EXEC-012: injection preserves ordering", () => {
    it("checkAndCreateValidationSteps returns steps in correct order", () => {
      const milestoneSteps: MilestoneStep[] = [
        createStep({ index: 0, milestone: "M1", status: "completed" }),
        createStep({ index: 1, milestone: "M1", status: "completed" }),
        createStep({ index: 2, milestone: "M2", status: "pending" }),
      ];

      const tracker = new MilestoneTracker();
      const injections = tracker.checkAndCreateValidationSteps(milestoneSteps, 3);

      expect(injections.length).toBe(1);
      expect(injections[0].milestone).toBe("M1");
      expect(injections[0].steps[0].title).toBe("Scrutiny: M1");
      expect(injections[0].steps[1].title).toBe("Validation: M1");
    });

    it("multiple milestones produce independent injections", () => {
      const milestoneSteps: MilestoneStep[] = [
        createStep({ index: 0, milestone: "M1", status: "completed" }),
        createStep({ index: 1, milestone: "M2", status: "completed" }),
      ];

      const tracker = new MilestoneTracker();
      const injections = tracker.checkAndCreateValidationSteps(milestoneSteps, 2);

      expect(injections.length).toBe(2);
      expect(injections[0].milestone).toBe("M1");
      expect(injections[1].milestone).toBe("M2");
    });
  });

  // VAL-MILE-007 (reinforced): Sealed milestones do not trigger duplicate injection
  describe("sealed milestones do not trigger duplicate injection", () => {
    it("checkAndCreateValidationSteps seals milestones after injection", () => {
      const milestoneSteps: MilestoneStep[] = [
        createStep({ index: 0, milestone: "M1", status: "completed" }),
      ];

      const tracker = new MilestoneTracker();
      const firstInjection = tracker.checkAndCreateValidationSteps(milestoneSteps, 1);
      expect(firstInjection.length).toBe(1);

      // Second call should return empty — M1 is sealed
      const secondInjection = tracker.checkAndCreateValidationSteps(milestoneSteps, 3);
      expect(secondInjection.length).toBe(0);
    });

    it("sealed milestone with both skipped still prevents re-injection", () => {
      const milestoneSteps: MilestoneStep[] = [
        createStep({ index: 0, milestone: "M1", status: "completed" }),
      ];

      const tracker = new MilestoneTracker();
      const injection = tracker.checkAndCreateValidationSteps(milestoneSteps, 1, {
        skipScrutiny: true,
        skipValidation: true,
      });
      // Both skipped — no steps, but milestone is still sealed
      expect(injection.length).toBe(0);
      expect(tracker.hasValidationPlanned("M1")).toBe(true);

      // Subsequent call returns nothing
      const secondInjection = tracker.checkAndCreateValidationSteps(milestoneSteps, 1);
      expect(secondInjection.length).toBe(0);
    });
  });

  // VAL-CROSS-007: Skip flags propagate through entire chain
  describe("VAL-CROSS-007: skip flags propagation", () => {
    it("skip_scrutiny prevents scrutiny injection but allows behavioral", () => {
      const milestoneSteps: MilestoneStep[] = [
        createStep({ index: 0, milestone: "M1", status: "completed" }),
      ];

      const tracker = new MilestoneTracker();
      const injections = tracker.checkAndCreateValidationSteps(milestoneSteps, 1, {
        skipScrutiny: true,
      });

      expect(injections.length).toBe(1);
      expect(injections[0].steps.length).toBe(1);
      expect(injections[0].steps[0].title).toBe("Validation: M1");
    });

    it("skip_validation prevents behavioral injection but allows scrutiny", () => {
      const milestoneSteps: MilestoneStep[] = [
        createStep({ index: 0, milestone: "M1", status: "completed" }),
      ];

      const tracker = new MilestoneTracker();
      const injections = tracker.checkAndCreateValidationSteps(milestoneSteps, 1, {
        skipValidation: true,
      });

      expect(injections.length).toBe(1);
      expect(injections[0].steps.length).toBe(1);
      expect(injections[0].steps[0].title).toBe("Scrutiny: M1");
    });

    it("both skipped marks milestone as sealed with no steps", () => {
      const milestoneSteps: MilestoneStep[] = [
        createStep({ index: 0, milestone: "M1", status: "completed" }),
      ];

      const tracker = new MilestoneTracker();
      const injections = tracker.checkAndCreateValidationSteps(milestoneSteps, 1, {
        skipScrutiny: true,
        skipValidation: true,
      });

      // Returns empty list (no injections)
      expect(injections.length).toBe(0);
      // But milestone IS sealed
      expect(tracker.hasValidationPlanned("M1")).toBe(true);
    });
  });
});

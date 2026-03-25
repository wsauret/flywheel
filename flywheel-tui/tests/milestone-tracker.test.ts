import { describe, it, expect } from "bun:test";
import {
  MilestoneTracker,
  isMilestoneImplementationComplete,
  type MilestonePhase,
  VALIDATION_SKILL_NAMES,
} from "../src/controller/milestone-tracker";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createPhase(overrides: Partial<MilestonePhase> = {}): MilestonePhase {
  return {
    index: 0,
    title: "Test phase",
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
  // VAL-MILE-004: Milestone completion detected when all phases completed or cancelled
  describe("VAL-MILE-004: milestone completion detection", () => {
    it("returns true when all phases in a milestone are completed", () => {
      const phases: MilestonePhase[] = [
        createPhase({ index: 0, title: "Phase A", milestone: "M1", status: "completed" }),
        createPhase({ index: 1, title: "Phase B", milestone: "M1", status: "completed" }),
      ];

      expect(isMilestoneImplementationComplete(phases, "M1")).toBe(true);
    });

    it("returns true when all phases are cancelled", () => {
      const phases: MilestonePhase[] = [
        createPhase({ index: 0, title: "Phase A", milestone: "M1", status: "cancelled" }),
        createPhase({ index: 1, title: "Phase B", milestone: "M1", status: "cancelled" }),
      ];

      expect(isMilestoneImplementationComplete(phases, "M1")).toBe(true);
    });

    it("returns true when phases are mix of completed and cancelled", () => {
      const phases: MilestonePhase[] = [
        createPhase({ index: 0, title: "Phase A", milestone: "M1", status: "completed" }),
        createPhase({ index: 1, title: "Phase B", milestone: "M1", status: "cancelled" }),
        createPhase({ index: 2, title: "Phase C", milestone: "M1", status: "completed" }),
      ];

      expect(isMilestoneImplementationComplete(phases, "M1")).toBe(true);
    });

    it("returns false when any phase is pending", () => {
      const phases: MilestonePhase[] = [
        createPhase({ index: 0, title: "Phase A", milestone: "M1", status: "completed" }),
        createPhase({ index: 1, title: "Phase B", milestone: "M1", status: "pending" }),
      ];

      expect(isMilestoneImplementationComplete(phases, "M1")).toBe(false);
    });

    it("returns false when any phase is in_progress", () => {
      const phases: MilestonePhase[] = [
        createPhase({ index: 0, title: "Phase A", milestone: "M1", status: "completed" }),
        createPhase({ index: 1, title: "Phase B", milestone: "M1", status: "in_progress" }),
      ];

      expect(isMilestoneImplementationComplete(phases, "M1")).toBe(false);
    });

    it("returns false when no phases belong to the milestone", () => {
      const phases: MilestonePhase[] = [
        createPhase({ index: 0, title: "Phase A", milestone: "M2", status: "completed" }),
      ];

      expect(isMilestoneImplementationComplete(phases, "M1")).toBe(false);
    });

    it("only considers phases belonging to the specified milestone", () => {
      const phases: MilestonePhase[] = [
        createPhase({ index: 0, title: "Phase A", milestone: "M1", status: "completed" }),
        createPhase({ index: 1, title: "Phase B", milestone: "M2", status: "pending" }),
        createPhase({ index: 2, title: "Phase C", milestone: "M1", status: "completed" }),
      ];

      // M1 phases are all complete, M2 phase is pending but shouldn't matter
      expect(isMilestoneImplementationComplete(phases, "M1")).toBe(true);
      expect(isMilestoneImplementationComplete(phases, "M2")).toBe(false);
    });
  });

  // Validation-type phases excluded from milestone completion check
  describe("validation phase exclusion", () => {
    it("excludes validation-type phases from milestone completion check", () => {
      const phases: MilestonePhase[] = [
        createPhase({ index: 0, title: "Phase A", milestone: "M1", status: "completed" }),
        createPhase({ index: 1, title: "Phase B", milestone: "M1", status: "completed" }),
        // Validation phase is still pending — should be excluded
        createPhase({
          index: 2,
          title: "Scrutiny: M1",
          milestone: "M1",
          status: "pending",
          isValidation: true,
        }),
      ];

      expect(isMilestoneImplementationComplete(phases, "M1")).toBe(true);
    });

    it("returns false if only validation phases exist (no implementation phases)", () => {
      const phases: MilestonePhase[] = [
        createPhase({
          index: 0,
          title: "Scrutiny: M1",
          milestone: "M1",
          status: "completed",
          isValidation: true,
        }),
      ];

      // No implementation phases → milestone cannot be "complete"
      expect(isMilestoneImplementationComplete(phases, "M1")).toBe(false);
    });

    it("handles mix of completed implementation and pending validation phases", () => {
      const phases: MilestonePhase[] = [
        createPhase({ index: 0, title: "Setup", milestone: "M1", status: "completed" }),
        createPhase({ index: 1, title: "Build API", milestone: "M1", status: "completed" }),
        createPhase({
          index: 2,
          title: "Scrutiny: M1",
          milestone: "M1",
          status: "pending",
          isValidation: true,
        }),
        createPhase({
          index: 3,
          title: "Behavioral: M1",
          milestone: "M1",
          status: "pending",
          isValidation: true,
        }),
      ];

      expect(isMilestoneImplementationComplete(phases, "M1")).toBe(true);
    });
  });

  // Phases without milestones never part of milestone completion logic
  describe("phases without milestones", () => {
    it("phases with milestone: undefined are never part of milestone completion", () => {
      const phases: MilestonePhase[] = [
        createPhase({ index: 0, title: "Phase A", milestone: undefined, status: "pending" }),
        createPhase({ index: 1, title: "Phase B", milestone: "M1", status: "completed" }),
      ];

      // The undefined-milestone phase shouldn't prevent M1 from being complete
      expect(isMilestoneImplementationComplete(phases, "M1")).toBe(true);
    });

    it("returns false for any milestone name when all phases have undefined milestone", () => {
      const phases: MilestonePhase[] = [
        createPhase({ index: 0, title: "Phase A", milestone: undefined, status: "completed" }),
        createPhase({ index: 1, title: "Phase B", milestone: undefined, status: "completed" }),
      ];

      expect(isMilestoneImplementationComplete(phases, "M1")).toBe(false);
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
      const phases: MilestonePhase[] = [
        createPhase({ index: 0, title: "Phase A", milestone: "M1", status: "completed" }),
        createPhase({ index: 1, title: "Phase B", milestone: "M1", status: "completed" }),
        createPhase({ index: 2, title: "Phase C", milestone: "M2", status: "pending" }),
      ];

      const tracker = new MilestoneTracker();
      expect(tracker.isMilestoneComplete(phases, "M1")).toBe(true);
      expect(tracker.isMilestoneComplete(phases, "M2")).toBe(false);
    });

    it("returns all milestone names from phases", () => {
      const phases: MilestonePhase[] = [
        createPhase({ index: 0, milestone: "Alpha" }),
        createPhase({ index: 1, milestone: "Beta" }),
        createPhase({ index: 2, milestone: "Alpha" }),
        createPhase({ index: 3, milestone: undefined }),
      ];

      const tracker = new MilestoneTracker();
      const names = tracker.getMilestoneNames(phases);
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
      const phases: MilestonePhase[] = [
        createPhase({ index: 0, title: "Phase A", milestone: "M1", status: "completed" }),
        createPhase({ index: 1, title: "Phase B", milestone: "M1", status: "completed" }),
      ];

      const tracker = new MilestoneTracker();

      // First time: should detect completion
      expect(tracker.shouldInjectValidation(phases, "M1")).toBe(true);

      // Mark as sealed
      tracker.markValidationPlanned("M1");

      // Second time: should NOT trigger because it's sealed
      expect(tracker.shouldInjectValidation(phases, "M1")).toBe(false);
    });

    it("sealing one milestone does not affect others", () => {
      const phases: MilestonePhase[] = [
        createPhase({ index: 0, milestone: "M1", status: "completed" }),
        createPhase({ index: 1, milestone: "M2", status: "completed" }),
      ];

      const tracker = new MilestoneTracker();
      tracker.markValidationPlanned("M1");

      expect(tracker.shouldInjectValidation(phases, "M1")).toBe(false);
      expect(tracker.shouldInjectValidation(phases, "M2")).toBe(true);
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
      const phases: MilestonePhase[] = [
        createPhase({ index: 0, milestone: "M1", status: "completed" }),
        createPhase({ index: 1, milestone: "M1", status: "completed" }),
        createPhase({ index: 2, milestone: "M2", status: "pending" }),
      ];

      const tracker = new MilestoneTracker();
      const completed = tracker.checkCompletedMilestones(phases);

      expect(completed).toEqual(["M1"]);
    });

    it("excludes already-sealed milestones", () => {
      const phases: MilestonePhase[] = [
        createPhase({ index: 0, milestone: "M1", status: "completed" }),
        createPhase({ index: 1, milestone: "M2", status: "completed" }),
      ];

      const tracker = new MilestoneTracker(["M1"]);
      const completed = tracker.checkCompletedMilestones(phases);

      expect(completed).toEqual(["M2"]);
    });

    it("returns empty array when no milestones are newly complete", () => {
      const phases: MilestonePhase[] = [
        createPhase({ index: 0, milestone: "M1", status: "pending" }),
      ];

      const tracker = new MilestoneTracker();
      const completed = tracker.checkCompletedMilestones(phases);

      expect(completed).toEqual([]);
    });

    it("ignores phases with undefined milestone", () => {
      const phases: MilestonePhase[] = [
        createPhase({ index: 0, milestone: undefined, status: "completed" }),
        createPhase({ index: 1, milestone: "M1", status: "completed" }),
      ];

      const tracker = new MilestoneTracker();
      const completed = tracker.checkCompletedMilestones(phases);

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
// Validation phase auto-injection
// ---------------------------------------------------------------------------

describe("Validation phase auto-injection", () => {
  // VAL-EXEC-001: Scrutiny phases auto-inject at milestone completion
  describe("VAL-EXEC-001: scrutiny phase auto-injection", () => {
    it("creates a scrutiny validation phase when milestone completes", () => {
      const tracker = new MilestoneTracker();
      const phases = tracker.createValidationPhases("auth", 0);

      const scrutiny = phases.find((p) => p.title.startsWith("Scrutiny:"));
      expect(scrutiny).toBeDefined();
      expect(scrutiny!.title).toBe("Scrutiny: auth");
      expect(scrutiny!.status).toBe("pending");
      expect(scrutiny!.milestone).toBe("auth");
    });

    it("scrutiny phase is first in the injection order", () => {
      const tracker = new MilestoneTracker();
      const phases = tracker.createValidationPhases("auth", 0);

      expect(phases[0].title).toBe("Scrutiny: auth");
    });
  });

  // VAL-EXEC-002: Behavioral validation phases auto-inject
  describe("VAL-EXEC-002: behavioral validation phase auto-injection", () => {
    it("creates a behavioral validation phase when milestone completes", () => {
      const tracker = new MilestoneTracker();
      const phases = tracker.createValidationPhases("auth", 0);

      const behavioral = phases.find((p) => p.title.startsWith("Validation:"));
      expect(behavioral).toBeDefined();
      expect(behavioral!.title).toBe("Validation: auth");
      expect(behavioral!.status).toBe("pending");
      expect(behavioral!.milestone).toBe("auth");
    });

    it("behavioral validation phase comes after scrutiny", () => {
      const tracker = new MilestoneTracker();
      const phases = tracker.createValidationPhases("auth", 0);

      expect(phases.length).toBe(2);
      expect(phases[0].title).toBe("Scrutiny: auth");
      expect(phases[1].title).toBe("Validation: auth");
    });
  });

  // VAL-EXEC-009: Validation phases have correct metadata
  describe("VAL-EXEC-009: validation phase metadata", () => {
    it("scrutiny phase has descriptive name with milestone", () => {
      const tracker = new MilestoneTracker();
      const phases = tracker.createValidationPhases("checkout-flow", 5);

      expect(phases[0].title).toBe("Scrutiny: checkout-flow");
    });

    it("behavioral phase has descriptive name with milestone", () => {
      const tracker = new MilestoneTracker();
      const phases = tracker.createValidationPhases("checkout-flow", 5);

      expect(phases[1].title).toBe("Validation: checkout-flow");
    });

    it("phases have appropriate descriptions", () => {
      const tracker = new MilestoneTracker();
      const phases = tracker.createValidationPhases("auth", 0);

      expect(phases[0].description).toContain("Scrutiny validation");
      expect(phases[0].description).toContain("auth");
      expect(phases[1].description).toContain("Behavioral validation");
      expect(phases[1].description).toContain("auth");
    });

    it("phases have step checklists", () => {
      const tracker = new MilestoneTracker();
      const phases = tracker.createValidationPhases("auth", 0);

      expect(phases[0].steps!.length).toBeGreaterThan(0);
      expect(phases[1].steps!.length).toBeGreaterThan(0);
    });

    it("phases are assigned sequential indices from startIndex", () => {
      const tracker = new MilestoneTracker();
      const phases = tracker.createValidationPhases("auth", 10);

      expect(phases[0].index).toBe(10);
      expect(phases[1].index).toBe(11);
    });
  });

  // VAL-EXEC-008: Skip flags bypass validation
  describe("VAL-EXEC-008: skip flags", () => {
    it("skip_scrutiny prevents scrutiny phase injection", () => {
      const tracker = new MilestoneTracker();
      const phases = tracker.createValidationPhases("auth", 0, { skipScrutiny: true });

      expect(phases.length).toBe(1);
      expect(phases[0].title).toBe("Validation: auth");
    });

    it("skip_validation prevents behavioral validation phase injection", () => {
      const tracker = new MilestoneTracker();
      const phases = tracker.createValidationPhases("auth", 0, { skipValidation: true });

      expect(phases.length).toBe(1);
      expect(phases[0].title).toBe("Scrutiny: auth");
    });

    it("both skip flags prevent all validation phase injection", () => {
      const tracker = new MilestoneTracker();
      const phases = tracker.createValidationPhases("auth", 0, {
        skipScrutiny: true,
        skipValidation: true,
      });

      expect(phases.length).toBe(0);
    });

    it("skip flags are independent — can skip one but not the other", () => {
      const tracker = new MilestoneTracker();

      // Skip only scrutiny
      const phases1 = tracker.createValidationPhases("M1", 0, { skipScrutiny: true, skipValidation: false });
      expect(phases1.length).toBe(1);
      expect(phases1[0].title).toBe("Validation: M1");

      // Skip only validation
      const tracker2 = new MilestoneTracker();
      const phases2 = tracker2.createValidationPhases("M2", 0, { skipScrutiny: false, skipValidation: true });
      expect(phases2.length).toBe(1);
      expect(phases2[0].title).toBe("Scrutiny: M2");
    });
  });

  // VAL-EXEC-012: Injection preserves phase ordering
  describe("VAL-EXEC-012: injection preserves ordering", () => {
    it("checkAndCreateValidationPhases returns phases in correct order", () => {
      const milestonePhases: MilestonePhase[] = [
        createPhase({ index: 0, milestone: "M1", status: "completed" }),
        createPhase({ index: 1, milestone: "M1", status: "completed" }),
        createPhase({ index: 2, milestone: "M2", status: "pending" }),
      ];

      const tracker = new MilestoneTracker();
      const injections = tracker.checkAndCreateValidationPhases(milestonePhases, 3);

      expect(injections.length).toBe(1);
      expect(injections[0].milestone).toBe("M1");
      expect(injections[0].phases[0].title).toBe("Scrutiny: M1");
      expect(injections[0].phases[1].title).toBe("Validation: M1");
    });

    it("multiple milestones produce independent injections", () => {
      const milestonePhases: MilestonePhase[] = [
        createPhase({ index: 0, milestone: "M1", status: "completed" }),
        createPhase({ index: 1, milestone: "M2", status: "completed" }),
      ];

      const tracker = new MilestoneTracker();
      const injections = tracker.checkAndCreateValidationPhases(milestonePhases, 2);

      expect(injections.length).toBe(2);
      expect(injections[0].milestone).toBe("M1");
      expect(injections[1].milestone).toBe("M2");
    });
  });

  // VAL-MILE-007 (reinforced): Sealed milestones do not trigger duplicate injection
  describe("sealed milestones do not trigger duplicate injection", () => {
    it("checkAndCreateValidationPhases seals milestones after injection", () => {
      const milestonePhases: MilestonePhase[] = [
        createPhase({ index: 0, milestone: "M1", status: "completed" }),
      ];

      const tracker = new MilestoneTracker();
      const firstInjection = tracker.checkAndCreateValidationPhases(milestonePhases, 1);
      expect(firstInjection.length).toBe(1);

      // Second call should return empty — M1 is sealed
      const secondInjection = tracker.checkAndCreateValidationPhases(milestonePhases, 3);
      expect(secondInjection.length).toBe(0);
    });

    it("sealed milestone with both skipped still prevents re-injection", () => {
      const milestonePhases: MilestonePhase[] = [
        createPhase({ index: 0, milestone: "M1", status: "completed" }),
      ];

      const tracker = new MilestoneTracker();
      const injection = tracker.checkAndCreateValidationPhases(milestonePhases, 1, {
        skipScrutiny: true,
        skipValidation: true,
      });
      // Both skipped — no phases, but milestone is still sealed
      expect(injection.length).toBe(0);
      expect(tracker.hasValidationPlanned("M1")).toBe(true);

      // Subsequent call returns nothing
      const secondInjection = tracker.checkAndCreateValidationPhases(milestonePhases, 1);
      expect(secondInjection.length).toBe(0);
    });
  });

  // VAL-CROSS-007: Skip flags propagate through entire chain
  describe("VAL-CROSS-007: skip flags propagation", () => {
    it("skip_scrutiny prevents scrutiny injection but allows behavioral", () => {
      const milestonePhases: MilestonePhase[] = [
        createPhase({ index: 0, milestone: "M1", status: "completed" }),
      ];

      const tracker = new MilestoneTracker();
      const injections = tracker.checkAndCreateValidationPhases(milestonePhases, 1, {
        skipScrutiny: true,
      });

      expect(injections.length).toBe(1);
      expect(injections[0].phases.length).toBe(1);
      expect(injections[0].phases[0].title).toBe("Validation: M1");
    });

    it("skip_validation prevents behavioral injection but allows scrutiny", () => {
      const milestonePhases: MilestonePhase[] = [
        createPhase({ index: 0, milestone: "M1", status: "completed" }),
      ];

      const tracker = new MilestoneTracker();
      const injections = tracker.checkAndCreateValidationPhases(milestonePhases, 1, {
        skipValidation: true,
      });

      expect(injections.length).toBe(1);
      expect(injections[0].phases.length).toBe(1);
      expect(injections[0].phases[0].title).toBe("Scrutiny: M1");
    });

    it("both skipped marks milestone as sealed with no phases", () => {
      const milestonePhases: MilestonePhase[] = [
        createPhase({ index: 0, milestone: "M1", status: "completed" }),
      ];

      const tracker = new MilestoneTracker();
      const injections = tracker.checkAndCreateValidationPhases(milestonePhases, 1, {
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

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
